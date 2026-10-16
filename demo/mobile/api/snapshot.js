/**
 * One poll of the core for ONE tenant. Endpoints are fetched in parallel and a
 * partial failure is reported, not hidden: whatever answered is shown, and
 * Settings lists what did not.
 */
import { ApiError, getJSON, withTenant } from "./client.js"

const PATHS = {
  status: t => withTenant("/v2/agent/status", t),
  issues: t => withTenant("/v2/agent/issues", t),
  apps: t => withTenant("/v2/agent/applications", t),
  events: (t, o) => withTenant("/v2/agent/events/recent?limit=100", o.unscopedEvents ? null : t),
  graph: t => withTenant("/v2/agent/graph", t),
  memSummary: t => withTenant("/v2/memory/summary?perKind=40", t),
  analytics: t => withTenant("/v2/agent/analytics", t),
  memMetrics: t => withTenant("/v2/memory/metrics", t),
  situation: t => `/v2/tenants/${encodeURIComponent(t)}/situation`,
  health: t => `/v2/tenants/${encodeURIComponent(t)}/health`,
  ledger: t => `/v2/tenants/${encodeURIComponent(t)}/ledger`,
  goals: t => `/v2/tenants/${encodeURIComponent(t)}/goals`,
  awareness: t => withTenant("/v2/agent/awareness/memory", t),
}

/** Keys whose failure is not reported: the endpoint is newer than some cores. */
const OPTIONAL = ["health", "ledger", "goals"]

export const SNAPSHOT_PATHS = PATHS

export async function fetchSnapshot(tenant, opts = {}, signal) {
  const keys = Object.keys(PATHS)
  const settled = await Promise.allSettled(keys.map(k => getJSON(PATHS[k](tenant, opts), signal)))
  const snap = {
    tenant, status: null, issues: null, apps: null, events: null, graph: null,
    memSummary: null, analytics: null, memMetrics: null, situation: null, health: null, ledger: null, goals: null, awareness: null,
    failed: [], fetchedAt: Date.now(),
  }
  settled.forEach((r, i) => {
    const k = keys[i]
    if (r.status === "fulfilled") snap[k] = r.value
    else {
      const e = r.reason
      if (e instanceof Error && e.name === "AbortError") throw e
      if (OPTIONAL.includes(k) && !(e instanceof ApiError && e.status === 401)) return
      const status = e instanceof ApiError ? e.status : 0
      snap.failed.push({ key: k, status, message: e instanceof Error ? e.message : String(e) })
    }
  })
  // A 401 anywhere means the session is gone; let the caller send the user
  // to sign-in rather than render a half-empty app.
  const unauth = snap.failed.find(f => f.status === 401)
  if (unauth) throw new ApiError(401, unauth.key, "signed out")
  // Nothing core answered: the tenant is unknown (400), forbidden (403) or
  // the server is down. Surface the server's own words.
  if (!snap.status && !snap.issues && !snap.apps) {
    const f = snap.failed.find(x => x.key === "issues") ?? snap.failed[0]
    throw new ApiError(f?.status ?? 0, f?.key ?? "status", f?.message ?? "no response")
  }
  return snap
}
