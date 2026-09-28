/**
 * pr-visual-diff — build both sides of a pull request in Solari sandboxes,
 * screenshot every route × viewport in Solari cloud browsers, and diff them.
 *
 *   npm start -- --pr https://github.com/owner/repo/pull/12 --route / --route /about
 *   npm start -- --repo owner/repo --base main --head my-branch --route /
 *
 * Nothing runs on this machine except the orchestration: no Node build of the
 * target repo, no local Chromium.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { Solari } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"
import { buildBoth, release, StepError, type Built } from "./build.js"
import { captureAll, type Job, type Viewport } from "./capture.js"
import { judge, pairKey } from "./compare.js"
import { diffPngs } from "./diff.js"
import { resolvePr } from "./github.js"
import { counts, reportHtml, summaryText, type Files, type Report } from "./report.js"

const HELP = `pr-visual-diff — visual + error diff of a PR, built and browsed on Solari

Which code to compare (one of):
  --pr <url>                 GitHub PR URL (or a number, with --repo)
  --repo <owner/name|url> --base <ref> --head <ref>
                             any two refs: branches, tags, SHAs

What to look at:
  --route <path>             repeatable, or comma-separated        default /
  --viewport <name=WxH>      repeatable                            default mobile=390x844, desktop=1280x800
  --mask <css selector>      repeatable; painted over before the screenshot (clocks, ads)

How to build and serve it (run inside the sandbox, from the repo root):
  --setup <cmd>              run once before both sides install (shared tools)
  --install <cmd>            default: npm ci / npm install when there's a package.json
  --build <cmd>              default: npm run build when package.json has a build script
  --serve <cmd>              must listen on $PORT (base and head each get their own)
                             default: npx serve on the first of dist/ build/ out/ _site/ .
  --dir <path>               serve this directory with the default --serve
  --spa                      default --serve rewrites unknown paths to index.html
  --node <version>           install this Node first, e.g. 22 or 22.12.0 (the image has 20)

Knobs:
  --sessions <n>             concurrent browser sessions            default 3 (the free-plan cap)
  --pages <n>                concurrent pages per session           default 4
  --threshold <percent>      changed-pixel share that counts        default 0.1
  --settle <ms>              extra wait after load                  default 250
  --out <dir>                where to write the report              default ./out
  --fail-on-change           exit 1 on visual changes too, not only regressions

Exit status: 0 clean, 1 regressions (or changes with --fail-on-change), 2 setup failure.
Needs SOLARI_API_KEY in the environment.`

function fail(msg: string, code = 2): never {
  console.error(`error: ${msg}`)
  process.exit(code)
}

export function parseViewport(spec: string): Viewport {
  const m = spec.match(/^(?:([\w-]+)=)?(\d+)x(\d+)$/)
  if (!m) throw new Error(`--viewport wants name=WIDTHxHEIGHT, e.g. tablet=820x1180 (got "${spec}")`)
  const width = Number(m[2])
  const height = Number(m[3])
  return { name: m[1] ?? `${width}x${height}`, width, height }
}

export function normalizeRepo(repo: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return `https://github.com/${repo.replace(/\.git$/, "")}.git`
  return repo
}

export function slug(route: string): string {
  const s = route.replace(/^\/+|\/+$/g, "").replace(/[^\w.-]+/g, "_")
  return s || "index"
}

// Installed once in the setup phase. Two `npx serve` launched at the same
// moment race to populate the same npx cache and one dies with ENOTEMPTY.
const SERVE_SETUP = "npm install --silent --no-audit --no-fund --prefix /opt/serve serve@14"

function defaultServe(dir: string | undefined, spa: boolean): string {
  const serve = `/opt/serve/node_modules/.bin/serve --no-clipboard --listen tcp://0.0.0.0:$PORT${spa ? " --single" : ""}`
  if (dir) return `exec ${serve} ${JSON.stringify(dir)}`
  return `for d in dist build out _site; do [ -d "$d" ] && exec ${serve} "$d"; done; exec ${serve} .`
}

const DEFAULT_INSTALL =
  "if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; " +
  "elif [ -f package.json ]; then npm install --no-audit --no-fund; fi"

const DEFAULT_BUILD =
  `if [ -f package.json ] && node -e "process.exit(require('./package.json').scripts?.build ? 0 : 1)"; ` +
  `then npm run build; fi`

async function main() {
  const { values: a } = parseArgs({
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      route: { type: "string", multiple: true },
      viewport: { type: "string", multiple: true },
      mask: { type: "string", multiple: true },
      install: { type: "string" },
      build: { type: "string" },
      serve: { type: "string" },
      dir: { type: "string" },
      spa: { type: "boolean", default: false },
      node: { type: "string" },
      setup: { type: "string" },
      sessions: { type: "string", default: "3" },
      pages: { type: "string", default: "4" },
      threshold: { type: "string", default: "0.1" },
      settle: { type: "string", default: "250" },
      out: { type: "string", default: "out" },
      "fail-on-change": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  if (a.help) {
    console.log(HELP)
    return 0
  }
  const apiKey = process.env.SOLARI_API_KEY
  if (!apiKey) fail("SOLARI_API_KEY is not set. Get a key at https://console.getsolari.com")

  // ---- what to compare
  let repo: string
  let baseRef: string
  let headRef: string
  let title: string
  let subtitle: string | undefined
  if (a.pr) {
    const pr = await resolvePr(a.pr, a.repo).catch((e: Error) => fail(e.message))
    repo = pr.repo
    baseRef = a.base ?? pr.baseSha
    headRef = a.head ?? pr.headRef
    title = `#${pr.number} ${pr.title}`
    subtitle = pr.url
  } else {
    if (!a.repo || !a.base || !a.head) fail("pass --pr, or --repo with --base and --head. See --help.")
    repo = normalizeRepo(a.repo)
    baseRef = a.base
    headRef = a.head
    title = `${a.base} → ${a.head}`
  }

  const routes = (a.route ?? ["/"]).flatMap((r) => r.split(",")).map((r) => r.trim()).filter(Boolean)
  let viewports: Viewport[]
  try {
    viewports = (a.viewport ?? ["mobile=390x844", "desktop=1280x800"]).map(parseViewport)
  } catch (e) {
    fail((e as Error).message)
  }
  const threshold = Number(a.threshold) / 100
  if (!Number.isFinite(threshold) || threshold < 0) fail(`--threshold wants a percentage, e.g. 0.1`)

  const t0 = performance.now()
  const startedAt = new Date().toISOString()
  const log = (msg: string) =>
    console.log(`${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${msg}`)

  console.log(`${title}\n  ${repo}\n  base ${baseRef}\n  head ${headRef}`)
  console.log(`  ${routes.length} route(s) × ${viewports.length} viewport(s) × 2 sides = ${routes.length * viewports.length * 2} pages\n`)

  const client = new SolariClient({ apiKey })
  const solari = new Solari({ apiKey })
  let sandbox: Built["sandbox"] | undefined
  let released = false
  const releaseSandbox = async () => {
    if (!sandbox || released) return
    released = true
    if (!(await release(client, sandbox))) {
      console.error(`warning: couldn't kill sandbox ${sandbox.id}; it stops at its 10-minute idle timeout`)
    }
  }
  const cleanup = async () => {
    await releaseSandbox()
    await solari.close().catch(() => {})
  }
  // Ctrl-C mid-build would otherwise leave the sandbox idling until its
  // timeout, billing the whole time.
  process.once("SIGINT", () => {
    console.error("\ninterrupted — killing the sandbox")
    void cleanup().then(() => process.exit(130))
  })

  try {
    // ---- build both sides
    const tb = performance.now()
    let built: Built
    try {
      built = await buildBoth(
        client,
        {
          repo,
          refs: { base: baseRef, head: headRef },
          install: a.install ?? DEFAULT_INSTALL,
          build: a.build ?? DEFAULT_BUILD,
          serve: a.serve ?? defaultServe(a.dir, a.spa),
          ports: { base: 3000, head: 3001 },
          node: a.node,
          setup: [a.setup, a.serve ? undefined : SERVE_SETUP].filter(Boolean).join(" && ") || undefined,
        },
        log,
        (s) => (sandbox = s),
      )
    } catch (err) {
      // Not `fail()`: process.exit would skip the `finally` that kills the
      // sandbox that *didn't* fail.
      if (!(err instanceof StepError)) throw err
      console.error(`error: ${err.message}`)
      return 2
    }
    const buildWallMs = Math.round(performance.now() - tb)
    const { base, head } = built.sides
    if (base.sha === head.sha) log(`warning: base and head are the same commit (${base.sha.slice(0, 7)})`)

    // ---- screenshot everything
    const jobs: Job[] = routes.flatMap((route) =>
      viewports.flatMap((viewport) => (["base", "head"] as const).map((side) => ({ side, route, viewport }))),
    )
    const sessions = Math.max(1, Math.min(Number(a.sessions), Math.ceil(jobs.length / Number(a.pages))))
    log(`capturing ${jobs.length} pages on up to ${sessions} browser session(s)`)
    const { captures, stats } = await captureAll(
      solari,
      jobs,
      { base: base.preview, head: head.preview },
      {
        sessions,
        pagesPerSession: Number(a.pages),
        mask: a.mask ?? [],
        settleMs: Number(a.settle),
        timeoutMs: 45_000,
      },
      log,
    )
    // Done with the servers; stop paying for them before the diffing.
    await releaseSandbox()

    // ---- diff and write
    const outDir = path.resolve(a.out, `${startedAt.replace(/[:.]/g, "-")}`)
    await mkdir(outDir, { recursive: true })
    const byKey = new Map<string, { base?: (typeof captures)[number]; head?: (typeof captures)[number] }>()
    for (const c of captures) {
      const k = pairKey(c.route, c.viewport.name)
      byKey.set(k, { ...byKey.get(k), [c.side]: c })
    }

    const pairs: Report["pairs"] = []
    for (const route of routes) {
      for (const vp of viewports) {
        const { base: b, head: h } = byKey.get(pairKey(route, vp.name)) ?? {}
        if (!b || !h) continue
        const stem = `${vp.name}__${slug(route)}`
        const files: Files = {}
        let diff
        if (b.png) await writeFile(path.join(outDir, (files.base = `${stem}__base.png`)), b.png)
        if (h.png) await writeFile(path.join(outDir, (files.head = `${stem}__head.png`)), h.png)
        if (b.png && h.png) {
          const { png, ...rest } = diffPngs(b.png, h.png)
          diff = rest
          await writeFile(path.join(outDir, (files.diff = `${stem}__diff.png`)), png)
        }
        pairs.push({ route, viewport: vp.name, base: b, head: h, diff, files, ...judge(b, h, diff, threshold) })
      }
    }

    const report: Report = {
      title,
      subtitle,
      repo,
      startedAt,
      threshold,
      sandbox: { id: built.sandbox.id, timings: built.timings },
      sides: [base, head].map(({ label, ref, sha, timings }) => ({ label, ref, sha, timings })),
      pairs,
      capture: { ...stats, sessions, pagesPerSession: Number(a.pages) },
      buildWallMs,
      totalMs: Math.round(performance.now() - t0),
    }
    await writeFile(path.join(outDir, "report.html"), reportHtml(report))
    await writeFile(
      path.join(outDir, "report.json"),
      JSON.stringify(report, (k, v) => (k === "png" ? undefined : v), 2),
    )

    console.log(summaryText(report))
    console.log(`  report: ${path.join(outDir, "report.html")}\n`)

    const c = counts(pairs)
    return c.regressed > 0 || (a["fail-on-change"] && c.changed > 0) ? 1 : 0
  } finally {
    await cleanup()
  }
}

// Only run when executed, so tests can import the helpers above.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.ts")) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err)
      process.exit(2)
    },
  )
}
