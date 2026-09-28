/**
 * Resolve a GitHub pull request to the two refs to build.
 *
 * Head is fetched as `pull/<n>/head`, which exists on the base repo even when
 * the PR comes from a fork — so one clone URL serves both sides. Base is the
 * SHA the PR currently targets.
 *
 * Unauthenticated: GitHub allows 60 of these an hour per IP, which is plenty
 * for a CLI. Private repos are out of scope; the sandbox clones anonymously.
 */
export interface ResolvedPr {
  repo: string
  number: number
  title: string
  url: string
  baseRef: string
  baseSha: string
  headRef: string
}

/** Accepts `https://github.com/o/r/pull/12`, or `o/r` plus a number. */
export function parsePrArg(pr: string, repo?: string): { owner: string; name: string; number: number } {
  const m = pr.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (m) return { owner: m[1], name: m[2], number: Number(m[3]) }
  const r = repo?.match(/(?:github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  if (r && /^\d+$/.test(pr)) return { owner: r[1], name: r[2], number: Number(pr) }
  throw new Error(`--pr wants a GitHub PR URL, or a number together with --repo owner/name (got "${pr}")`)
}

export async function resolvePr(pr: string, repo?: string): Promise<ResolvedPr> {
  const { owner, name, number } = parsePrArg(pr, repo)
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls/${number}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "solari-pr-visual-diff" },
  })
  if (!res.ok) {
    throw new Error(`GitHub: ${owner}/${name}#${number} → HTTP ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as {
    title: string
    html_url: string
    base: { ref: string; sha: string }
  }
  return {
    repo: `https://github.com/${owner}/${name}.git`,
    number,
    title: body.title,
    url: body.html_url,
    baseRef: body.base.ref,
    baseSha: body.base.sha,
    headRef: `pull/${number}/head`,
  }
}
