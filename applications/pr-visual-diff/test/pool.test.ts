import assert from "node:assert/strict"
import { test } from "node:test"
import { drain, isConcurrencyLimit, retrying } from "../src/pool.js"

test("drain never runs more than `lanes` at once, and runs everything", async () => {
  const queue = Array.from({ length: 20 }, (_, i) => i)
  let running = 0
  let peak = 0
  const seen: number[] = []
  await drain(queue, 4, async (n) => {
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, 2))
    seen.push(n)
    running--
  })
  assert.equal(peak, 4)
  assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i))
})

test("two drains on one queue share the work", async () => {
  const queue = Array.from({ length: 10 }, (_, i) => i)
  const a: number[] = []
  const b: number[] = []
  await Promise.all([drain(queue, 1, async (n) => void a.push(n)), drain(queue, 1, async (n) => void b.push(n))])
  assert.equal(a.length + b.length, 10)
  assert.ok(a.length > 0 && b.length > 0)
})

test("retrying retries only what shouldRetry allows", async () => {
  let calls = 0
  const cap = Object.assign(new Error("429"), { code: "ConcurrencyLimitExceeded" })
  const out = await retrying(
    async () => {
      if (++calls < 3) throw cap
      return "ok"
    },
    isConcurrencyLimit,
    { wait: async () => {} },
  )
  assert.equal(out, "ok")
  assert.equal(calls, 3)

  calls = 0
  await assert.rejects(
    retrying(
      async () => {
        calls++
        throw new Error("boom")
      },
      isConcurrencyLimit,
      { wait: async () => {} },
    ),
    /boom/,
  )
  assert.equal(calls, 1)
})

test("retrying gives up after `attempts`", async () => {
  let calls = 0
  await assert.rejects(
    retrying(
      async () => {
        calls++
        throw Object.assign(new Error("429"), { status: 429 })
      },
      isConcurrencyLimit,
      { attempts: 3, wait: async () => {} },
    ),
  )
  assert.equal(calls, 3)
})
