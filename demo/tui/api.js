// Triage core (v3) API → view models for the Triage TUI web client.
//
// Adapted from design/triage-api.js. Differences from the design copy:
//   • same-origin only: every path is root-absolute, fetched with
//     credentials:"same-origin" (the SSO cookie);
//   • tenants are resolved FIRST, then every tenant-scoped call carries it
//     (an unscoped call on a multi-tenant server 400s — the CLI does the same);
//   • row shapes follow triagectl (core/internal/cli/ui) rather than the mock:
//     panel 2 is the graph ∪ applications union with tri-state readiness,
//     panel 3 events come from status.events.recent like the CLI's
//     recentEvents(), the matrix is the CLI status strip (clsf/llm/tnt; agnt moved to config);
//   • no synthetic numbers — anything the payload does not carry is null and
//     renders as an em dash.
//
// Wire keys are v2-era (`issues`, `issueMetrics`); v3 calls them
// concerns, so only user-facing text says "concern".

export const PATHS = {
  version: "/v2/version",
  me: "/v2/auth/me",
  tenants: "/v2/agent/tenants",
  status: "/v2/agent/status",
  apps: "/v2/agent/applications",
  graph: "/v2/agent/graph",
  analytics: "/v2/agent/analytics",
  issues: "/v2/agent/issues",
  events: "/v2/agent/events/recent?limit=100",
  // Full cells (content, confidence, links), unscoped — the CLI's own
  // memory feed (client/rest.go refetchMemory); tenant filtering is local.
  memory: "/v2/agent/awareness/memory",
  memSummary: "/v2/memory/summary?perKind=40",
  memMetrics: "/v2/memory/metrics",
};
// Which calls take ?tenant= (the rest are instance-wide, as the brief lists them).
const SCOPED = new Set(["apps", "graph", "analytics", "memSummary", "memMetrics"]);
const PHASE1 = ["tenants", "version", "me"];
const PHASE2 = ["status", "apps", "graph", "analytics", "issues", "events", "memory", "memSummary", "memMetrics"];

export class HttpError extends Error {
  constructor(path, status, statusText) {
    super(path + " → " + status + (statusText ? " " + statusText : ""));
    this.status = status;
    this.path = path;
  }
}

const withTenant = (p, tenant) =>
  tenant ? p + (p.includes("?") ? "&" : "?") + "tenant=" + encodeURIComponent(tenant) : p;

export function createClient() {
  const get = async (path) => {
    const res = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!res.ok) throw new HttpError(path, res.status, res.statusText);
    const ct = res.headers.get("content-type") || "";
    if (!/json/i.test(ct)) throw new HttpError(path, res.status, "non-JSON response (" + (ct || "no content-type") + ")");
    return res.json();
  };
  return { get };
}

// Pick the tenant the session scopes to: the caller's preference when the
// server lists it, else the server default, else the first tenant.
export function resolveTenant(tenantsRes, preferred) {
  const list = arr((tenantsRes || {}).tenants);
  if (preferred && list.includes(preferred)) return preferred;
  const def = (tenantsRes || {}).default || "";
  if (def && (list.includes(def) || !list.length)) return def;
  return list[0] || "";
}

// Live fetch. Throws an HttpError with status 401/403 when the session is not
// authorised (so the caller can offer sign-in); otherwise returns whatever
// settled plus the list of failed endpoints.
export async function fetchLive({ tenant: preferred } = {}) {
  const c = createClient();
  const raw = {}, failed = [];
  const run = async (keys, tenant) => {
    const settled = await Promise.allSettled(keys.map((k) => c.get(SCOPED.has(k) ? withTenant(PATHS[k], tenant) : PATHS[k])));
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") raw[keys[i]] = r.value;
      else failed.push({ key: keys[i], path: PATHS[keys[i]], status: r.reason && r.reason.status, error: String((r.reason && r.reason.message) || r.reason) });
    });
  };
  await run(PHASE1);
  const tf = failed.find((f) => f.key === "tenants");
  if (tf && (tf.status === 401 || tf.status === 403)) {
    const e = new HttpError(PATHS.tenants, tf.status, "unauthorised");
    e.raw = raw; e.failed = failed;
    throw e;
  }
  const tenant = resolveTenant(raw.tenants, preferred);
  await run(PHASE2, tenant);
  // Service ledger (core ADR-061): tenant in the path, so outside PHASE2. A
  // core without the route just leaves the section empty — not a failure
  // worth a banner.
  if (tenant) {
    try { raw.ledger = await c.get("/v2/tenants/" + encodeURIComponent(tenant) + "/ledger"); } catch (_) { /* older core */ }
    // Operator goals (the tenant_goals cell): the defaults the goals panel
    // starts from. An older core has no route; the built-ins stand.
    try { raw.goals = await c.get("/v2/tenants/" + encodeURIComponent(tenant) + "/goals"); } catch (_) { /* older core */ }
  }
  if (!raw.status && !raw.issues && !raw.apps) {
    const authFail = failed.find((f) => f.status === 401 || f.status === 403);
    const e = authFail ? new HttpError(authFail.path, authFail.status, "unauthorised") : new Error((failed[0] && failed[0].error) || "no response from core");
    e.raw = raw; e.failed = failed;
    throw e;
  }
  return { raw, failed, tenant };
}

// The tenant's infra health scored over one cluster and/or namespace
// (GET /v2/tenants/{t}/health?cluster=&namespace=). Null on any failure, so
// the infra rings read as unknown rather than as the tenant-wide score.
export async function fetchScopedHealth(tenant, cluster, ns) {
  const q = new URLSearchParams();
  if (cluster) q.set("cluster", cluster);
  if (ns) q.set("namespace", ns);
  try { return await createClient().get("/v2/tenants/" + encodeURIComponent(tenant) + "/health?" + q); } catch (_) { return null; }
}

// The memory feed alone (memory, memSummary), for a panel that keeps its
// memory counts live between the full reloads. A failed endpoint is left out.
export async function fetchMemory(tenant) {
  const c = createClient(), out = {};
  await Promise.all(["memory", "memSummary"].map(async (k) => {
    try { out[k] = await c.get(SCOPED.has(k) ? withTenant(PATHS[k], tenant) : PATHS[k]); } catch (_) { /* keep the last */ }
  }));
  return out;
}

// Any-method JSON call (the agent-join admin routes). A non-2xx answer throws
// an HttpError carrying the core's own {"error": "..."} text as coreMessage,
// so a 401/403 can be shown as the core phrased it.
export async function requestJSON(method, path, body) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method, credentials: "same-origin", headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) {
    const msg = (data && (data.error_description || data.error || data.message)) || text.trim().slice(0, 200) || res.statusText;
    const e = new HttpError(method + " " + path, res.status, msg);
    e.coreMessage = msg;
    throw e;
  }
  return data || {};
}

// ── formatting helpers (mirror core/internal/cli/ui/format.go) ─────────────
export const DASH = "—";
export const num = (v, d = 0) => (typeof v === "number" && isFinite(v) ? v : d);
export const arr = (v) => (Array.isArray(v) ? v : []);
const has = (v) => typeof v === "number" && isFinite(v);

export function formatCount(n) {
  if (!has(n)) return DASH;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.trunc(n));
}
export function formatDuration(totalSeconds) {
  if (!has(totalSeconds) || totalSeconds < 0) return DASH;
  const s = Math.trunc(totalSeconds);
  if (s < 60) return s + "s";
  const m = Math.trunc(s / 60), rs = s % 60;
  if (m < 60) return rs > 0 ? m + "m " + rs + "s" : m + "m";
  const h = Math.trunc(m / 60), rm = m % 60;
  if (h < 24) return rm > 0 ? h + "h " + rm + "m" : h + "h";
  const d = Math.trunc(h / 24), rh = h % 24;
  return rh > 0 ? d + "d " + rh + "h" : d + "d";
}
export function ago(iso, nowMs) {
  const t = new Date(iso).getTime();
  if (!iso || !isFinite(t) || t <= 0) return DASH;
  const s = Math.trunc((nowMs - t) / 1000);
  if (s < 0) return DASH;
  if (s < 60) return s + "s";
  const m = Math.trunc(s / 60);
  if (m < 60) return m + "m";
  const h = Math.trunc(m / 60);
  if (h < 24) return h + "h";
  return Math.trunc(h / 24) + "d";
}
export function fullTime(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d) || d.getTime() <= 0) return DASH;
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
export const wholePct = (v) => (has(v) ? Math.round(v) + "%" : DASH);
export const pctFrom01 = (v) => (has(v) ? Math.round(v * 100) + "%" : DASH);
export function coveragePctLabel(v) {
  if (!has(v)) return DASH;
  if (v >= 100) return "100%";
  if (v > 99) return (Math.floor(v * 10) / 10).toFixed(1) + "%";
  return Math.trunc(v) + "%";
}
export const snrLabel = (v) => (!has(v) ? DASH : v < 10 ? v.toFixed(1) + "%" : Math.round(v) + "%");
export const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();
const firstLine = (s) => String(s || "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) || "";

// Source paths are k8s/<cluster>/<kind>/<ns>/<name> (namespace at index 3)
// or app/<cluster>/<ns>/<service> (index 2) — the CLI's parseSourceKind.
// Any other source (reflection/<tenant>/<service> from the situation frame)
// names no cluster; an issue's summary may still quote the event it came
// from ("Source: app/<cluster>/<ns>/<service>"), and that is used.
export function parseSourceKind(source, summary) {
  const parts = String(source || "").split("/");
  const kind = parts[0] || "";
  const nsIdx = kind === "k8s" ? 3 : kind === "app" ? 2 : -1;
  if (nsIdx < 0) {
    const m = summary ? /^Source: ((?:k8s|app)\/\S+)/m.exec(String(summary)) : null;
    const q = m ? parseSourceKind(m[1]) : null;
    return { kind, cluster: q ? q.cluster : "", ns: q ? q.ns : "" };
  }
  return { kind, cluster: parts[1] || "", ns: parts[nsIdx] || "" };
}
// The CLI's eventGroupKey: a k8s/ source's trailing resource name is stripped
// so two pods failing the same way group into one row.
export function eventGroupKey(e) {
  const parts = String(e.source || "").split("/");
  const trimmed = parts[0] === "k8s" && parts.length > 2 ? parts.slice(0, -1).join("/") : String(e.source || "");
  return trimmed + "::" + (e.type || "");
}

// ── top-level mapping ──────────────────────────────────────────────────────
export function mapAll(raw, tenant, nowMs = Date.now()) {
  const st = raw.status || {};
  const registry = arr((raw.tenants || {}).tenants);
  const tsMap = (st.tenantStats || {}).tenants || {};
  const scope = registry.length ? tenant : "";
  const entry = (scope && tsMap[scope]) || null;
  const concernsAll = mapConcerns(raw.issues, nowMs);
  const concerns = scope ? concernsAll.filter((c) => c.tenant === scope) : concernsAll;
  const apps = mapApps(raw.apps, raw.graph, st, scope);
  const graph = mapGraph(raw.graph);
  return {
    tenant: scope || tenant || "",
    tenants: mapTenants(st, registry, (raw.tenants || {}).default || ""),
    coreVersion: (raw.version || {}).version || ((st.serverVersion || {}).version) || null,
    user: (raw.me || {}).username || null,
    role: (raw.me || {}).role || null,
    grants: (raw.me || {}).grants || null,
    running: st.running,
    namespace: st.namespace || null,
    statusText: statusText(raw.memory, st, scope),
    agents: mapAgents(st, scope, nowMs),
    apps,
    graph,
    concerns,
    events: mapEvents(raw.events, st, scope),
    activity: mapActivity(raw.analytics),
    predictions: mapPredictions(raw.analytics),
    patterns: arr((raw.analytics || {}).patterns),
    analyticsAt: (raw.analytics || {}).generatedAt || null,
    mem: mapMemory(raw.memory, raw.memSummary, raw.memMetrics, scope),
    ledger: mapLedger(raw.ledger),
    config: mapConfig(st),
    stats: mapStats(st),
    tenantCard: mapTenantCard(st, scope),
    scorecard: entry ? mapScorecard(entry) : [],
    policy: st.policy || null,
    generatedAt: (raw.analytics || {}).generatedAt || (st.worldState || {}).lastUpdated || null,
  };
}

// The CLI prints the mental-map status cell's content (statusstrip.go
// tenantStatusText): the exact id first, then any status cell tagged for the
// tenant; the world-state summary only when neither exists (the sibling
// UI shows) is the fallback.
function statusText(memory, st, scope) {
  const items = arr((memory || {}).items);
  const hit = (scope && items.find((it) => it.id === "mental-map-status-" + scope && it.content)) ||
    items.find((it) => String(it.id || "").startsWith("mental-map-status-") && it.content &&
      (!scope || arr(it.tags).includes("tenant/" + scope)));
  if (hit) return oneLine(hit.content);
  return oneLine((st.worldState || {}).summary || "");
}

// Cluster agents connected to the core (the CLI strip's agnt: row); the
// config page lists them, the header no longer does.
function mapAgents(st, scope, nowMs) {
  const agnt = [];
  const ca = st.clusterAgentStats;
  if (ca && ca.enabled) {
    const sessions = arr(ca.sessions);
    if (!sessions.length) agnt.push({ k: "no clusters connected", v: "", dim: true });
    else {
      // The core reports one row per (cluster, tenant): the agent's own
      // connection (the one with a version) and a stats-only row for each
      // other tenant it serves. One line per cluster agent, with its mode: the
      // core names a cluster-mode session (no single tenant) "*".
      const byCluster = new Map();
      sessions.forEach((s) => {
        const k = s.cluster || "?";
        byCluster.set(k, (byCluster.get(k) || []).concat(s));
      });
      const lines = [...byCluster].map(([cluster, rows]) => {
        const own = rows.find((s) => s.agentVersion) || rows.slice().sort((x, y) => new Date(x.connectedAt || 0) - new Date(y.connectedAt || 0))[0];
        return {
          mine: !scope || rows.some((s) => s.tenant === scope),
          k: cluster + ":",
          v: [own.agentVersion || null, own.connectedAt ? "up " + ago(own.connectedAt, nowMs) : null, rows.some((s) => s.tenant === "*" || !s.agentVersion) && !rows.some((s) => s.agentVersion && s.tenant !== "*") ? "cluster mode" : "tenant mode"].filter(Boolean).join(" · ") || DASH,
        };
      });
      const mine = lines.filter((l) => l.mine);
      if (scope && !mine.length) agnt.push({ k: "no " + scope + " clusters", v: "", dim: true });
      mine.forEach((l) => agnt.push({ k: l.k, v: l.v, tone: "ok", dim: false }));
      if (scope) lines.filter((l) => !l.mine).forEach((l) => agnt.push({ k: l.k, v: l.v, tone: undefined, dim: true }));
    }
  }
  return agnt;
}

// ── panel 2: applications ∪ graph (applications.go) ─────────────────────────
function mapGraph(g) {
  const nodes = arr((g || {}).nodes);
  const byName = new Map(nodes.map((n) => [n.name, n]));
  // CS/CBY/T's T: size of the CalledBy transitive closure (blast numerator).
  const closure = (name, next) => {
    const seen = new Set([name]), out = [], queue = [name];
    while (queue.length) {
      const n = byName.get(queue.shift());
      if (!n) continue;
      arr(next(n)).forEach((x) => { if (!seen.has(x)) { seen.add(x); out.push(x); queue.push(x); } });
    }
    return out;
  };
  return {
    loaded: !!g,
    nodes, byName,
    edges: arr((g || {}).edges),
    downstream: (name) => closure(name, (n) => n.calledBy),
    upstream: (name) => closure(name, (n) => n.calls),
    noiseThreshold: has((g || {}).noiseThreshold) ? g.noiseThreshold : null,
    issueThreshold: has((g || {}).issueThreshold) ? g.issueThreshold : null,
  };
}

// Service ledger rows (GET /v2/tenants/{t}/ledger): every event the core
// counted per service instance in the last 24h, by family. Keyed
// "service|cluster/namespace" (a single-cluster source has an empty
// cluster).
function mapLedger(res) {
  const rows = arr((res || {}).rows);
  const byKey = new Map(), byService = new Map();
  rows.forEach((r) => {
    byKey.set(r.service + "|" + (r.instance || ""), r);
    if (!byService.has(r.service)) byService.set(r.service, []);
    byService.get(r.service).push(r);
  });
  return { rows, byKey, byService, loaded: !!res };
}

// The severity band a blast radius puts a service in (core ADR-061): below
// the noise threshold info, below the issue threshold warning, else critical.
export function severityBand(blast, noiseT, issueT) {
  if (typeof blast !== "number" || noiseT == null || issueT == null) return null;
  if (blast >= issueT) return "critical";
  if (blast >= noiseT) return "warning";
  return "info";
}

function mapApps(appsRes, graphRes, st, scope) {
  const apps = arr((appsRes || {}).applications);
  const nodes = arr((graphRes || {}).nodes);
  const graph = mapGraph(graphRes);
  const reported = (a) => ({ ...rowOf(a), readyKnown: true, ready: a.ready === true });
  let rows = [];
  if (!graphRes) rows = apps.map(reported);
  else {
    const bySvc = new Map();
    apps.forEach((a) => { const k = a.serviceName; if (!bySvc.has(k)) bySvc.set(k, []); bySvc.get(k).push(a); });
    const matched = new Set();
    nodes.forEach((n) => {
      const rs = bySvc.get(n.name);
      if (rs) { rs.forEach((a) => rows.push(reported(a))); matched.add(n.name); return; }
      rows.push({ ...rowOf({ serviceName: n.name, componentsReady: DASH }), readyKnown: false, ready: false });
    });
    apps.forEach((a) => { if (!matched.has(a.serviceName)) rows.push(reported(a)); });
  }
  rows = rows.concat(driftRows(st, scope, rows));
  const T = new Map();
  rows.forEach((r, i) => {
    r.key = [r.name, r.cluster, r.ns, r.drift ? "drift" : "", i].join("|");
    const node = r.drift ? null : graph.byName.get(r.name) || null;
    r.node = node;
    if (node) {
      if (!T.has(node.name)) T.set(node.name, graph.downstream(node.name).length);
      r.blast = num(node.blastRadius, null);
      r.weight = num(node.weight, 1);
      r.cs = arr(node.calls).length + "/" + arr(node.calledBy).length + "/" + T.get(node.name);
    } else {
      r.blast = null; r.weight = 1;
      r.cs = r.drift ? "~" + num(r.driftCalls) : DASH;
    }
    r.state = r.drift ? "drift" : !r.readyKnown ? "unknown" : r.ready ? "ready" : "not-ready";
  });
  // Declared rows first, drift trailing; alphabetical within each group.
  rows.sort((a, b) => (a.drift !== b.drift ? (a.drift ? 1 : -1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const counts = { all: rows.length, ready: 0, notReady: 0, unknown: 0, drift: 0, virtual: 0 };
  rows.forEach((r) => {
    if (r.virtual) counts.virtual++;
    if (r.drift) counts.drift++;
    else if (!r.readyKnown) counts.unknown++;
    else if (r.ready) counts.ready++;
    else counts.notReady++;
  });
  return { rows, counts, loaded: !!appsRes || !!graphRes };
}
function rowOf(a) {
  return {
    name: a.serviceName || a.namespace || DASH,
    cluster: a.cluster || "",
    ns: a.namespace || "",
    version: a.version || "",
    comps: a.componentsReady || (arr(a.components).length ? String(arr(a.components).length) : DASH),
    components: arr(a.components),
    // Pod counts summed over the workloads that report them (core ADR-077);
    // "" when none does. An absent readyReplicas means none ready.
    replicas: Number(a.replicas) > 0 ? (Number(a.readyReplicas) || 0) + "/" + Number(a.replicas) : "",
    partial: a.partial === true,
    virtual: a.virtual === true,
    golden: a.golden || null,
    observedAt: a.observedAt || null,
    application: a.application || "",
    drift: false,
  };
}
function driftRows(st, scope, declared) {
  const gd = st.graphDrift;
  if (!gd || !gd.tenants) return [];
  const names = new Set(declared.map((r) => r.name));
  const streams = scope ? (gd.tenants[scope] ? [[scope, gd.tenants[scope]]] : []) : Object.entries(gd.tenants);
  const out = [], seen = new Set();
  const add = (tenant, cluster, label, calls) => {
    const key = cluster + "|" + label;
    if (seen.has(key)) return;
    const i = label.indexOf("/");
    const ns = i >= 0 ? label.slice(0, i) : "", name = i >= 0 ? label.slice(i + 1) : label;
    if (names.has(name)) return;
    seen.add(key);
    out.push({ ...rowOf({ serviceName: name, namespace: ns, cluster, componentsReady: DASH }), readyKnown: false, ready: false, drift: true, driftCalls: num(calls), driftTenant: tenant });
  };
  streams.forEach(([t, s]) => {
    const cl = s.clusters || {};
    if (Object.keys(cl).length) Object.keys(cl).sort().forEach((cn) => arr(cl[cn].newServices).forEach((l) => add(t, cn, l, (cl[cn].serviceCalls || {})[l])));
    else arr(s.newServices).forEach((l) => add(t, s.cluster || "", l, (s.serviceCalls || {})[l]));
  });
  return out;
}

// ── panel 3: concerns + events ─────────────────────────────────────────────
function mapConcerns(res, nowMs) {
  const list = arr((res || {}).issues).map((i) => {
    // The core names where an issue runs (cluster, namespace); the source path
    // is only the fallback for a core that does not.
    const sk = parseSourceKind(i.source, i.summary);
    if (i.cluster || i.namespace || arr(i.clusters).length || arr(i.namespaces).length) { sk.cluster = i.cluster || ""; sk.ns = i.namespace || ""; }
    // Where a service runs in several places the core lists them all.
    const clusters = arr(i.clusters).length ? i.clusters : sk.cluster ? [sk.cluster] : [];
    const namespaces = arr(i.namespaces).length ? i.namespaces : sk.ns ? [sk.ns] : [];
    const res2 = i.resolution || {};
    return {
      id: i.id || DASH,
      tenant: i.tenant || "",
      severity: String(i.severity || "").toLowerCase(),
      status: String(i.status || ""),
      source: i.source || "",
      cluster: clusters.join(","), ns: namespaces.join(","), clusters, namespaces,
      summary: oneLine(i.summary) || i.source || "",
      summaryFull: String(i.summary || ""),
      headline: firstLine(i.summary),
      firstSeen: i.firstSeen || null,
      lastSeen: i.lastSeen || null,
      age: ago(i.lastSeen, nowMs),
      reopenCount: num(i.reopenCount),
      actions: arr(i.actions).map((a) => (typeof a === "string" ? a : oneLine(a && (a.description || a.action || JSON.stringify(a))))),
      related: arr(i.relatedEventDetails),
      relatedTotal: num(i.relatedEventsTotal) || arr(i.relatedEventDetails).length,
      relatedIds: arr(i.relatedEvents),
      patterns: arr(i.relatedPatterns),
      comments: arr(i.comments),
      rootCause: (i.rca || {}).rootCause || res2.rootCause || "",
      fix: (i.rca || {}).fix || res2.fix || "",
      resolvedBy: res2.resolvedBy || "",
      resolvedAt: res2.resolvedAt || null,
      verdict: res2.verdict || "",
      verdictUntil: res2.verdictUntil || null,
      hypothesis: (i.investigationPlan || {}).hypothesis || "",
    };
  });
  const ts = (x) => new Date(x.lastSeen || 0).getTime() || 0;
  const open = list.filter((c) => c.status.toLowerCase() !== "resolved").sort((a, b) => ts(b) - ts(a));
  const resolved = list.filter((c) => c.status.toLowerCase() === "resolved").sort((a, b) => ts(b) - ts(a));
  return open.concat(resolved);
}

// The CLI reads status.events.recent (recentEvents()); /events/recent is the
// fallback when status is missing or carries no recent block.
function mapEvents(res, st, scope) {
  const fromStatus = arr((st.events || {}).recent);
  const useStatus = fromStatus.length > 0;
  const list = useStatus ? fromStatus : arr((res || {}).events);
  // Scoped like the CLI's filteredEvents (ev.tenant must match). The
  // /events/recent fallback carries no tenant field, so it is shown as-is.
  const out = list
    .filter((e) => !scope || !useStatus || e.tenant === scope)
    .map((e) => ({ ...e, severity: String(e.severity || "").toLowerCase(), _t: new Date(e.timestamp || 0).getTime() || 0 }));
  out.sort((a, b) => b._t - a._t);
  return { list: out, total: list.length, source: useStatus ? "status.events.recent" : "events/recent" };
}

// ── panel 4: activity + predictions ────────────────────────────────────────
function weekKeys(an) {
  const set = new Set();
  arr((an || {}).baselines).forEach((b) => Object.keys(b.weeklyIssueCounts || {}).forEach((k) => set.add(k)));
  return [...set].sort().slice(-8);
}
function mapActivity(an) {
  const ks = weekKeys(an);
  const byService = new Map();
  arr((an || {}).baselines).forEach((b) => {
    const key = (b.service || DASH) + "|" + (b.cluster || "");
    const row = byService.get(key) || { n: b.service || DASH, cluster: b.cluster || "", v: ks.map(() => 0), rate: num(b.issueRateWeek, null), issues: num(b.issueCount, null), mttr: num(b.mttrMean, null) };
    ks.forEach((k, i) => { row.v[i] += num((b.weeklyIssueCounts || {})[k]); });
    byService.set(key, row);
  });
  const rows = [...byService.values()]
    .sort((a, b) => b.v.reduce((x, y) => x + y, 0) - a.v.reduce((x, y) => x + y, 0));
  return {
    loaded: !!an,
    weeks: ks.map((k) => "W" + String(k).replace(/^\d{4}-?W?/, "")),
    weekKeys: ks,
    rows,
  };
}
function mapPredictions(an) {
  return arr((an || {}).precursorMatches)
    .map((m) => {
      const c = num(m.confidence, null);
      const p = c == null ? null : Math.max(0, Math.min(100, Math.round(c <= 1 ? c * 100 : c)));
      return {
        svc: m.service || DASH,
        cluster: m.cluster || "",
        tenant: m.tenant || "",
        p,
        steps: has(m.totalSteps) && m.totalSteps > 0 ? num(m.matchedSteps) + "/" + m.totalSteps : DASH,
        rate: has(m.issueRateWeek) ? m.issueRateWeek.toFixed(1) : DASH,
        signals: arr(m.liveSignalTypes),
        activeIssue: m.activeIssue === true,
        hasPattern: m.hasPattern === true,
        occurrences: num(m.occurrenceCount, null),
        patternId: m.patternId || "",
      };
    })
    .sort((a, b) => num(b.p) - num(a.p));
}

// ── panel 5: memory ────────────────────────────────────────────────────────
const KIND_COLOR = [
  ["concern", "#f87171"], ["issue", "#f87171"],
  ["identity", "#8b8bf0"], ["service", "#8b8bf0"], ["entity", "#8b8bf0"],
  ["pattern", "#60a5fa"], ["operational", "#60a5fa"], ["playbook", "#60a5fa"],
  ["watch", "#a78bfa"], ["hypothesis", "#a78bfa"],
  ["fact", "#4ade80"], ["stable", "#4ade80"], ["baseline", "#4ade80"],
  ["mental", "#67e8f9"], ["policy", "#f59e0b"], ["note", "#c9ccdb"],
];
export const kindColor = (k = "") => {
  const key = String(k).toLowerCase();
  for (const [t, c] of KIND_COLOR) if (key.includes(t)) return c;
  return "#8a8ea3";
};
export const itemTenant = (it) => {
  const t = arr(it.tags).find((x) => String(x).startsWith("tenant/"));
  return t ? String(t).slice(7) : "";
};
// Rows mirror the CLI's filteredMemoryItems (memory.go): active cells only,
// the scoped tenant's own plus untagged instance-wide ones, newest first.
// Backlinks are the reverse of each cell's outgoing links (memoryBacklinks).
function mapMemory(memory, summary, metrics, scope) {
  const src = memory ? arr(memory.items) : arr((summary || {}).items);
  const back = {};
  src.forEach((it) => arr(it.links).forEach((l) => {
    if (l && l.toId) (back[l.toId] = back[l.toId] || []).push({ id: it.id, title: it.title, kind: it.kind, relation: l.relation || l.type || "" });
  }));
  const items = src
    .filter((it) => !it.status || it.status === "active")
    .filter((it) => !scope || !itemTenant(it) || itemTenant(it) === scope)
    .sort((x, y) => new Date(y.updatedAt || 0) - new Date(x.updatedAt || 0))
    .map((it) => ({
      ...it,
      tenantTag: itemTenant(it),
      shared: !!scope && !itemTenant(it),
      backlinks: back[it.id] || [],
    }));
  const comp = (metrics || {}).composition || null;
  const byKind = (summary || {}).totalsByKind || (comp || {}).byKind || {};
  return {
    loaded: !!(memory || summary),
    items,
    total: items.length,
    byKind,
    byTenant: (summary || {}).totalsByTenant || null,
    metrics: metrics ? {
      items: num(metrics.items, null),
      workingSet: comp ? num(comp.workingSet, null) : null,
      hnswCells: comp && comp.hnsw ? num(comp.hnsw.memoryCellIndexSize, null) : null,
      hnswConcerns: comp && comp.hnsw ? num(comp.hnsw.issueCollectionSize != null ? comp.hnsw.issueCollectionSize : comp.hnsw.concernCollectionSize, null) : null,
      mentalMaps: comp ? comp.mentalMaps || {} : {},
      byKind: comp ? comp.byKind || {} : {},
      byStatus: comp ? comp.byStatus || {} : {},
      byTenant: comp ? comp.byTenant || {} : {},
      search: metrics.memorySearchStats || null,
    } : null,
  };
}

// ── <T> tenants ────────────────────────────────────────────────────────────
function mapTenants(st, registry, def) {
  const map = (st.tenantStats || {}).tenants || {};
  const stat = (id) => {
    const t = map[id], e = (t || {}).events || {}, c = (t || {}).issues || {};
    // tenantPickerRows: a tenant with no stats reads 0 events / 0 concerns,
    // and its app count and coverage read absent — never a fabricated 0.
    const apps = t ? num(t.services) : 0;
    return {
      id,
      isDefault: id === def,
      hasStats: !!t,
      events: num(e.noise) + num(e.signal) + num(e.issue) + num(e.unknown),
      opened: num(c.opened),
      apps: apps > 0 ? apps : null,
      coverage: apps > 0 ? num(t.serviceCoveragePct) : null,
    };
  };
  const ids = registry.length ? registry : Object.keys(map);
  return ids.map(stat);
}

// ── '?' config (config_overlay.go buildConfigLines) ────────────────────────
const cnt = (n) => (n == null ? null : formatCount(Number(n)));
// "agent 400k · reflection 250k · …": each reasoning call kind's daily cap,
// the same for every tenant (status limits, any tenant's kinds). null without
// caps.
function kindCapsText(limits) {
  const t = Object.values((limits || {}).tenants || {})[0];
  const kinds = Object.entries((t || {}).kinds || {}).filter(([, l]) => num(l.cap) > 0);
  if (!kinds.length) return null;
  return kinds.sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, l]) => k + " " + cnt(l.cap)).join(" · ");
}
function mapConfig(st) {
  const c = st.config;
  if (!c) return null;
  const ot = c.otelTracing || {};
  const stg = c.eventStorage || {};
  const limits = st.limits || {}, voice = st.voiceQuota || {};
  const cb = c.llmCircuitBreaker || null;
  return {
    model: c.model || null,
    baseURL: c.baseURL || null,
    guardrail: c.guardrailEnabled == null ? null : c.guardrailEnabled ? "Enabled" : "Disabled",
    guardrailModel: c.guardrailModel || null,
    rcaModel: c.rcaModel || null,
    chatModel: c.chatModel || null,
    decisionModel: c.decisionModel || null,
    embeddings: c.embeddingModel || null,
    voice: c.voiceEnabled == null ? null : c.voiceEnabled ? "Enabled" : "Disabled",
    voiceModel: c.voiceEnabled ? c.voiceModel || c.jucceModel || null : null,
    reflection: c.reflectionEnabled == null ? null : c.reflectionEnabled ? "Enabled" : "Disabled",
    retention: c.eventRetentionMinutes ? c.eventRetentionMinutes + " minutes" : "Default",
    a2a: c.a2aEnabled ? "Enabled (port " + (c.a2aPort || 8084) + ")" : "Disabled",
    otel: ot.enabled ? ot.endpoint || "(no endpoint)" : "Disabled",
    otelNote: ot.enabled ? (ot.protocol || "grpc") + ", " + (has(ot.samplePercent) ? ot.samplePercent : 100) + "% sample" : "",
    breaker: cb ? (cb.enabled ? "Enabled" : "Disabled") : null,
    breakerNote: cb && cb.enabled ? num(cb.failureThreshold) + " failures · " + num(cb.cooldownSeconds) + "s cooldown" : "",
    llmDaily: num(limits.cap) > 0 ? cnt(num(limits.spent)) + " / " + cnt(limits.cap) + " tokens/day" : null,
    voiceDaily: num(voice.limit) > 0 ? cnt(voice.limit) + " tokens/day" : null,
    kindCaps: kindCapsText(limits),
    queueBuffer: stg.queueBufferSize ? String(stg.queueBufferSize) : c.eventStorage ? "Default" : null,
    recentMax: stg.recentEventsMax ? String(stg.recentEventsMax) : c.eventStorage ? "Default" : null,
    tools: arr(c.remoteAgents).map((a) => a.name + " (A2A)").concat(arr(c.mcpServers).map((m) => m.name + " (MCP)")),
    notify: st.notify ? { name: st.notify.name || null, channels: arr(st.notify.channels).map((ch) => ch.name + " (" + ch.type + ", ≥" + (ch.minSeverity || "info") + ")") } : null,
  };
}
function mapStats(st) {
  const l = st.llmStats, cls = st.classifierStats, gr = st.guardrailStats;
  const gc = st.guardrailCacheStats, sc = st.semanticCacheStats, rag = st.ragStats;
  const ca = st.clusterAgentStats, go = st.gossip, vq = st.voiceQuota;
  if (!l && !cls && !gr && !rag) return null;
  return {
    llmCalls: l ? String(num(l.calls)) : null,
    llmSplit: l ? "prompt " + cnt(num(l.promptTokens)) + " / completion " + cnt(num(l.completionTokens)) : "",
    voice: l && num(l.voiceSessions) ? num(l.voiceSessions) + " sessions" : null,
    voiceSplit: l && num(l.voiceSessions) ? cnt(num(l.voiceInputTokens)) + "/" + cnt(num(l.voiceOutputTokens)) + " tok" : "",
    voiceQuota: vq && num(vq.limit) ? cnt(num(vq.tokensToday)) + "/" + cnt(vq.limit) + " tok/day" : null,
    voiceQuotaNote: vq && num(vq.limit) ? Math.round((num(vq.tokensToday) / num(vq.limit)) * 100) + "% · " + num(vq.usersToday) + " user" + (num(vq.usersToday) === 1 ? "" : "s") + " today" : "",
    classifier: cls ? (cls.enabled ? "enabled" : "disabled") : null,
    classifierSplit: cls && cls.enabled ? "noise " + num(cls.noise) + " / signal " + num(cls.signal) + " / unknown " + num(cls.unknown) : "",
    // The share of events settled without an LLM call: classified signal and noise plus semantic-cache hits, over those and the calls routed to the agent.
    fastPath: cls ? pctFrom01((() => { const fast = num(cls.signal) + num(cls.noise) + num((sc || {}).hits), routed = num((l || {}).agentCalls); return fast + routed > 0 ? fast / (fast + routed) : 0; })()) : null,
    embedded: cls ? cnt(num(cls.embeddingCalls)) : null,
    ingested: st.queue ? cnt(num(st.queue.total) + num(st.queue.dedupAbsorbed) + num(st.queue.quarantineTotal) + num(st.queue.quarantineDedupAbsorbed)) : null,
    processed: st.queue ? cnt(num(st.queue.total)) : null,
    skipped: st.queue ? cnt(num(st.queue.dedupAbsorbed) + num(st.queue.quarantineDedupAbsorbed)) : null,
    guardrail: gr ? (gr.enabled ? "enabled" : "disabled") : null,
    guardrailSplit: gr && gr.enabled ? num(gr.infraPassed) + " passed / " + num(gr.noiseDropped) + " dropped" + (has(gr.k8sBypassed) ? " / " + gr.k8sBypassed + " k8s bypassed" : "") : "",
    guardCache: gc && gc.enabled ? num(gc.hits) + " hits / " + num(gc.misses) + " misses" : null,
    semCache: sc && sc.enabled ? num(sc.hits) + " hits / " + num(sc.misses) + " misses" : null,
    hnsw: rag && rag.enabled ? num(rag.collectionSize) + " indexed" : null,
    hnswNote: rag && rag.enabled ? num(rag.retrievals) + " retrievals, " + num(rag.hits) + " hits" + (num(rag.retrievals) > 0 ? " (" + pctFrom01(num(rag.hits) / num(rag.retrievals)) + ")" : "") : "",
    agents: ca && ca.enabled ? num(ca.activeSessions) + " active" : null,
    agentsNote: ca && ca.enabled ? num(ca.namespaceCount) + " namespaces" : "",
    agentHomes: ca && ca.enabled ? arr(ca.sessions).map((s) => s.cluster + (s.replica ? "@" + s.replica : "")).join(", ") : "",
    gossipSelf: go ? go.self || "(unknown)" : null,
    gossipPeers: go ? arr(go.peers).join(", ") || "none connected" : null,
    gossipStats: go ? "sent " + cnt(num(go.eventsSent)) + " / recv " + cnt(num(go.eventsReceived)) + " / ins " + cnt(num(go.eventsInserted)) + " / drop " + cnt(num(go.outboxDropped)) : null,
    reflex: st.reflexRules ? (st.reflexRules.enabled ? "enabled" : "disabled") : null,
    reflexNote: st.reflexRules && st.reflexRules.enabled ? num(st.reflexRules.active) + " active / " + num(st.reflexRules.hits) + " hits" : "",
    rsi: st.rsi ? (st.rsi.enabled ? "enabled" : "disabled") : null,
    rsiNote: st.rsi ? [st.rsi.mode, st.rsi.interval].filter(Boolean).join(" · ") : "",
    retentionLeader: st.retention ? (st.retention.leader ? "leader" : "follower") : null,
    retentionNote: st.retention ? num(st.retention.sweeps) + " sweeps" : "",
  };
}
// One tenant's own lifetime block — buildTenantDetailLines.
function mapTenantCard(st, tenant) {
  const ts = (st.tenantStats || {}).tenants || {};
  const e = ts[tenant];
  if (!e) return null;
  const ev = e.events || {}, inc = e.issues || {};
  const sum = num(ev.noise) + num(ev.signal) + num(ev.issue);
  let all = 0;
  Object.keys(ts).forEach((k) => { const x = (ts[k] || {}).events || {}; all += num(x.noise) + num(x.signal) + num(x.issue); });
  const lt = ((st.limits || {}).tenants || {})[tenant], voice = st.voiceQuota || {};
  const cap = (t, id) => (t && (t[id] != null ? t[id] : t["*"])) || 0;
  const today = (by, t, id) => {
    const spent = num((by || {})[id]), c = cap(t, id);
    if (!c && !spent) return null;
    return c ? cnt(spent) + " / " + cnt(c) : cnt(spent);
  };
  return {
    events: "noise " + num(ev.noise) + " / signal " + num(ev.signal) + " / issue " + num(ev.issue) + (has(ev.unknown) ? " / unknown " + ev.unknown : ""),
    totalEvents: String(sum),
    totalEventsNote: all > 0 ? Math.round((sum / all) * 100) + "% of " + cnt(all) + " total" : "",
    concerns: "opened " + num(inc.opened) + " / reopened " + num(inc.reopened) + " / resolved " + num(inc.resolved) + " / open " + num(inc.openNow),
    llmTokens: has(e.llmTokens) ? cnt(e.llmTokens) : null,
    llmRatio: num(e.llmCompletionTokens) > 0 ? Math.round(num(e.llmPromptTokens) / num(e.llmCompletionTokens)) + ":1" : null,
    llmToday: lt ? today({ [tenant]: lt.spent }, { [tenant]: lt.cap }, tenant) : null,
    voiceToday: today(voice.byTenant, voice.tenantCaps, tenant),
    snr: has(e.snrPct) ? snrLabel(e.snrPct) : null,
    coverage: has(e.serviceCoveragePct) ? coveragePctLabel(e.serviceCoveragePct) : has(e.coveragePct) ? coveragePctLabel(e.coveragePct) : null,
    coverageNote: num(e.services) > 0 ? num(e.servicesReporting) + " of " + num(e.services) + " services reporting · " + num(e.servicesDark) + " dark" : "",
    eventCoverage: has(e.coveragePct) ? coveragePctLabel(e.coveragePct) : null,
    mttd: num(e.mttdP90Ms) > 0 ? "p90 " + formatDuration(e.mttdP90Ms / 1000) : num(e.mttdMs) > 0 ? formatDuration(e.mttdMs / 1000) : null,
    mttr: num(e.mttrMs) > 0 ? formatDuration(e.mttrMs / 1000) : null,
  };
}
// buildTenantDetailLinesFor — the tenant picker pane's block for ANY tenant
// (the highlighted one, not only the scoped one). Rows carry their own tone.
const exact = (n) => Number(n || 0).toLocaleString("en-US");
const ratio = (v) => Math.trunc(num(v) + 0.5) + ":1";
const sharePct = (part, all) => Math.trunc((part / all) * 100 + 0.5) + "%";
export function tenantDetail(st, tenant) {
  const ts = (st.tenantStats || {}).tenants || {};
  const e = ts[tenant] || {}, ev = e.events || {}, inc = e.issues || {};
  let allEvents = 0, allLLM = 0;
  Object.values(ts).forEach((x) => { const y = (x || {}).events || {}; allEvents += num(y.noise) + num(y.signal) + num(y.issue); allLLM += num((x || {}).llmTokens); });
  const evSum = num(ev.noise) + num(ev.signal) + num(ev.issue);
  const rows = [];
  const row = (k, v, note = "", tone = "fg-strong") => rows.push({ k, v, note, tone });
  row("Events:", "noise " + exact(ev.noise) + " / signal " + exact(ev.signal) + " / issue " + exact(ev.issue));
  row("Total Events:", exact(evSum), allEvents > 0 ? "(" + sharePct(evSum, allEvents) + " of " + exact(allEvents) + " across all tenants)" : "");
  row("Issues:", "opened " + exact(inc.opened) + " / reopened " + exact(inc.reopened) + " / resolved " + exact(inc.resolved) + " / open " + exact(inc.openNow));
  const llmNote = [allLLM > 0 ? "(" + sharePct(num(e.llmTokens), allLLM) + " of " + formatCount(allLLM) + " across all tenants)" : "",
    num(e.llmCompletionTokens) > 0 ? "· ratio " + ratio(e.llmTokenRatio) : ""].filter(Boolean).join("  ");
  row("LLM Tokens:", formatCount(num(e.llmTokens)), llmNote);
  const today = e.llmRatioToday || {}, week = e.llmRatio7d || {};
  if (num(today.completionTokens) > 0) row("LLM Ratio:", ratio(today.ratio) + " today", num(week.completionTokens) > 0 ? "(" + ratio(week.ratio) + " 7d, " + formatCount(num(week.calls)) + " calls)" : "");
  else row("LLM Ratio:", DASH, "", "fg-faint2");
  // tenantBudgetTodayValue: an uncapped tenant with no spend today gets no row.
  const budgetRow = (k, q) => {
    if (!q) return;
    const by = q.byTenant || {}, caps = q.tenantCaps || {};
    const spent = num(by[tenant]);
    const cap = caps[tenant] != null ? num(caps[tenant]) : num(caps["*"]);
    if (cap <= 0 && spent === 0) return;
    const p = cap > 0 ? spent / cap : 0;
    const tone = cap > 0 && p >= 1 ? "fg-crit" : cap > 0 && p >= 0.8 ? "fg-warn" : "fg-strong";
    if (cap > 0) row(k, formatCount(spent) + " / " + formatCount(cap), "(tenant cap, resets 00:00 UTC)", tone);
    else row(k, formatCount(spent), "(no tenant cap)", tone);
  };
  const lt = ((st.limits || {}).tenants || {})[tenant];
  budgetRow("LLM Today:", lt && { byTenant: { [tenant]: lt.spent }, tenantCaps: { [tenant]: lt.cap } });
  budgetRow("Voice Today:", st.voiceQuota);
  return { entry: ts[tenant] || null, rows };
}

function mapScorecard(e) {
  const row = (k, v, note) => ({ k, v, note });
  return [
    row("Compression", has(e.eventsPerIssue) ? e.eventsPerIssue.toFixed(1) : DASH, "events → 1 issue"),
    row("Early warning", has(e.precursorCoveragePct) ? wholePct(e.precursorCoveragePct) : DASH, "issues with precursor signals"),
    row("Hands-free", has(e.autoResolvedPct) ? wholePct(e.autoResolvedPct) : DASH, "resolved with no human action"),
    row("Prediction", has(e.predictionPrecisionPct) ? wholePct(e.predictionPrecisionPct) : DASH,
      has(e.predictionAvgLeadMs) ? "confirmed · avg lead " + formatDuration(e.predictionAvgLeadMs / 1000) : "confirmed"),
    row("Repeats", has(e.repeatRatePct) ? wholePct(e.repeatRatePct) : DASH, "issues that came back"),
  ];
}
