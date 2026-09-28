/**
 * Pair base and head captures and decide what each pair means.
 *
 *   regressed   head fails to load, returns >= 400, or logs errors base didn't
 *   changed     both load cleanly and the pixels differ past the threshold
 *   unchanged   both load cleanly and look the same
 *   fixed       base was broken and head is not
 *   unavailable both sides broken — nothing to compare
 *
 * "New errors" are compared by message with the preview origin and token
 * stripped, because base and head are served from different hosts.
 */
import type { Capture } from "./capture.js"
import type { DiffResult } from "./diff.js"
import { normalizeMessage } from "./urls.js"

export type Verdict = "regressed" | "changed" | "unchanged" | "fixed" | "unavailable"

export const VERDICT_ORDER: Verdict[] = ["regressed", "changed", "fixed", "unavailable", "unchanged"]

export interface Pair {
  route: string
  viewport: string
  base: Capture
  head: Capture
  diff?: Omit<DiffResult, "png">
  newErrors: string[]
  verdict: Verdict
  reason: string
}

export function loadFailure(c: Capture): string | undefined {
  if (c.navError) return c.navError
  if (c.status === null) return "no response"
  if (c.status >= 400) return `HTTP ${c.status}`
  return undefined
}

function errorsOf(c: Capture, origins: string[]): string[] {
  return [
    ...c.pageErrors.map((e) => `uncaught: ${e}`),
    ...c.consoleErrors.map((e) => `console: ${e}`),
    ...c.failedRequests.map((e) => `request: ${e}`),
  ].map((e) => normalizeMessage(e, origins))
}

export function newErrors(base: Capture, head: Capture): string[] {
  const origins = [base.url, head.url].map((u) => new URL(u).origin)
  const seen = new Set(errorsOf(base, origins))
  return [...new Set(errorsOf(head, origins))].filter((e) => !seen.has(e))
}

export function judge(
  base: Capture,
  head: Capture,
  diff: Omit<DiffResult, "png"> | undefined,
  threshold: number,
): Pick<Pair, "verdict" | "reason" | "newErrors"> {
  const baseFail = loadFailure(base)
  const headFail = loadFailure(head)
  if (headFail && baseFail) {
    return { verdict: "unavailable", reason: `base: ${baseFail}; head: ${headFail}`, newErrors: [] }
  }
  if (headFail) return { verdict: "regressed", reason: headFail, newErrors: [] }
  if (baseFail) return { verdict: "fixed", reason: `base: ${baseFail}`, newErrors: [] }

  const added = newErrors(base, head)
  if (added.length > 0) {
    const n = added.length
    return { verdict: "regressed", reason: `${n} new error${n === 1 ? "" : "s"}`, newErrors: added }
  }
  if (diff && diff.ratio > threshold) {
    const pct = (diff.ratio * 100).toFixed(2)
    const size = diff.resized ? ", page size changed" : ""
    const where = diff.firstChangedY !== null ? `, first change at y=${diff.firstChangedY}px` : ""
    return { verdict: "changed", reason: `${pct}% of pixels${size}${where}`, newErrors: [] }
  }
  return { verdict: "unchanged", reason: diff ? `${(diff.ratio * 100).toFixed(3)}% of pixels` : "", newErrors: [] }
}

export function pairKey(route: string, viewport: string): string {
  return `${viewport} ${route}`
}

export function sortPairs<P extends Pair>(pairs: P[]): P[] {
  return [...pairs].sort(
    (a, b) =>
      VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) ||
      (b.diff?.ratio ?? 0) - (a.diff?.ratio ?? 0) ||
      a.route.localeCompare(b.route) ||
      a.viewport.localeCompare(b.viewport),
  )
}
