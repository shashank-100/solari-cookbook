# Sandbox from a Cloudflare Worker (TypeScript)

Give each named workspace in a Worker its own Solari sandbox. A Durable Object
per workspace creates the sandbox on first use, keeps its id in storage, and
reuses it across requests. When the sandbox has gone away, it notices and makes
a new one.

A Worker can't spawn processes, so anything it wants to *run* (a build, a test,
an agent's shell command) has to live somewhere else. A Durable Object is the
natural owner: one per name, with its own storage, and it outlives any single
request.

Unlike `@solarisdk/browser` (see
[browser-workers-cdp-ts](../browser-workers-cdp-ts)), the sandbox SDK runs on
Workers unchanged. It speaks HTTPS plus one WebSocket, and uses the runtime's own
`WebSocket`. It needs one thing passed in.

## Run

```bash
cd examples/sandbox-from-workers-ts
npm install
cp .dev.vars.example .dev.vars       # then paste your key in
npm start                            # wrangler dev, on http://localhost:8787
```

```bash
$ curl -X POST localhost:8787/alice/run -d '{"cmd":"echo hi > note.txt; echo made"}'
{"exitCode":0,"stdout":"made\n","stderr":"","sandboxId":"AvZQ…","reused":false,"attachMs":1604,"runMs":329}

$ curl -X POST localhost:8787/alice/run -d '{"cmd":"cat note.txt"}'
{"exitCode":0,"stdout":"hi\n","stderr":"","sandboxId":"AvZQ…","reused":true,"attachMs":0,"runMs":319}

$ curl -N -X POST localhost:8787/alice/stream -d '{"cmd":"for i in 1 2 3; do echo tick $i; sleep 1; done"}'
tick 1            ← arrives at 0s
tick 2            ← 1s
tick 3            ← 2s
[exit 0]

$ curl -X POST localhost:8787/alice/run -d '{"cmd":"echo ${#TOKEN}","env":{"TOKEN":"s3cr3t-value"}}'
{"exitCode":0,"stdout":"12\n",…}

$ curl -X DELETE localhost:8787/alice
{"killed":"AvZQ…"}
```

`npm run deploy` puts it on your workers.dev subdomain. Set the key there with
`wrangler secret put SOLARI_API_KEY`.

## What bites

- **`Illegal invocation` on the first call.** The SDK keeps `fetch` on an
  object and calls it as a method, and Workers only allow the global `fetch` to
  be called unbound. Pass `fetch: (input, init) => fetch(input, init)` to
  `SolariClient`.
- **A stored sandbox id doesn't prove the sandbox is alive.** After an idle
  timeout or a kill, `sandboxes.connect(id)` and `sandbox.connect()` both still
  succeed. The gateway can go on reporting a killed sandbox as `running`. The
  channel only closes on the first real call, with `Control channel closed
  (1005)`. So a reattach runs a no-op `true` before anything that matters.
- **An in-memory handle goes stale the same way.** `sandbox.connected` stays
  `true` until a call fails. On a `ConnectionError` the object reattaches. If
  the *same* sandbox answers, the command may already have reached it, so the
  error is reported rather than the command run twice. If a *new* one answers,
  whatever the command did died with the old machine, so it runs there.
- **Plans cap concurrent sandboxes.** The free tier runs one. A second
  workspace gets a 429 `ConcurrencyLimitExceeded` until the first is deleted or
  idles out. Errors lose their class crossing the Durable Object RPC boundary,
  so the object hands the refusal back as data and the Worker turns it into a
  429, not a 500.
- **Commands are exec'd, not shell-interpreted.** `run("ls -la")` looks for a
  binary named `ls -la`. Go through `sh -c`.
- **Secrets go in `env`, not the command string.** A command line is readable
  by every process in the VM. The environment isn't.
- **`idleTimeoutMs` is a rolling window, not a lifetime.** Every command resets
  it, so an active workspace keeps its sandbox and an abandoned one stops
  billing ten minutes after its last use.

Source: [`index.ts`](index.ts)
