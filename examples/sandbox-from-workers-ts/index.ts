/**
 * A Solari sandbox owned by a Cloudflare Durable Object.
 *
 * A Worker can't spawn processes, so code it wants to run has to go somewhere
 * else. Here each named workspace is a Durable Object, and each Durable Object
 * keeps one Solari sandbox: the first command creates it, later commands reuse
 * it, and the id lives in the object's storage so it survives the object being
 * evicted from memory.
 *
 *     POST   /<workspace>/run      {"cmd": "...", "env": {...}}  → JSON result
 *     POST   /<workspace>/stream   {"cmd": "..."}                → output as it happens
 *     DELETE /<workspace>                                         → kill the sandbox
 *
 * Unlike the browser SDK, `@solarisdk/sdk` runs on Workers as-is: it speaks
 * HTTPS plus one WebSocket, and uses the runtime's own `WebSocket`. It needs
 * one thing passed in — see `client()` below.
 */
import { DurableObject } from "cloudflare:workers"
import { ConcurrencyLimitError, ConnectionError, SolariClient } from "@solarisdk/sdk"

type Env = {
  SOLARI_API_KEY: string
  WORKSPACE: DurableObjectNamespace<Workspace>
}

type Sandbox = Awaited<ReturnType<SolariClient["sandboxes"]["create"]>>

/** Refusals the caller should see as HTTP errors rather than a 500. */
type Refused = { refused: string; status: number }

type RunResult = {
  stdout: string
  stderr: string
  exitCode: number
  sandboxId: string
  /** True when an existing sandbox answered; false when this call created one. */
  reused: boolean
  attachMs: number
  runMs: number
}

export class Workspace extends DurableObject<Env> {
  /** Live handle. In memory only: an evicted object comes back without it. */
  private sandbox?: Sandbox

  private client() {
    return new SolariClient({
      apiKey: this.env.SOLARI_API_KEY,
      // Without this, the first call fails with "Illegal invocation: function
      // called with incorrect `this` reference". The SDK keeps `fetch` on an
      // object and calls it as a method, and Workers only allow the global
      // `fetch` to be called unbound. A wrapper makes it an ordinary function.
      fetch: (input, init) => fetch(input, init),
    })
  }

  /**
   * The workspace's sandbox, reattached or created.
   *
   * A stored id is a hint, not a guarantee: the sandbox may have hit its idle
   * timeout since. Neither the lookup nor `connect()` tells you: for a killed
   * sandbox both succeed — the gateway can go on reporting it `running` — and
   * the channel only closes on the first real call. So a reattach is proven
   * with a no-op command before anything that matters is sent.
   */
  private async attach(name: string): Promise<{ sandbox: Sandbox; reused: boolean; ms: number }> {
    const t = Date.now()
    if (this.sandbox?.connected) return { sandbox: this.sandbox, reused: true, ms: 0 }

    const client = this.client()
    const storedId = await this.ctx.storage.get<string>("sandboxId")
    if (storedId) {
      try {
        const sandbox = await client.sandboxes.connect(storedId)
        await sandbox.connect()
        await sandbox.commands.run("true")
        this.sandbox = sandbox
        return { sandbox, reused: true, ms: Date.now() - t }
      } catch {
        // Gone (idle timeout, or killed elsewhere). Make a new one.
        await this.ctx.storage.delete("sandboxId")
      }
    }

    const sandbox = await client.sandboxes.create({
      template: "base",
      // A rolling window, reset by every command: an active workspace keeps its
      // sandbox, an abandoned one stops billing ten minutes after its last use.
      idleTimeoutMs: 10 * 60_000,
      metadata: { workspace: name },
    })
    await sandbox.connect()
    await this.ctx.storage.put("sandboxId", sandbox.id)
    this.sandbox = sandbox
    return { sandbox, reused: false, ms: Date.now() - t }
  }

  async run(name: string, cmd: string, env: Record<string, string> = {}): Promise<RunResult | Refused> {
    try {
      return await this.runOnce(name, cmd, env)
    } catch (err) {
      if (err instanceof ConcurrencyLimitError) return refusedByPlan(err)
      if (!(err instanceof ConnectionError) || !this.sandbox) throw err
      // The handle we held went stale: the sandbox was killed or timed out
      // while this object still had it in memory, and `connected` only notices
      // once a call fails. Reattach and see what's there.
      const stale = this.sandbox.id
      this.sandbox.close()
      this.sandbox = undefined
      const { sandbox } = await this.attach(name)
      // Same sandbox still alive: the command may have reached it before the
      // channel dropped, so running it again could run it twice. Say so.
      if (sandbox.id === stale) throw err
      // A different one: everything the command could have done died with the
      // old machine, so running it on the new one is safe.
      return await this.runOnce(name, cmd, env)
    }
  }

  private async runOnce(name: string, cmd: string, env: Record<string, string>): Promise<RunResult> {
    const { sandbox, reused, ms } = await this.attach(name)
    const t = Date.now()
    // Commands are exec'd, not shell-interpreted: `run("ls -la")` looks for a
    // binary called "ls -la". Go through `sh -c` for anything with a space.
    //
    // Secrets go in `env`, never in the command string. The command line is
    // visible to every process in the VM; the environment is not.
    const r = await sandbox.commands.run("sh", {
      args: ["-c", cmd],
      env,
      cwd: "/root",
      timeoutMs: 5 * 60_000,
    })
    return { ...r, sandboxId: sandbox.id, reused, attachMs: ms, runMs: Date.now() - t }
  }

  /**
   * Run a command and hand back its output as it is produced.
   *
   * The command runs in the background of this object's request; the stream
   * returned over RPC is the reading end. `onStdout`/`onStderr` fire per chunk,
   * so a build that takes minutes shows progress instead of silence.
   */
  async stream(name: string, cmd: string): Promise<ReadableStream<Uint8Array> | Refused> {
    let sandbox: Sandbox
    try {
      ;({ sandbox } = await this.attach(name))
    } catch (err) {
      if (err instanceof ConcurrencyLimitError) return refusedByPlan(err)
      throw err
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const enc = new TextEncoder()
    const write = (s: string) => void writer.write(enc.encode(s)).catch(() => {})

    this.ctx.waitUntil(
      sandbox.commands
        .run("sh", {
          args: ["-c", cmd],
          cwd: "/root",
          timeoutMs: 5 * 60_000,
          onStdout: write,
          onStderr: write,
        })
        .then(
          (r) => write(`\n[exit ${r.exitCode}]\n`),
          (e: Error) => write(`\n[error ${e.message}]\n`),
        )
        .finally(() => writer.close().catch(() => {})),
    )
    return readable
  }

  async reset(): Promise<{ killed: string | null }> {
    const id = this.sandbox?.id ?? (await this.ctx.storage.get<string>("sandboxId")) ?? null
    if (id) await this.client().sandboxes.kill(id)
    this.sandbox?.close()
    this.sandbox = undefined
    await this.ctx.storage.delete("sandboxId")
    return { killed: id }
  }
}

/**
 * Plans cap concurrent sandboxes (one, on the free tier), and a workspace
 * beyond the cap is refused with a 429. Hand that back as data: an error
 * thrown across the Durable Object RPC boundary loses its class, so the Worker
 * couldn't tell it from a crash.
 */
function refusedByPlan(err: ConcurrencyLimitError): Refused {
  return {
    status: 429,
    refused:
      `${err.message}. Your plan's sandboxes are all in use by other workspaces: ` +
      `DELETE one, or wait for its idle timeout.`,
  }
}

const isRefused = (x: unknown): x is Refused => typeof x === "object" && x !== null && "refused" in x

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const [name, action] = new URL(request.url).pathname.split("/").filter(Boolean)
    if (!name) return new Response("usage: POST /<workspace>/run {\"cmd\": \"...\"}\n", { status: 400 })
    // One Durable Object per workspace name, anywhere in the world.
    const workspace = env.WORKSPACE.get(env.WORKSPACE.idFromName(name))

    if (request.method === "DELETE") return Response.json(await workspace.reset())

    const body = (await request.json().catch(() => ({}))) as { cmd?: string; env?: Record<string, string> }
    if (!body.cmd) return new Response('body must be {"cmd": "..."}\n', { status: 400 })

    const result = action === "stream" ? await workspace.stream(name, body.cmd) : await workspace.run(name, body.cmd, body.env)
    if (isRefused(result)) return Response.json({ error: result.refused }, { status: result.status })
    if (result instanceof ReadableStream) {
      return new Response(result, { headers: { "content-type": "text/plain; charset=utf-8" } })
    }
    return Response.json(result)
  },
} satisfies ExportedHandler<Env>
