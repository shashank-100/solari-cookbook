/**
 * Turning a sandbox preview URL into a URL for one route.
 *
 * `sandbox.previewUrl(port)` returns something like
 *
 *   https://<id>-3000.preview.getsolari.com?pt_token=...
 *
 * The token is what authorises the request. The preview proxy answers the
 * first request that carries it with a `__pt_preview` cookie, and after that
 * the same browser can navigate token-free. A *fresh* browser has no cookie,
 * so a bare `https://<id>-3000.preview.getsolari.com/about/` is a 401.
 *
 * Every capture in this tool runs in its own fresh browser context, so every
 * URL carries the token. Building the URL with string concatenation gets this
 * wrong in both directions: `url + "/about"` puts the path after the query
 * string, and dropping the query loses the token.
 */
export interface Preview {
  url: string
  token?: string
}

export function routeUrl(preview: Preview, route: string): string {
  const base = new URL(preview.url)
  const token = preview.token ?? base.searchParams.get("pt_token") ?? undefined
  // Resolve against the origin, not the preview URL itself, so the preview's
  // own query string never leaks into the route.
  const url = new URL(route.startsWith("/") ? route : `/${route}`, base.origin)
  if (token) url.searchParams.set("pt_token", token)
  return url.toString()
}

/**
 * The same URL with the token removed — for anything that gets printed or
 * written to the report. The token grants access to the running sandbox.
 */
export function redact(url: string): string {
  try {
    const u = new URL(url)
    if (u.searchParams.has("pt_token")) u.searchParams.set("pt_token", "redacted")
    return u.toString()
  } catch {
    return url
  }
}

/**
 * Base and head are served from different preview hosts, so an error message
 * mentioning `https://aaa-3000.preview…/app.js` on one side and
 * `https://bbb-3000.preview…/app.js` on the other is the same error. Strip the
 * origin and the token before comparing.
 */
export function normalizeMessage(message: string, origins: string[]): string {
  let out = message
  for (const origin of origins) out = out.split(origin).join("")
  return out.replace(/([?&])pt_token=[^&\s"')]+/g, "$1pt_token=redacted").trim()
}
