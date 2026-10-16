/**
 * Same-origin client for the core API. The session is the core's HttpOnly
 * cookie from GitHub SSO, so every call is credentials:"include" and carries
 * no token. Every tenant-addressable call takes ?tenant=<current>: each
 * surface is scoped to exactly one tenant and there is no aggregate mode.
 */

export class ApiError extends Error {
  constructor(status, path, message) {
    super(message)
    this.status = status
    this.path = path
  }
}

/** Human message for a failed call — 400/403 are the server's own words. */
function describe(status, body, fallback) {
  if (body && typeof body === "object") {
    const b = body
    const d = typeof b.detail === "string" ? b.detail : typeof b.error === "string" ? b.error : ""
    if (d) return d
    if (typeof b.title === "string") return `${status} ${b.title}`
  }
  if (status === 403) return "not permitted for this tenant"
  if (status === 401) return "signed out"
  return fallback
}

export function withTenant(path, tenant) {
  if (!tenant) return path
  return path + (path.includes("?") ? "&" : "?") + "tenant=" + encodeURIComponent(tenant)
}

export async function getJSON(path, signal) {
  let res
  try {
    res = await fetch(path, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal,
    })
  } catch (e) {
    if (e.name === "AbortError") throw e
    throw new ApiError(0, path, "network unreachable")
  }
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // An HTML answer (gateway error page, SPA fallback) is not the API.
    if (res.ok) throw new ApiError(res.status, path, "answered with something other than JSON")
  }
  if (!res.ok) throw new ApiError(res.status, path, describe(res.status, body, `${res.status} ${res.statusText}`.trim()))
  return body
}

/** Sign-in is a full navigation, root-relative, NOT under the app's base path.
 *  The core completes login by redirecting to `/`, which lands in this UI
 *  (under BASE_PATH) — never the retired standalone /mui app. */
export const SIGN_IN_URL = "/v2/auth/github"

/**
 * Sign out: the core's /v2/auth/logout expires the session cookie and
 * redirects to /login. Fetching it with redirect:"manual" applies the
 * Set-Cookie without leaving the app. Returns whether the session is really
 * gone — /v2/auth/me answering 401 — so a failed logout on a shared phone is
 * never shown as signed out while the cookie still works.
 */
export async function signOut() {
  try {
    await fetch("/v2/auth/logout", { credentials: "include", redirect: "manual" })
    const me = await fetch("/v2/auth/me", { credentials: "include", cache: "no-store" })
    return me.status === 401
  } catch {
    return false
  }
}
