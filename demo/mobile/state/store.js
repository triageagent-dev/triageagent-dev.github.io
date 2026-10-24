/**
 * The single store behind the phone, mirroring the design's state model
 * (design-handoff/README.md "State model"): route + history, filters, sheet,
 * goals, Pro flag, persisted config, the live snapshot and connection state.
 *
 * Derived numbers (ring fills, attainment, band) are NOT stored — screens
 * compute them per render from `snap` + `goals` via src/model.
 */
import { create } from "../lib/store.js"
import { ApiError, getJSON, signOut, signOutPage } from "../api/client.js"
import { fetchSnapshot } from "../api/snapshot.js"
import { mapFractal } from "../model/fractal.js"
import { chooseTenant, parseGrants, readableTenants, tenantLabel } from "../model/tenancy.js"
import { scopeSteps } from "../model/scope.js"
import { useVoice } from "../voice/voice.js"
import { loadCfg, loadOwnGoals, loadPro, saveCfg, saveOwnGoals, savePro } from "./persist.js"
import { resolveGoals } from "../../tui/rings.js"
import { BASE_PATH, setUIVersion } from "../lib/ui-version.js"

// Screen: "home" | "detail" | "goals" | "issues" | "issue" | "stream" | "event"
//       | "predict" | "graph" | "svc" | "cost" | "secure" | "settings"
// Metric: "use" | "red" | "sig"
// SevFilter: "all" | "critical" | "warning" | "repeat"
// Conn: "idle" | "connecting" | "live" | "failed"
//
// View, one entry of the phone's navigation history:
//   { screen, metric?, zone?, evKey? (event group key, stable across polls,
//     unlike an index), incId?, svcName? }
// TenantRow: { id, events, issues, coverage } (numbers or null)
// FractalState: "loading" | { error } | Fractal | null

const POLL_MS = 30_000
const MAX_BACKOFF_MS = 300_000

let timer = null
let inflight = null

/** The goal fields of the store, from the viewer's own goals and the core's
 *  for the tenant (public/tui/rings.js resolveGoals). */
function goalState(own, core) {
  const { goals, source } = resolveGoals(own, core)
  return { ownGoals: own, goals, goalSource: source }
}

function schedule(fn, ms) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(fn, ms)
}

export const current = (s) => s.history[s.hi] ?? { screen: "home" }

export const useStore = create((set, get) => ({
  // session
  auth: "loading",
  authError: "",
  username: "",
  grants: { byTenant: {}, admin: false },
  // tenancy
  listed: [],
  readable: [],
  serverDefault: "",
  details: null,
  cfg: loadCfg(),
  tenant: null,
  // Home's scope, as the TUI's cluster and namespace filters ("" = all), the
  // core's health over it (kept with the scope it was fetched for), and the
  // sheet that picks it.
  cluster: "",
  ns: "",
  scoped: null,
  ssheet: false,
  // data
  snap: null,
  conn: "idle",
  connMsg: "",
  lastLiveAt: null,
  failures: 0,
  nextRetryAt: null,
  fractals: {},
  // navigation
  history: [{ screen: "home" }],
  hi: 0,
  // ui
  sevFilter: "all",
  tsheet: false,
  tq: "",
  period: "week",
  insightOff: false,
  graphMode: "service",
  incContextOpen: false,
  // ownGoals: what the viewer set here. goals: the ones in force (own, else
  // the tenant's from the core, else built-in); goalSource says which.
  ...goalState(loadOwnGoals(null), null),
  pro: loadPro(),

  set: p => set(p),

  async boot() {
    set({ auth: "loading", authError: "" })
    // The UI build's version, shipped in the bundle as version.txt.
    fetch(BASE_PATH + "/version.txt", { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((v) => setUIVersion(v.trim()))
      .catch(() => { /* offline: "dev" */ })
    let me
    try {
      me = await getJSON("/v2/auth/me")
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { set({ auth: "signedOut" }); return }
      set({ auth: "error", authError: e instanceof Error ? e.message : String(e) })
      return
    }
    // SSO off answers with no grants; the server then treats the caller as
    // admin, so the UI does too.
    const grants = me.grants === undefined ? parseGrants("*:rwxivo") : parseGrants(me.grants)
    set({ auth: "signedIn", username: me.username || "", grants })

    let tr = {}
    try {
      tr = await getJSON("/v2/agent/tenants")
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { set({ auth: "signedOut" }); return }
      // No registry: fall through with an empty list; the server picks.
      set({ connMsg: "tenant list unavailable: " + (e instanceof Error ? e.message : String(e)) })
    }
    const listed = tr.tenants ?? []
    // "default" is a stats bucket on some cores, never a tenant.
    const readable = listed.length ? readableTenants(grants, listed).filter(t => t !== "default") : []
    const { tenant, forget } = chooseTenant(get().cfg.tenant, readable, tr.default)
    if (forget) {
      const cfg = { ...get().cfg, tenant: "" }
      saveCfg(cfg)
      set({ cfg })
    }
    const labels = { ...(me.tenantLabels ?? {}), ...(tr.labels ?? {}) }
    set({ listed, readable, labels, serverDefault: tr.default ?? "", details: tr.details ?? null, tenant, ...goalState(loadOwnGoals(tenant), null) })
    if (!tenant) {
      set({ conn: "failed", connMsg: listed.length ? "You have no readable tenant on this server." : "The server listed no tenants." })
      return
    }
    await get().refresh()
  },

  async refresh() {
    const tenant = get().tenant
    if (!tenant || get().auth !== "signedIn") return
    inflight?.abort()
    const ac = new AbortController()
    inflight = ac
    set({ conn: get().snap ? get().conn : "connecting" })
    try {
      const snap = await fetchSnapshot(tenant, { unscopedEvents: get().readable.length === 1 }, ac.signal)
      if (ac.signal.aborted || get().tenant !== tenant) return
      set({ snap, conn: "live", connMsg: "", lastLiveAt: Date.now(), failures: 0, nextRetryAt: Date.now() + POLL_MS, ...goalState(get().ownGoals, snap.goals) })
      if (get().cluster || get().ns) void get().loadScopedHealth()
      schedule(() => void get().refresh(), POLL_MS)
    } catch (e) {
      if (e.name === "AbortError") return
      if (e instanceof ApiError && e.status === 401) {
        if (timer) clearTimeout(timer)
        set({ auth: "signedOut", snap: null, conn: "idle" })
        return
      }
      const failures = get().failures + 1
      const delay = Math.min(MAX_BACKOFF_MS, 15_000 * 2 ** (failures - 1))
      const msg = e instanceof ApiError
        ? (e.status === 400 || e.status === 403 ? `${tenant}: ${e.message}` : e.status ? `${e.status} · ${e.message}` : e.message)
        : String(e)
      set({ conn: "failed", connMsg: msg, failures, nextRetryAt: Date.now() + delay })
      schedule(() => void get().refresh(), delay)
    }
  },

  setTenant(id) {
    const cfg = { ...get().cfg, tenant: id }
    saveCfg(cfg)
    if (id === get().tenant) { set({ cfg, tsheet: false, tq: "" }); return }
    // Scoping changes every surface: drop the old tenant's snapshot so no
    // screen ever shows one tenant's numbers under another's name.
    set({ cfg, tenant: id, tsheet: false, tq: "", snap: null, cluster: "", ns: "", scoped: null, ssheet: false, fractals: {}, conn: "connecting", failures: 0, ...goalState(loadOwnGoals(id), null) })
    void get().refresh()
  },

  /** Home's scope steps through the whole tenant, each cluster and each namespace of a multi-namespace cluster; it wraps. */
  cycleScope(d) {
    const { snap, cluster, ns } = get()
    const steps = scopeSteps(snap?.apps?.applications)
    if (steps.length < 2) return
    const at = Math.max(0, steps.findIndex(s => s.cluster === cluster && s.ns === ns))
    const to = steps[(at + d + steps.length) % steps.length]
    get().setScope(to.cluster, to.ns)
  },

  /** Set Home's cluster and namespace ("" = all) and fetch the core's health over them. */
  setScope(cluster, ns) {
    set({ cluster, ns, scoped: null })
    void get().loadScopedHealth()
  },

  /** The core's health over the scope in view (GET /v2/tenants/{t}/health?cluster=&namespace=); null on any failure. */
  async loadScopedHealth() {
    const { tenant, cluster, ns } = get()
    if (!tenant || (!cluster && !ns)) return
    const key = [tenant, cluster, ns].join("|")
    const q = new URLSearchParams()
    if (cluster) q.set("cluster", cluster)
    if (ns) q.set("namespace", ns)
    let body = null
    try { body = await getJSON("/v2/tenants/" + encodeURIComponent(tenant) + "/health?" + q) } catch { /* the rings read unknown */ }
    const s = get()
    if ([s.tenant, s.cluster, s.ns].join("|") !== key) return
    set({ scoped: { key, body } })
  },

  navigate(v) {
    const { history, hi } = get()
    const cur = history[hi]
    if (cur && sameView(cur, v)) return
    const next = history.slice(0, hi + 1).concat(v).slice(-40)
    set({ history: next, hi: next.length - 1, incContextOpen: v.screen === "issue" ? false : get().incContextOpen })
    try { window.history.pushState({ hi: next.length - 1 }, "") } catch { /* ignore */ }
    if (v.screen === "issue" && v.incId) void get().loadFractal(v.incId)
  },

  back() {
    if (get().hi <= 0) return
    try { window.history.back() } catch { get().onPopState(get().hi - 1) }
  },

  forward() {
    if (get().hi >= get().history.length - 1) return
    try { window.history.forward() } catch { get().onPopState(get().hi + 1) }
  },

  onPopState(hi) {
    const n = get().history.length
    const i = Math.max(0, Math.min(n - 1, hi))
    set({ hi: i, tsheet: false })
    const v = get().history[i]
    if (v?.screen === "issue" && v.incId) void get().loadFractal(v.incId)
  },

  /** Set some goals as the viewer's own; the rest keep following the tenant's. */
  setGoals(patch) {
    const own = { ...get().ownGoals, ...patch }
    saveOwnGoals(get().tenant, own)
    set(goalState(own, get().snap?.goals))
  },
  /** Drop the viewer's own goals: the tenant's stand again. */
  resetGoals() { saveOwnGoals(get().tenant, {}); set(goalState({}, get().snap?.goals)) },

  togglePro() {
    const pro = !get().pro
    savePro(pro)
    set({ pro })
  },

  async loadFractal(id) {
    const tenant = get().tenant
    const cache = get().fractals
    if (cache[id] && cache[id] !== null && typeof cache[id] === "object" && !("error" in cache[id])) return
    set({ fractals: { ...cache, [id]: "loading" } })
    try {
      const path = "/v2/agent/issues/" + encodeURIComponent(id) + "/graph" + (tenant ? "?tenant=" + encodeURIComponent(tenant) : "")
      const g = await getJSON(path)
      set({ fractals: { ...get().fractals, [id]: mapFractal(g) } })
    } catch (e) {
      set({ fractals: { ...get().fractals, [id]: { error: e instanceof Error ? e.message : String(e) } } })
    }
  },

  async signOut() {
    if (window.TriageDemo) return
    if (timer) clearTimeout(timer)
    inflight?.abort()
    if (!(await signOut())) {
      // The cookie may still be valid: say so and send the browser through
      // the core's own logout page rather than pretending it worked.
      set({ connMsg: "Sign-out did not complete — opening the server's sign-out page." })
      signOutPage()
      return
    }
    // A shared phone must not keep the last user's tenant or grants.
    const cfg = { ...get().cfg, tenant: "" }
    saveCfg(cfg)
    set({
      auth: "signedOut", snap: null, conn: "idle", username: "", history: [{ screen: "home" }], hi: 0,
      cfg, tenant: null, grants: { byTenant: {}, admin: false }, listed: [], readable: [], serverDefault: "",
      details: null, fractals: {},
    })
  },
}))

// The voice session is bound to one signed-in user and one tenant: end it the
// moment either changes. This covers every path at once — explicit sign-out,
// a 401 from any poll (session expired), and the tenant switcher — so the mic
// can never keep streaming behind the sign-in screen or into another tenant.
useStore.subscribe((s, prev) => {
  const signedOut = prev.auth === "signedIn" && s.auth !== "signedIn"
  const retargeted = prev.tenant !== null && s.tenant !== prev.tenant
  if ((signedOut || retargeted) && useVoice.getState().open) useVoice.getState().close()
})

function sameView(a, b) {
  return a.screen === b.screen && a.metric === b.metric && (a.zone ?? null) === (b.zone ?? null) && (a.roomId ?? null) === (b.roomId ?? null)
    && a.evKey === b.evKey && a.incId === b.incId && a.svcName === b.svcName
}

/**
 * Tenant rows for the switcher: `details` when the core sends them (newer
 * cores), else status.tenantStats.tenants.<id>. Only readable tenants are
 * listed, so the stats key "default" never appears as a tenant.
 */
export function tenantRows(s) {
  const byId = new Map((s.details ?? []).map(d => [d.id, d]))
  const stats = s.snap?.status?.tenantStats?.tenants ?? {}
  return s.readable.filter(id => id !== "default").map(id => {
    const d = byId.get(id)
    const name = tenantLabel(s.labels, id)
    if (d) return { id, name, events: d.events ?? null, issues: d.issues ?? null, coverage: d.coveragePct ?? null }
    const r = stats[id]
    const e = r?.events
    return {
      id,
      name,
      events: e ? (e.noise ?? 0) + (e.unknown ?? 0) + (e.signal ?? 0) + (e.issue ?? 0) : null,
      issues: r?.issues?.opened ?? null,
      coverage: r?.coveragePct ?? null,
    }
  })
}

/** The display name of tenant id (core ADR-090), from the labels the core sent. */
export const useTenantName = (id) => useStore(s => tenantLabel(s.labels, id))
