import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeRepo, parseViewport, slug } from "../src/cli.js"
import { parsePrArg } from "../src/github.js"

test("parseViewport accepts named and bare sizes", () => {
  assert.deepEqual(parseViewport("tablet=820x1180"), { name: "tablet", width: 820, height: 1180 })
  assert.deepEqual(parseViewport("1440x900"), { name: "1440x900", width: 1440, height: 900 })
  assert.throws(() => parseViewport("wide"), /name=WIDTHxHEIGHT/)
})

test("normalizeRepo expands owner/name and leaves URLs alone", () => {
  assert.equal(normalizeRepo("vercel/next.js"), "https://github.com/vercel/next.js.git")
  assert.equal(normalizeRepo("https://gitlab.com/a/b.git"), "https://gitlab.com/a/b.git")
})

test("slug makes a file-safe name per route", () => {
  assert.equal(slug("/"), "index")
  assert.equal(slug("/docs/getting-started/"), "docs_getting-started")
  assert.equal(slug("/search?q=a b"), "search_q_a_b")
})

test("parsePrArg reads URLs and number + repo", () => {
  assert.deepEqual(parsePrArg("https://github.com/o/r/pull/42"), { owner: "o", name: "r", number: 42 })
  assert.deepEqual(parsePrArg("42", "o/r"), { owner: "o", name: "r", number: 42 })
  assert.deepEqual(parsePrArg("7", "https://github.com/o/r.git"), { owner: "o", name: "r", number: 7 })
  assert.throws(() => parsePrArg("42"), /--pr wants/)
})
