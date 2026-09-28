/**
 * Screenshot every (side × route × viewport) across a small pool of cloud
 * browsers.
 *
 * Parallelism happens at two levels:
 *
 *   - `sessions` browser sessions run at once. Plans cap concurrent sessions
 *     (3 on the free tier), and a launch over the cap is a 429
 *     `ConcurrencyLimitExceeded`, so this is a knob, not "one per job".
 *   - Inside each session, `pagesPerSession` captures run concurrently, each
 *     in its own browser context. A context is cheap, gets its own viewport,
 *     and starts with no cookies — which is exactly why every URL has to carry
 *     the preview token (see urls.ts).
 *
 * All jobs sit in one shared queue, so a session that draws fast pages simply
 * takes more of them.
 */
import { Solari } from "@solarisdk/browser"
import { drain, isConcurrencyLimit, retrying } from "./pool.js"
import { redact, routeUrl, type Preview } from "./urls.js"

export interface Viewport {
  name: string
  width: number
  height: number
}

export interface Job {
  side: "base" | "head"
  route: string
  viewport: Viewport
}

export interface Capture extends Job {
  url: string
  status: number | null
  /** Navigation threw (timeout, DNS, connection refused). */
  navError?: string
  consoleErrors: string[]
  pageErrors: string[]
  /** Same-origin requests that failed or came back >= 400. */
  failedRequests: string[]
  png?: Buffer
  ms: number
}

export interface CaptureOptions {
  sessions: number
  pagesPerSession: number
  /** CSS selectors to paint over before the screenshot (clocks, ads, avatars). */
  mask: string[]
  /** Extra settle time after load, for pages that animate in. */
  settleMs: number
  timeoutMs: number
}

export interface CaptureStats {
  wallMs: number
  /** Sum of every capture's own duration — the cost of doing them one by one. */
  serialMs: number
  launches: { sessionId: string; ms: number }[]
  /** Launches that hit the concurrency cap and had to wait. */
  concurrencyRetries: number
}

// Deterministic screenshots: stop animations and transitions, hide the caret.
const FREEZE_CSS = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`

async function captureOne(
  browser: Awaited<ReturnType<Solari["launch"]>>,
  job: Job,
  preview: Preview,
  opts: CaptureOptions,
): Promise<Capture> {
  const t = performance.now()
  const url = routeUrl(preview, job.route)
  const origin = new URL(url).origin
  const out: Capture = {
    ...job,
    url: redact(url),
    status: null,
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    ms: 0,
  }

  const context = await browser.newContext({
    viewport: { width: job.viewport.width, height: job.viewport.height },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  })
  try {
    const page = await context.newPage()
    page.on("console", (m) => {
      if (m.type() === "error") out.consoleErrors.push(m.text())
    })
    page.on("pageerror", (e) => out.pageErrors.push(e.message))
    page.on("requestfailed", (r) => {
      if (r.url().startsWith(origin)) {
        out.failedRequests.push(`${r.failure()?.errorText ?? "failed"} ${redact(r.url())}`)
      }
    })
    page.on("response", (r) => {
      // The document's own status is reported separately.
      if (r.status() >= 400 && r.url().startsWith(origin) && !r.request().isNavigationRequest()) {
        out.failedRequests.push(`${r.status()} ${redact(r.url())}`)
      }
    })

    try {
      const res = await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs })
      out.status = res?.status() ?? null
    } catch (err) {
      out.navError = (err as Error).message.split("\n")[0]
      return out
    }
    // networkidle never arrives on pages that poll or hold a socket open;
    // treat it as a best-effort settle, not a requirement.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {})
    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {})
    await page.evaluate(() => document.fonts?.ready).catch(() => {})
    if (opts.settleMs > 0) await page.waitForTimeout(opts.settleMs)

    out.png = await page.screenshot({
      fullPage: true,
      animations: "disabled",
      mask: opts.mask.map((s) => page.locator(s)),
      maskColor: "#ff00ff",
    })
    return out
  } finally {
    out.ms = Math.round(performance.now() - t)
    await context.close().catch(() => {})
  }
}

export async function captureAll(
  solari: Solari,
  jobs: Job[],
  previews: Record<Job["side"], Preview>,
  opts: CaptureOptions,
  log: (msg: string) => void,
): Promise<{ captures: Capture[]; stats: CaptureStats }> {
  const queue = [...jobs]
  const captures: Capture[] = []
  const stats: CaptureStats = { wallMs: 0, serialMs: 0, launches: [], concurrencyRetries: 0 }
  const t0 = performance.now()
  let done = 0

  const session = async () => {
    // Nothing left by the time this session would start: don't hold a slot.
    if (queue.length === 0) return
    const t = performance.now()
    const browser = await retrying(
      () => solari.launch(),
      (err) => {
        if (!isConcurrencyLimit(err)) return false
        stats.concurrencyRetries++
        return true
      },
    )
    stats.launches.push({ sessionId: browser.id, ms: Math.round(performance.now() - t) })
    try {
      await drain(queue, opts.pagesPerSession, async (job) => {
        const c = await captureOne(browser, job, previews[job.side], opts)
        captures.push(c)
        done++
        const mark = c.navError ? "✗" : c.status && c.status >= 400 ? "!" : "·"
        log(
          `  ${mark} [${String(done).padStart(String(jobs.length).length)}/${jobs.length}] ` +
            `${job.side.padEnd(4)} ${job.viewport.name.padEnd(8)} ${job.route}  ` +
            `${c.status ?? c.navError ?? "?"}  ${c.ms}ms`,
        )
      })
    } finally {
      // Releases the session too. Without this the slot stays held until the
      // plan deadline and the next launch hits the concurrency cap.
      await browser.close()
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, opts.sessions) }, session))
  stats.wallMs = Math.round(performance.now() - t0)
  stats.serialMs = captures.reduce((sum, c) => sum + c.ms, 0)
  return { captures, stats }
}
