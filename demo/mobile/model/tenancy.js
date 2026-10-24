/**
 * The core's multi-tenant permission model, parsed from /v2/auth/me `grants`
 * (same rules as ui/lib/tenancy.ts):
 *
 *   - wire format: comma list of `<tenant>:<bits>`, `*` first when present,
 *     e.g. "*:rwxivo,otel-demo:rwx". Bits r w x i v o.
 *   - admin = `*` holds all six bits. Never inferred from `role`.
 *   - an o-only tenant is listed by /v2/agent/tenants but every read 403s,
 *     so the switcher only offers tenants the caller can READ.
 *
 * UI affordances only — the server re-checks every request.
 */

const ALL_BITS = "rwxivo"

export function parseGrants(raw) {
  const byTenant = {}
  if (typeof raw === "string") {
    for (const part of raw.split(",")) {
      const i = part.lastIndexOf(":")
      if (i <= 0) continue
      const t = part.slice(0, i).trim()
      const bits = part.slice(i + 1).trim()
      if (t) byTenant[t] = (byTenant[t] ?? "") + bits
    }
  }
  const star = byTenant["*"] ?? ""
  return { byTenant, admin: [...ALL_BITS].every(b => star.includes(b)) }
}

export function can(g, tenant, bit) {
  if ((g.byTenant["*"] ?? "").includes(bit)) return true
  return !!tenant && (g.byTenant[tenant] ?? "").includes(bit)
}

export function readableTenants(g, listed) {
  return listed.filter(t => can(g, t, "r"))
}

/**
 * Which tenant to scope to. The remembered one wins while it is still
 * readable; if it vanished from the caller's list it is dropped ONCE
 * (`forget` true) and the server's default is used — the core fails closed
 * on an unknown tenant, so keeping a revoked id would hang the app.
 */
export function chooseTenant(
  remembered,
  readable,
  serverDefault,
) {
  const r = remembered.trim()
  if (r && readable.includes(r)) return { tenant: r, forget: false }
  const forget = !!r
  if (serverDefault && readable.includes(serverDefault)) return { tenant: serverDefault, forget }
  return { tenant: readable[0] ?? null, forget }
}

/**
 * A tenant's display name (core ADR-090): a registry core keys tenants by an
 * opaque ID and names them in /v2/agent/tenants `labels` and /v2/auth/me
 * `tenantLabels`. A core keyed by names sends none and the ID is the name.
 */
export function tenantLabel(labels, id) {
  return (id && labels && labels[id]) || id || ""
}
