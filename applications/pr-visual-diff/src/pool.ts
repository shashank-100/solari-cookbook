/**
 * Small concurrency helpers. No dependency: the whole thing is a shared queue
 * and a retry loop.
 */

/** Pull items off a shared queue from `lanes` concurrent workers. */
export async function drain<T>(
  queue: T[],
  lanes: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const lane = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, lanes) }, lane))
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Retry `fn` while `shouldRetry(err)` says so, with capped exponential backoff.
 * Used for `ConcurrencyLimitExceeded`: the plan caps concurrent browser
 * sessions, and a launch that races another worker's release gets a 429 that
 * is gone a second later.
 */
export async function retrying<T>(
  fn: () => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  { attempts = 20, baseMs = 500, maxMs = 5_000, wait = sleep } = {},
): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= attempts || !shouldRetry(err)) throw err
      await wait(Math.min(maxMs, baseMs * 2 ** (i - 1)))
    }
  }
}

export function isConcurrencyLimit(err: unknown): boolean {
  const e = err as { code?: string; status?: number } | undefined
  return e?.code === "ConcurrencyLimitExceeded" || e?.status === 429
}
