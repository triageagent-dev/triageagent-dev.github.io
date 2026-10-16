/**
 * The Home / Vitals view model, from one tenant's snapshot.
 *
 * Ported from ui/lib/vitals/model.ts, which checked the design's own mapper
 * (design-handoff/design/triage-api.js) against the real v3 core. Where the
 * two disagree the core wins:
 *
 *   - tenantStats.tenants[t].events.{noise,unknown,signal,issue} are
 *     DISJOINT lifetime totals; issue is not inside signal on the wire.
 *     The zone bar still draws an issue as a promoted signal, so its signal
 *     segment is signal+issue with issue inside it. drift overlaps
 *     signal/issue and never enters a total.
 *   - open counts come from the tenant's own issue list, never from an
 *     instance-wide block.
 *   - an absent vital is null and renders "—", never a met goal.
 */
import { CORONA_SPAN, coronaHand, coronaTicks, denseHistory as sharedDenseHistory } from "../../tui/corona.js"
import { statusBand } from "../../tui/band.js"
import { CRITICAL_WEIGHT, DEFAULT_GOALS, INC_MAX, centreMath, ringModel, weightedIssues } from "../../tui/rings.js"
import { normWeekKey, weekWindow } from "./weeks.js"
import { buildInfra, hasScore, healthOf } from "./health.js"
import { isScoped, normCluster, placesOf, rowInScope, scopeApps, scopeIssues } from "./scope.js"
import { ageShort, count, lastSegment, num, ordinal, parseSource, pct, firstLine, restLines, durBetween } from "./format.js"

export { CRITICAL_WEIGHT, DEFAULT_GOALS, INC_MAX }

export function tenantEntry(snap) {
  if (!snap) return null
  return snap.status?.tenantStats?.tenants?.[snap.tenant] ?? null
}

export function zonesOf(ts) {
  const e = ts?.events
  if (!e) return null
  const z = { noise: e.noise ?? 0, unknown: e.unknown ?? 0, signal: e.signal ?? 0, issue: e.issue ?? 0, drift: e.drift ?? 0 }
  return { ...z, total: z.noise + z.unknown + z.signal + z.issue }
}

export const isOpen = (i) => !/resolv|closed/i.test(i.status ?? "")

const SEV_RANK = { critical: 0, warning: 1, info: 2 }

export function sevColor(sev) {
  const s = String(sev || "").toLowerCase()
  return s === "critical" ? "#ef4444" : s === "warning" ? "#f59e0b" : "#60a5fa"
}

export function sevPill(sev) {
  const s = String(sev || "").toLowerCase()
  return s === "critical" ? { bg: "var(--tint-crit)", fg: "var(--on-crit)" }
    : s === "warning" ? { bg: "var(--tint-warn)", fg: "var(--on-warn)" }
    : { bg: "var(--tint-info)", fg: "var(--on-info)" }
}

export const capital = (s) => {
  const v = String(s || "info")
  return v.charAt(0).toUpperCase() + v.slice(1)
}

/** Graph node for a source's last segment — exact name, else a pod-style prefix. */
export function nodeFor(graph, svc) {
  const nodes = graph?.nodes ?? []
  return nodes.find(n => n.name === svc)
    ?? nodes.filter(n => svc.startsWith(n.name + "-")).sort((a, b) => b.name.length - a.name.length)[0]
}

/** Services that transitively call this one — who feels it when it breaks. */
export function downstreamCount(graph, name) {
  const byName = new Map((graph?.nodes ?? []).map(n => [n.name, n]))
  const seen = new Set([name])
  const queue = [name]
  while (queue.length) {
    const cur = byName.get(queue.shift())
    for (const c of cur?.calledBy ?? []) if (!seen.has(c)) { seen.add(c); queue.push(c) }
  }
  return seen.size - 1
}

// ── Signals: footer counts and the corona of 5-minute ticks ──────────────────

export const SIGNAL_KEYS = [
  { k: "res", api: "resourcePressure", label: "resource pressure", c: "#22d3ee" },
  { k: "req", api: "RequestErrorAnomaly", label: "request errors", c: "#ef4444" },
  { k: "evt", api: "podFailure", label: "k8s events", c: "#9184d9" },
  { k: "log", api: "LogErrorAnomaly", label: "log errors", c: "#f59e0b" },
  { k: "con", api: "connector", label: "connectors", c: "#60a5fa" },
  { k: "hum", api: "human", label: "h2a/a2a/mcp", c: "#f472b6" },
]

/** Sparse history onto the 300 s grid (shared with the TUI: public/tui/corona.js). */
export function denseHistory(ts, now, span) {
  return sharedDenseHistory([ts?.signalsHistory], SIGNAL_KEYS.map(s => s.api), now, span)
}

export { CORONA_SPAN }

/** The "now" hand across the corona. */
export function haloHand(now) {
  return { ...coronaHand(now, 95), c: "#e9e9ed", op: 1 }
}

/** The corona's ticks (public/tui/corona.js), coloured for mobile: the
 * dominant signal's colour, green for a quiet bucket the agents reported in,
 * grey for one nothing was collected for. `segs` holds one stacked, coloured
 * piece per signal in the bucket; the hero draws those when present. */
export function halo(hist) {
  return coronaTicks(hist, SIGNAL_KEYS, 20).map(({ sig, alive, segs, ...t }) => ({
    ...t, c: sig ? sig.c : alive ? "#4ade80" : "#595d6c",
    segs: segs.map(({ sig: s, ...g }) => ({ ...g, c: s.c })),
  }))
}

// ── Issue rows ────────────────────────────────────────────────────────────

export function issueRow(i, graph, now) {
  const src = parseSource(i.source)
  const svc = lastSegment(i.source)
  const node = nodeFor(graph, svc)
  const sevKey = String(i.severity || "info").toLowerCase()
  const pill = sevPill(sevKey)
  const down = node ? downstreamCount(graph, node.name) : 0
  const related = i.relatedEventDetails?.length || i.relatedEvents?.length || 0
  const open = isOpen(i)
  const rootCause = i.rca?.rootCause || i.resolution?.rootCause || ""
  const meta = [
    node?.blastRadius != null ? `blast ${node.blastRadius.toFixed(3)}` : "",
    node ? `${down} service${down === 1 ? "" : "s"} downstream` : "",
    i.reopenCount ? `${ordinal(i.reopenCount + 1)} time` : "",
    related ? `${related} related event${related === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ") || (rootCause ? "root cause identified" : "cause unknown")
  const d = durBetween(i.firstSeen, i.resolution?.resolvedAt || i.lastSeen)
  const age = ageShort(i.firstSeen, now)
  return {
    id: i.id,
    sev: capital(sevKey),
    sevKey,
    color: sevColor(sevKey),
    pillBg: pill.bg,
    pillFg: pill.fg,
    svc,
    env: [src.cluster, src.namespace].filter(Boolean).join(" · "),
    age: (open ? "open " : "") + (age || "—"),
    when: [age ? age + " ago" : "", d != null ? (d < 3600 ? Math.round(d / 60) + "m" : Math.round(d / 3600) + "h") : ""].filter(Boolean).join(" · "),
    summary: firstLine(i.summary) || rootCause || "—",
    context: restLines(i.summary),
    meta,
    source: i.source || "",
    open,
    status: open ? capital(i.status || "open") : "Resolved",
    repeat: i.reopenCount ? `${ordinal(i.reopenCount + 1)} time` : "",
    rootCause,
    fix: i.rca?.fix || i.resolution?.fix || "",
    firstSeen: i.firstSeen || "",
  }
}

export function rankIssues(list) {
  return list.slice().sort((a, b) =>
    (isOpen(a) ? 0 : 1) - (isOpen(b) ? 0 : 1)
    || (SEV_RANK[a.severity ?? ""] ?? 3) - (SEV_RANK[b.severity ?? ""] ?? 3)
    || new Date(b.firstSeen ?? 0).getTime() - new Date(a.firstSeen ?? 0).getTime())
}

// ── The model ────────────────────────────────────────────────────────────────

/** Monday 00:00 UTC of the ISO week holding `now`. */
function weekStart(now) {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() || 7) - 1) * 86400000
}

/** Recovery for this ISO week: mean open-to-resolved seconds of the issues
 *  resolved since Monday, or null when none were — an old MTTR never scores
 *  a quiet week. */
export function weekRecoverySec(issues, now) {
  const since = weekStart(now)
  const secs = issues.flatMap(i => {
    const end = isOpen(i) ? NaN : Date.parse(i.resolution?.resolvedAt ?? "")
    const start = Date.parse(i.firstSeen ?? "")
    return end >= since && end >= start ? [(end - start) / 1000] : []
  })
  return secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : null
}

/** This week's issue count and the prior 11 weeks' mean, from the core's
 *  per-deployment weekly series (ADR-086) or, on an older core, the
 *  analytics baselines, with this week's severity split when the core sends
 *  weeklySeverity; null when the core reported no weeks at all. */
export function weekIssues(snap, now, sc = {}) {
  const byWeek = new Map()
  const win = weekWindow(now, 12)
  const key = win[win.length - 1].key
  let critical = null, warning = null
  const deployments = snap?.analytics?.deployments ?? []
  const places = isScoped(sc) ? placesOf(snap?.apps?.applications) : null
  const inScope = deployments.length
    ? (b) => rowInScope(b, sc)
    // The baselines carry a cluster but no namespace: a namespace scope has
    // no series on an older core, only the issue list's floor (below).
    : (b) => !sc.cluster || (b.cluster ? normCluster(b.cluster) === sc.cluster : (places.get(b.service) ?? []).some(p => p.cluster === sc.cluster))
  if (sc.ns && !deployments.length) return weekFloor(snap, now, sc)
  for (const b of (deployments.length ? deployments : (snap?.analytics?.baselines ?? [])).filter(inScope)) {
    for (const [k, v] of Object.entries(b.weeklyIssueCounts ?? {})) {
      const nk = normWeekKey(k)
      if (nk) byWeek.set(nk, (byWeek.get(nk) ?? 0) + (v || 0))
    }
    if (b.weeklySeverity) {
      critical ??= 0
      warning ??= 0
      for (const [k, w] of Object.entries(b.weeklySeverity)) {
        if (normWeekKey(k) !== key) continue
        critical += w.critical ?? 0
        warning += w.warning ?? 0
      }
    }
  }
  if (!byWeek.size) return null
  const n = win.map(w => byWeek.get(w.key) ?? 0)
  const prior = n.slice(0, -1)
  const thisWeek = n[n.length - 1]
  return {
    thisWeek, baseline: prior.reduce((a, b) => a + b, 0) / prior.length, critical, warning,
    weighted: weightedIssues(thisWeek, critical),
  }
}

/** This week's issues counted from the issue list the phone holds: a floor,
 *  since the core keeps only each tenant's most recently resolved issues. */
function weekFloor(snap, now, sc) {
  const since = weekStart(now)
  const week = scopeIssues(snap?.issues?.issues, snap?.apps?.applications, sc).filter(i => Date.parse(i.firstSeen ?? "") >= since)
  const critical = week.filter(i => i.severity === "critical").length
  return { thisWeek: week.length, baseline: 0, critical, warning: week.filter(i => i.severity === "warning").length, weighted: weightedIssues(week.length, critical) }
}

/** How many deployments (cluster and namespace) the tenant's apps run in;
 *  at least one. The single-cluster key "default" is the empty cluster. */
export function deploymentCount(snap, sc = {}) {
  const deps = new Set()
  for (const a of scopeApps(snap?.apps?.applications, sc)) {
    const c = a.cluster === "default" ? "" : (a.cluster ?? ""), n = a.namespace ?? ""
    if (c || n) deps.add(c + "/" + n)
  }
  return Math.max(1, deps.size)
}

/** `scope` narrows Home to a cluster and namespace: { cluster, ns, health }
 *  where health is the core's score over that scope (null while it loads, so the infra
 *  rings read unknown rather than as the tenant's). */
export function buildVitals(snap, goals, now, scope = {}) {
  const sc = { cluster: scope.cluster ?? "", ns: scope.ns ?? "" }
  const ts = tenantEntry(snap)
  const apps = scopeApps(snap?.apps?.applications, sc)
  const issues = scopeIssues(snap?.issues?.issues, snap?.apps?.applications, sc)
  const open = rankIssues(issues.filter(isOpen))
  const criticalOpen = open.filter(i => i.severity === "critical").length
  const warningOpen = open.filter(i => i.severity === "warning").length
  const otherOpen = open.length - criticalOpen - warningOpen
  const degraded = apps.filter(a => a.ready !== true).length
  const repeat = num(ts?.repeatRatePct) ?? null

  const zones = zonesOf(ts)
  const awarenessPct = zones && zones.total > 0 ? ((zones.total - zones.issue) / zones.total) * 100 : null
  const lead = num(ts?.predictionAvgLeadMs)
  // Lead time only: mttd is detection delay, the opposite sense, never a stand-in.
  const warnSec = lead != null ? lead / 1000 : null
  const mttrSec = weekRecoverySec(issues, now)
  const resolutionPct = num(ts?.resolutionRatePct) ?? null
  const incWeek = weekIssues(snap, now, sc)
  const h = isScoped(sc) ? (scope.health ?? null) : healthOf(snap)
  const infra = buildInfra(snap, goals, h)
  // The readiness goal is per deployment (cluster and namespace); the
  // tenant's goal is the goal times its deployments, read from the apps list.
  const deployments = deploymentCount(snap, sc)
  // The rings and the centre (public/tui/rings.js, shared with the TUI).
  const { fills, measured, avail, attain: attainPct, goalsMet, incGoal } = ringModel({
    arms: hasScore(h) ? h.arms : null, weighted: incWeek?.weighted ?? null, goals, deployments,
  })
  // Bands are rules, not score cuts: the open issues and the goals read
  // together (public/tui/band.js).
  const { band, meaning: bandMeaning, tone } = statusBand({
    crit: criticalOpen, warn: warningOpen, other: otherOpen, degraded, repeat: repeat ?? 0,
    fills, weighted: incWeek?.weighted ?? null, incGoal,
  })
  const bandFg = { ok: "#4ade80", watch: "#d2cefd", warn: "#f59e0b", crit: "#f87171" }[tone]
  const attainMath = centreMath(measured, fills.inc, avail)

  const hist = denseHistory(ts, now, CORONA_SPAN)
  // The corona's own 12 h window, not the lifetime signalsByType totals, so
  // the legend moves with the trend the ticks draw.
  const fleetSignals = SIGNAL_KEYS.map(s => ({
    k: s.k,
    v: hist.length ? count(hist.reduce((a, h) => a + (h[s.api] ?? 0), 0)) : "—",
    c: s.c,
  }))

  const liveIssues = open.slice(0, 3).map(i => issueRow(i, snap?.graph, now))

  const reasons = [
    criticalOpen ? `${criticalOpen} critical` : "",
    warningOpen ? `${warningOpen} warning` : "",
    otherOpen ? `${otherOpen} open` : "",
    degraded ? `${degraded} not ready` : "",
    repeat ? `repeat rate is ${Math.round(repeat)}%` : "",
  ].filter(Boolean)
  const repeater = open.find(i => i.reopenCount)
  const state = reasons.length
    ? `${band}: ${reasons.join(", ")}${repeater ? ` — ${lastSegment(repeater.source)} came back ${ordinal((repeater.reopenCount ?? 0) + 1)} time` : ""}.`
    : "All clear: nothing open, nothing degraded, nothing repeating."
  const ringsByFill = [["USE", fills.use], ["RED", fills.red], ["SIG", fills.sig], ["Readiness", fills.inc]]
    .filter(([, f]) => f != null)
  const shortest = ringsByFill.sort((a, b) => a[1] - b[1])[0]
  const insight = shortest
    ? `${state} Against your goals, ${shortest[0]} is the short ring at ${pct(shortest[1])}.`
    : state

  return {
    hasStats: !!ts,
    band, bandMeaning, bandFg,
    openCount: open.length, criticalOpen, warningOpen, degraded,
    zones, awarenessPct, warnSec, mttrSec, resolutionPct, repeatPct: repeat,
    cluster: sc.cluster, ns: sc.ns, fills, infra, incWeek, attainPct, goalsMet, attainMath, incGoal, deployments,
    fleetSignals,
    halo: halo(hist),
    hand: hist.length ? haloHand(now) : null,
    liveIssues,
    insight,
  }
}

/** Ring dash: a vital far off its goal still gets a visible mark. Null draws nothing. */
export function ringDash(fill, circ) {
  if (fill == null) return `0 ${Math.round(circ) + 1}`
  return `${Math.max(3, Math.round(fill * circ))} ${Math.round(circ) + 1}`
}
