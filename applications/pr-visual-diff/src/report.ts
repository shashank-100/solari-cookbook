/**
 * The report: `report.html` next to the screenshots it shows, `report.json`
 * for CI, and a plain-text summary for the terminal.
 *
 * Every number in the timing section is measured by this process. Nothing is
 * quoted from a benchmark.
 */
import type { CaptureStats } from "./capture.js"
import { sortPairs, type Pair, type Verdict } from "./compare.js"

export interface SideInfo {
  label: string
  ref: string
  sha: string
  /** install / build / serve, run concurrently with the other side. */
  timings: Record<string, number>
}

export interface Files {
  base?: string
  head?: string
  diff?: string
}

export interface Report {
  title: string
  subtitle?: string
  repo: string
  startedAt: string
  threshold: number
  /** The one sandbox both sides share: create / connect / fetch. */
  sandbox: { id: string; timings: Record<string, number> }
  sides: SideInfo[]
  pairs: (Pair & { files: Files })[]
  capture: CaptureStats & { sessions: number; pagesPerSession: number }
  buildWallMs: number
  totalMs: number
}

export function counts(pairs: Pair[]): Record<Verdict, number> {
  const c: Record<Verdict, number> = { regressed: 0, changed: 0, fixed: 0, unavailable: 0, unchanged: 0 }
  for (const p of pairs) c[p.verdict]++
  return c
}

const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`

const phases = (t: Record<string, number>) =>
  Object.entries(t)
    .map(([k, v]) => `${k} ${s(v)}`)
    .join(" · ")

const esc = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!)

export function summaryText(r: Report): string {
  const c = counts(r.pairs)
  const lines = [
    "",
    `${r.title}`,
    ...(r.subtitle ? [r.subtitle] : []),
    "",
    ...sortPairs(r.pairs)
      .filter((p) => p.verdict !== "unchanged")
      .map((p) => `  ${p.verdict.toUpperCase().padEnd(11)} ${p.viewport.padEnd(8)} ${p.route}  — ${p.reason}`),
    "",
    `  ${c.regressed} regressed · ${c.changed} changed · ${c.fixed} fixed · ` +
      `${c.unavailable} unavailable · ${c.unchanged} unchanged  (${r.pairs.length} route×viewport pairs)`,
    "",
    "  timing (measured by this run)",
    `    sandbox ${phases(r.sandbox.timings)}`,
    ...r.sides.map((side) => `    ${side.label.padEnd(7)} ${phases(side.timings)}`),
    `    build phase wall ${s(r.buildWallMs)} (base and head built side by side in one sandbox)`,
    `    capture: ${r.pairs.length * 2} pages on ${r.capture.launches.length} browser session(s) × ${r.capture.pagesPerSession} pages each`,
    `      wall ${s(r.capture.wallMs)} vs ${s(r.capture.serialMs)} one at a time ` +
      `(${(r.capture.serialMs / Math.max(1, r.capture.wallMs)).toFixed(1)}×)`,
    `      browser launch ${r.capture.launches.map((l) => s(l.ms)).join(", ") || "—"}` +
      (r.capture.concurrencyRetries ? `  (${r.capture.concurrencyRetries} retries on the concurrency cap)` : ""),
    `    total ${s(r.totalMs)}`,
    "",
  ]
  return lines.join("\n")
}

function img(src: string | undefined, label: string, focusY: number | null | undefined): string {
  if (!src) return `<figure class="missing"><figcaption>${label}</figcaption><div>no screenshot</div></figure>`
  // Each shot scrolls in its own box; on load, boxes jump to the first change.
  const y = focusY ? ` data-y="${focusY}"` : ""
  return `<figure><figcaption>${label}</figcaption><div class="box"${y}><a href="${esc(src)}"><img src="${esc(src)}" alt="${label}"></a></div></figure>`
}

function pairHtml(p: Pair & { files: Files }): string {
  const errors = p.newErrors.length
    ? `<ul class="errors">${p.newErrors.map((e) => `<li><code>${esc(e)}</code></li>`).join("")}</ul>`
    : ""
  const body = `
      ${errors}
      <div class="shots">${(["base", "head", "diff"] as const).map((k) => img(p.files[k], k, p.diff?.firstChangedY)).join("")}</div>`
  const head = `<span class="badge ${p.verdict}">${p.verdict}</span>
      <span class="route">${esc(p.route)}</span>
      <span class="vp">${esc(p.viewport)}</span>
      <span class="reason">${esc(p.reason)}</span>`
  // Unchanged pairs are collapsed: they're the evidence, not the news.
  return p.verdict === "unchanged"
    ? `<details class="pair"><summary>${head}</summary>${body}</details>`
    : `<section class="pair"><header>${head}</header>${body}</section>`
}

export function reportHtml(r: Report): string {
  const c = counts(r.pairs)
  const sideRows = r.sides
    .map(
      (side) => `<tr><th>${side.label}</th><td><code>${esc(side.ref)}</code></td><td><code>${side.sha.slice(0, 7)}</code></td>
        ${["install", "build", "serve"].map((k) => `<td>${k in side.timings ? s(side.timings[k]) : "—"}</td>`).join("")}</tr>`,
    )
    .join("")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual diff report</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;
--regressed:#b91c1c;--changed:#b45309;--fixed:#15803d;--unavailable:#57534e;--unchanged:#a8a29e}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;
--regressed:#f87171;--changed:#fbbf24;--fixed:#4ade80;--unavailable:#d6d3d1;--unchanged:#78716c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:1280px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:24px;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 24px}
.tally{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}
.tally span{padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--card)}
.tally b{font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
.tablewrap{overflow-x:auto;margin-bottom:12px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.timing{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:32px}
.timing p{margin:4px 0;color:var(--muted);font-size:13px}
.timing p b{color:var(--fg)}
.pair{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:12px;padding:12px 16px}
.pair header,.pair summary{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;cursor:default}
.pair summary{cursor:pointer}
.badge{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--card);padding:2px 8px;border-radius:4px}
.badge.regressed{background:var(--regressed)}.badge.changed{background:var(--changed)}.badge.fixed{background:var(--fixed)}
.badge.unavailable{background:var(--unavailable)}.badge.unchanged{background:var(--unchanged)}
.route{font-family:ui-monospace,monospace;font-weight:600}
.vp,.reason{color:var(--muted);font-size:13px}
.errors{margin:10px 0 0;padding-left:20px;font-size:12px;color:var(--regressed)}
.errors code{word-break:break-all}
.shots{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px}
@media (max-width:720px){.shots{grid-template-columns:1fr}}
figure{margin:0}
figcaption{font-size:12px;color:var(--muted);margin-bottom:4px}
.box{max-height:640px;overflow:auto;border:1px solid var(--line);border-radius:6px;background:#fff}
figure img{display:block;width:100%}
.missing div{height:120px;display:grid;place-items:center;border:1px dashed var(--line);border-radius:6px;color:var(--muted);font-size:13px}
</style>
</head>
<body>
<main>
<h1>${esc(r.title)}</h1>
<p class="sub">${r.subtitle ? esc(r.subtitle) + " · " : ""}${esc(r.repo)} · ${esc(r.startedAt)} · threshold ${(r.threshold * 100).toFixed(2)}%</p>
<div class="tally">
  <span><b>${c.regressed}</b> regressed</span><span><b>${c.changed}</b> changed</span><span><b>${c.fixed}</b> fixed</span>
  <span><b>${c.unavailable}</b> unavailable</span><span><b>${c.unchanged}</b> unchanged</span>
</div>
<div class="timing">
  <div class="tablewrap"><table>
    <tr><th>side</th><th>ref</th><th>sha</th><th>install</th><th>build</th><th>serve</th></tr>
    ${sideRows}
  </table></div>
  <p>Sandbox: ${esc(phases(r.sandbox.timings))}. Build phase: <b>${s(r.buildWallMs)}</b> wall — base and head
     checked out as two worktrees in one sandbox and built side by side.</p>
  <p>Capture: <b>${r.pairs.length * 2}</b> pages on <b>${r.capture.launches.length}</b> browser session(s), ${r.capture.pagesPerSession} pages each —
     <b>${s(r.capture.wallMs)}</b> wall vs ${s(r.capture.serialMs)} one at a time.
     Launches: ${r.capture.launches.map((l) => s(l.ms)).join(", ") || "—"}.</p>
  <p>Total: <b>${s(r.totalMs)}</b>. All times measured by this run, from the machine that ran it.</p>
</div>
${sortPairs(r.pairs).map(pairHtml).join("\n")}
</main>
<script>
// Scroll each screenshot box so the first changed row sits near the top.
for (const box of document.querySelectorAll(".box[data-y]")) {
  const img = box.querySelector("img")
  const go = () => { box.scrollTop = Math.max(0, Number(box.dataset.y) * (img.clientWidth / img.naturalWidth) - 40) }
  const ready = () => (box.closest("details") ? box.closest("details").addEventListener("toggle", go) : go())
  img.complete ? ready() : img.addEventListener("load", ready)
}
</script>
</body>
</html>
`
}
