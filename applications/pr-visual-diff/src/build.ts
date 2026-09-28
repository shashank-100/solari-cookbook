/**
 * The build phase: one sandbox, two worktrees, two servers, two preview URLs.
 *
 * Base and head share one VM rather than getting one each. The free plan runs
 * a single sandbox at a time (a second `create` is a 429
 * `ConcurrencyLimitExceeded`, "hold 1 of 1 slot(s)"), and sharing is cheaper
 * anyway: one fetch brings down both commits, and `git worktree` checks each
 * out into its own directory over the same object store. After the fetch the
 * two sides install, build, and serve concurrently inside the VM.
 */
import type { SolariClient } from "@solarisdk/sdk"
import { sleep } from "./pool.js"
import type { Preview } from "./urls.js"

type Sandbox = Awaited<ReturnType<SolariClient["sandboxes"]["create"]>>

export type Side = "base" | "head"

export interface BuildSpec {
  /** Git remote the sandbox clones from. Must be public. */
  repo: string
  refs: Record<Side, string>
  install: string
  build: string
  /** Must listen on $PORT. */
  serve: string
  ports: Record<Side, number>
  /** Node version to install over the image's own (20.x), e.g. "22" or "22.12.0". */
  node?: string
  /** Runs once, before either side installs — shared tools go here. */
  setup?: string
}

export interface BuiltSide {
  label: Side
  ref: string
  sha: string
  preview: Preview
  /** Wall-clock ms per phase for this side, measured from this process. */
  timings: Record<string, number>
}

export interface Built {
  sandbox: Sandbox
  sides: Record<Side, BuiltSide>
  /** Phases the two sides share: create, connect, fetch. */
  timings: Record<string, number>
}

const REPO_DIR = "/work/repo"
const NODE_DIR = "/opt/node"
const dirOf = (side: Side) => `/work/${side}`

/** Put the installed Node (if any) first on PATH for a script. */
const withNode = (spec: BuildSpec, script: string) =>
  spec.node ? `export PATH=${NODE_DIR}/bin:$PATH; ${script}` : script

export class StepError extends Error {
  constructor(
    readonly label: string,
    readonly step: string,
    readonly output: string,
  ) {
    super(`[${label}] ${step} failed:\n${output}`)
  }
}

/** Last `lines` lines of combined output — enough to see a build error. */
function tail(text: string, lines = 30): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n")
}

function stopwatch(into: Record<string, number>) {
  return async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    const t = performance.now()
    try {
      return await fn()
    } finally {
      into[phase] = Math.round(performance.now() - t)
    }
  }
}

async function sh(
  sandbox: Sandbox,
  label: string,
  step: string,
  script: string,
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
): Promise<string> {
  // Sandbox commands are not shell-interpreted: `run("npm ci && npm run build")`
  // looks for a binary with that name. Go through `sh -c` explicitly.
  const res = await sandbox.commands.run("sh", { args: ["-c", script], ...opts })
  if (res.exitCode !== 0) {
    throw new StepError(label, step, tail(`${res.stdout}\n${res.stderr}`))
  }
  return res.stdout
}

/**
 * Fetch one ref into the shared repo and return its full SHA.
 *
 * `git fetch <ref>` rather than `git clone --branch`: clone only takes branch
 * and tag names, and a PR head (`pull/12/head`) or a full SHA is neither.
 * GitHub serves both to a shallow fetch. An abbreviated SHA is the one thing a
 * fetch can't resolve server-side, so that falls back to fetching every
 * branch and letting `rev-parse` expand it locally.
 */
async function fetchRef(sandbox: Sandbox, label: string, ref: string): Promise<string> {
  const out = await sh(
    sandbox,
    label,
    `fetch ${ref}`,
    `set -e; if git fetch -q --depth 1 origin "$REF" 2>/dev/null; then git rev-parse FETCH_HEAD; ` +
      `else git fetch -q origin '+refs/heads/*:refs/remotes/origin/*' && git rev-parse --verify "$REF^{commit}"; fi`,
    { cwd: REPO_DIR, env: { REF: ref }, timeoutMs: 5 * 60_000 },
  )
  return out.trim().split("\n").pop()!
}

/**
 * Install an official Node build into NODE_DIR. The base image ships Node 20,
 * and plenty of current projects refuse to build on it (Astro 7 wants 22.12+).
 * A major ("22") resolves to that line's latest release.
 */
async function installNode(sandbox: Sandbox, version: string): Promise<string> {
  const out = await sh(
    sandbox,
    "setup",
    `install node ${version}`,
    `set -e; case "$V" in ` +
      `*.*) T="v$V/node-v$V-linux-x64.tar.gz" ;; ` +
      `*) T="latest-v$V.x/$(curl -fsSL https://nodejs.org/dist/latest-v$V.x/SHASUMS256.txt | grep -o 'node-v[0-9.]*-linux-x64.tar.gz' | head -1)" ;; ` +
      `esac; mkdir -p ${NODE_DIR} && curl -fsSL "https://nodejs.org/dist/$T" | tar -xz -C ${NODE_DIR} --strip-components=1 && ` +
      `${NODE_DIR}/bin/node -v`,
    { env: { V: version }, timeoutMs: 5 * 60_000 },
  )
  return out.trim()
}

async function buildOne(
  sandbox: Sandbox,
  side: Side,
  sha: string,
  spec: BuildSpec,
  log: (msg: string) => void,
): Promise<BuiltSide> {
  const timings: Record<string, number> = {}
  const timed = stopwatch(timings)
  const cwd = dirOf(side)
  const port = spec.ports[side]
  const env = { PORT: String(port), CI: "1" }

  if (spec.install) {
    await timed("install", () => sh(sandbox, side, "install", withNode(spec, spec.install), { cwd, env, timeoutMs: 15 * 60_000 }))
    log(`${side}: install done (${timings.install}ms)`)
  }
  if (spec.build) {
    await timed("build", () => sh(sandbox, side, "build", withNode(spec, spec.build), { cwd, env, timeoutMs: 15 * 60_000 }))
    log(`${side}: build done (${timings.build}ms)`)
  }

  // `commands.run` waits for the process to exit, so a server in the
  // foreground would block until the idle timeout. Background it, and keep
  // its log so a server that dies on boot says why.
  const serveLog = `/tmp/serve-${side}.log`
  await timed("serve", async () => {
    await sh(sandbox, side, "serve", `nohup sh -c "$SERVE" > ${serveLog} 2>&1 &`, {
      cwd,
      env: { ...env, SERVE: withNode(spec, spec.serve) },
      timeoutMs: 30_000,
    })
    const ready = await sandbox.commands.run("sh", {
      args: [
        "-c",
        `for i in $(seq 1 120); do ` +
          `c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/); ` +
          `[ "$c" != "000" ] && exit 0; sleep 0.5; done; exit 1`,
      ],
      timeoutMs: 90_000,
    })
    if (ready.exitCode !== 0) {
      const out = await sandbox.files.readText(serveLog).catch(() => "")
      throw new StepError(side, `serve (nothing listening on :${port} after 60s)`, tail(out))
    }
  })

  const preview = await sandbox.previewUrl(port)
  log(`${side}: serving on :${port} (${timings.serve}ms)`)
  return { label: side, ref: spec.refs[side], sha, preview, timings }
}

export async function buildBoth(
  client: SolariClient,
  spec: BuildSpec,
  log: (msg: string) => void,
  onSandbox: (sandbox: Sandbox) => void,
): Promise<Built> {
  const timings: Record<string, number> = {}
  const timed = stopwatch(timings)

  const sandbox = await timed("create", () =>
    client.sandboxes.create({
      template: "base",
      // Rolling idle window, reset on every call. Only bites if this process
      // dies mid-run — and then it's what stops the bill.
      idleTimeoutMs: 10 * 60_000,
      metadata: { app: "pr-visual-diff" },
    }),
  )
  // Register before anything else can throw, so the caller can kill it.
  onSandbox(sandbox)
  await timed("connect", () => sandbox.connect())
  log(`sandbox up (create ${timings.create}ms, connect ${timings.connect}ms)`)

  // Toolchain (Node, then --setup) and the git fetch don't touch each other;
  // overlap them.
  const toolchain = timed("setup", async () => {
    if (spec.node) log(`node ${await installNode(sandbox, spec.node)} installed`)
    if (spec.setup) await sh(sandbox, "setup", "setup", withNode(spec, spec.setup), { timeoutMs: 10 * 60_000 })
  })
  // Awaited after the fetch; don't let a failure land as an unhandled rejection first.
  toolchain.catch(() => {})

  const shas = await timed("fetch", async () => {
    await sh(sandbox, "setup", "git init", `mkdir -p ${REPO_DIR} && cd ${REPO_DIR} && git init -q && git remote add origin "$REPO"`, {
      env: { REPO: spec.repo },
      timeoutMs: 30_000,
    })
    // Sequential: two fetches into one repo would fight over its lock files.
    const base = await fetchRef(sandbox, "base", spec.refs.base)
    const head = await fetchRef(sandbox, "head", spec.refs.head)
    for (const [side, sha] of [["base", base], ["head", head]] as const) {
      await sh(sandbox, side, "worktree", `git worktree add -q --detach ${dirOf(side)} ${sha}`, {
        cwd: REPO_DIR,
        timeoutMs: 60_000,
      })
    }
    return { base, head }
  })
  log(`fetched base @ ${shas.base.slice(0, 7)}, head @ ${shas.head.slice(0, 7)} (${timings.fetch}ms)`)
  await toolchain
  if (spec.node || spec.setup) log(`setup done (${timings.setup}ms)`)

  const [base, head] = await Promise.all(
    (["base", "head"] as const).map((side) => buildOne(sandbox, side, shas[side], spec, log)),
  )
  return { sandbox, sides: { base, head }, timings }
}

/**
 * Kill the sandbox, retrying once if the DELETE itself fails.
 *
 * Don't confirm the kill by polling `sandboxes.get()` or `list()`: both can
 * keep reporting a killed sandbox as `running` for a while (the machine is
 * gone — connecting to it says "Sandbox is not reachable", and it holds no
 * slot). Trust the DELETE.
 */
export async function release(client: SolariClient, sandbox: Sandbox): Promise<boolean> {
  try {
    await sandbox.kill()
    return true
  } catch {
    await sleep(1_000)
    return client.sandboxes.kill(sandbox.id).then(
      () => true,
      () => false,
    )
  }
}
