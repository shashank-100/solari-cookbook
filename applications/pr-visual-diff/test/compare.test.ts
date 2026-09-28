import assert from "node:assert/strict"
import { test } from "node:test"
import type { Capture } from "../src/capture.js"
import { judge, newErrors, sortPairs, type Pair } from "../src/compare.js"

const vp = { name: "mobile", width: 390, height: 844 }

function cap(side: "base" | "head", over: Partial<Capture> = {}): Capture {
  return {
    side,
    route: "/",
    viewport: vp,
    url: `https://${side}-3000.preview.getsolari.com/?pt_token=redacted`,
    status: 200,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    ms: 1,
    ...over,
  }
}

const noDiff = { width: 1, height: 1, changedPixels: 0, ratio: 0, resized: false, firstChangedY: null }

test("clean and identical is unchanged", () => {
  assert.equal(judge(cap("base"), cap("head"), noDiff, 0.001).verdict, "unchanged")
})

test("pixels past the threshold are a change", () => {
  const j = judge(cap("base"), cap("head"), { ...noDiff, ratio: 0.05, resized: true }, 0.001)
  assert.equal(j.verdict, "changed")
  assert.match(j.reason, /5\.00% .*size changed/)
})

test("pixels under the threshold are not", () => {
  assert.equal(judge(cap("base"), cap("head"), { ...noDiff, ratio: 0.0005 }, 0.001).verdict, "unchanged")
})

test("head returning an error status is a regression", () => {
  const j = judge(cap("base"), cap("head", { status: 500 }), undefined, 0.001)
  assert.equal(j.verdict, "regressed")
  assert.equal(j.reason, "HTTP 500")
})

test("head failing to navigate is a regression", () => {
  const j = judge(cap("base"), cap("head", { status: null, navError: "net::ERR_TIMED_OUT" }), undefined, 0.001)
  assert.equal(j.verdict, "regressed")
})

test("broken on both sides is unavailable, broken only on base is fixed", () => {
  assert.equal(judge(cap("base", { status: 404 }), cap("head", { status: 404 }), undefined, 0).verdict, "unavailable")
  assert.equal(judge(cap("base", { status: 404 }), cap("head"), undefined, 0).verdict, "fixed")
})

test("an error only head logs is a regression, even with identical pixels", () => {
  const j = judge(cap("base"), cap("head", { pageErrors: ["TypeError: x is undefined"] }), noDiff, 0.001)
  assert.equal(j.verdict, "regressed")
  assert.deepEqual(j.newErrors, ["uncaught: TypeError: x is undefined"])
})

test("the same error on both hosts is not new", () => {
  const base = cap("base", { failedRequests: ["404 https://base-3000.preview.getsolari.com/logo.svg?pt_token=redacted"] })
  const head = cap("head", { failedRequests: ["404 https://head-3000.preview.getsolari.com/logo.svg?pt_token=redacted"] })
  assert.deepEqual(newErrors(base, head), [])
})

test("sortPairs puts regressions first, then the biggest changes", () => {
  const mk = (verdict: Pair["verdict"], ratio: number, route: string): Pair => ({
    route,
    viewport: "mobile",
    base: cap("base"),
    head: cap("head"),
    diff: { ...noDiff, ratio },
    newErrors: [],
    verdict,
    reason: "",
  })
  const sorted = sortPairs([mk("unchanged", 0, "/a"), mk("changed", 0.01, "/b"), mk("changed", 0.2, "/c"), mk("regressed", 0, "/d")])
  assert.deepEqual(sorted.map((p) => p.route), ["/d", "/c", "/b", "/a"])
})
