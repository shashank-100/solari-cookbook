import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeMessage, redact, routeUrl } from "../src/urls.js"

const preview = {
  url: "https://abc-3000.preview.getsolari.com?pt_token=SECRET",
  token: "SECRET",
}

test("routeUrl puts the path before the token, not after it", () => {
  assert.equal(routeUrl(preview, "/about/"), "https://abc-3000.preview.getsolari.com/about/?pt_token=SECRET")
})

test("routeUrl keeps the route's own query string", () => {
  const u = new URL(routeUrl(preview, "/search?q=shoes"))
  assert.equal(u.pathname, "/search")
  assert.equal(u.searchParams.get("q"), "shoes")
  assert.equal(u.searchParams.get("pt_token"), "SECRET")
})

test("routeUrl accepts routes without a leading slash", () => {
  assert.equal(new URL(routeUrl(preview, "about")).pathname, "/about")
})

test("routeUrl reads the token from the URL when the field is missing", () => {
  const u = new URL(routeUrl({ url: preview.url }, "/"))
  assert.equal(u.searchParams.get("pt_token"), "SECRET")
})

test("redact hides the token", () => {
  const out = redact(routeUrl(preview, "/x"))
  assert.ok(!out.includes("SECRET"))
  assert.ok(out.includes("pt_token=redacted"))
})

test("normalizeMessage makes base and head errors comparable", () => {
  const a = normalizeMessage("Failed to load https://aaa-3000.preview.getsolari.com/app.js?pt_token=X1", [
    "https://aaa-3000.preview.getsolari.com",
  ])
  const b = normalizeMessage("Failed to load https://bbb-3001.preview.getsolari.com/app.js?pt_token=Y2", [
    "https://bbb-3001.preview.getsolari.com",
  ])
  assert.equal(a, b)
  assert.equal(a, "Failed to load /app.js?pt_token=redacted")
})
