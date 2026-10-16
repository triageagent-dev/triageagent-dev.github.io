/**
 * Service detail: identity and dependencies from the graph node, readiness
 * from perCluster / applications, live per-service facts from the tenant
 * situation frame, and tenant-wide signal collectors labelled as such.
 *
 * The health score is the design's own derivation (triage-api.js
 * mapServiceDetails) over real inputs only — blast radius relative to the
 * tenant's widest, the service baseline's weekly issue rate and reopen
 * rate, and readiness. It is a client-side summary, not a server figure, and
 * the screen says so.
 */
import { DASH, fmtDurShort, lastSegment, num } from "./format.js"
import { denseHistory, isOpen, SIGNAL_KEYS, tenantEntry } from "./vitals.js"
import { edgesOf } from "./graph.js"

export function appStatus(a) {
  if (a.ready === true) return "Ready"
  const comps = a.components ?? []
  const bad = comps.filter(c => c.status && !/ready|running|healthy|true/i.test(c.status)).length
  return comps.length && bad === comps.length ? "Down" : "Degraded"
}

/**
 * Fleet states per application. Readiness alone says nothing about a service
 * that is up but has an open issue, so an app with an open critical issue
 * is error, one with any other open issue is degraded, and otherwise its
 * readiness decides. Issues are matched to apps by service name (the last segment of their source path).
 */
export function fleetCounts(apps, issues) {
  const sev = new Map()
  for (const i of issues.filter(isOpen)) {
    const k = lastSegment(i.source).toLowerCase()
    if (i.severity === "critical") sev.set(k, "critical")
    else if (!sev.has(k)) sev.set(k, "other")
  }
  let ready = 0, degraded = 0, down = 0
  for (const a of apps) {
    const inc = sev.get((a.serviceName ?? "").toLowerCase())
    const st = appStatus(a)
    if (inc === "critical" || st === "Down") down++
    else if (inc === "other" || st === "Degraded") degraded++
    else ready++
  }
  return { ready, degraded, down }
}

export function collectors(ts, now) {
  const hist = denseHistory(ts, now, 60)
  return SIGNAL_KEYS.map(s => {
    const vals = hist.map(h => h[s.api] ?? 0)
    const total = ts?.signalsByType?.[s.api]
    return {
      k: s.k, label: s.label, c: s.c,
      v: total == null ? DASH : total.toLocaleString("en-US"),
      bars: vals,
    }
  })
}

export function scorecard(ts) {
  const p = (v) => (v == null ? DASH : Math.round(v) + "%")
  const epi = num(ts?.eventsPerIssue)
  const lead = num(ts?.predictionAvgLeadMs)
  return [
    { k: "Compression", v: epi == null ? DASH : epi.toFixed(1), note: "events → 1 issue" },
    { k: "Early warning", v: p(num(ts?.precursorCoveragePct)), note: "issues with precursor signals" },
    { k: "Hands-free", v: p(num(ts?.autoResolvedPct)), note: "resolved with no human action" },
    { k: "Prediction", v: p(num(ts?.predictionPrecisionPct)), note: "confirmed" + (lead != null ? " · avg lead " + fmtDurShort(lead / 1000) : "") },
    { k: "Repeats", v: p(num(ts?.repeatRatePct)), note: "issues that came back" },
  ]
}

export function buildService(snap, name, now) {
  const g = snap?.graph
  const nodes = g?.nodes ?? []
  const node = nodes.find(n => n.name === name)
  const apps = snap?.apps?.applications ?? []
  const app = apps.find(a => a.serviceName === name) ?? apps.find(a => a.application === name) ?? null
  const ts = tenantEntry(snap)
  const edges = g ? edgesOf(g) : []
  const up = [...new Set(edges.filter(e => e.target === name).map(e => e.source))]
  const down = [...new Set(edges.filter(e => e.source === name).map(e => e.target))]
  const maxB = Math.max(0.001, ...nodes.map(n => num(n.blastRadius) ?? 0))
  const blast = num(node?.blastRadius)
  const base = (snap?.analytics?.baselines ?? []).find(b => b.service === name)
  const ready = node?.appReady ?? app?.ready
  let score = null
  if (node && blast != null) {
    const rate = num(base?.issueRateWeek) ?? 0
    const reopen = num(base?.reopenRate) ?? 0
    score = Math.max(0, Math.min(100, Math.round(100 - (blast / maxB) * 45 - Math.min(30, rate * 4) - Math.min(20, reopen * 100 * 0.4) - (ready === false ? 15 : 0))))
  }
  const envs = Object.entries(node?.perCluster ?? {}).slice(0, 4).map(([k, v]) => ({
    n: k, comp: v?.components || DASH, st: v?.ready === false ? "Degraded" : v?.ready === true ? "Ready" : DASH,
  }))
  if (!envs.length && app) envs.push({ n: [app.cluster, app.namespace].filter(Boolean).join("/") || name, comp: app.componentsReady || DASH, st: appStatus(app) })
  const version = app?.version || Object.values(node?.perCluster ?? {}).find(v => v?.version)?.version || DASH
  return {
    name,
    found: !!node || !!app,
    domain: node?.domain || DASH,
    team: node?.team || DASH,
    version,
    about: node?.description || "",
    blast: blast == null ? DASH : blast.toFixed(3),
    score,
    band: score == null ? DASH : score >= 80 ? "Strong" : score >= 60 ? "Fair" : "Watch",
    up, down, envs,
    situation: (snap?.situation?.services ?? []).find(s => s.service === name) ?? null,
    severity: severityBand(blast, (node?.tier ?? 0) >= 4, num(g?.noiseThreshold), num(g?.issueThreshold)),
    ledger: (snap?.ledger?.rows ?? []).filter(r => r.service === name),
    app,
    collectors: collectors(ts, now),
    scorecard: scorecard(ts),
  }
}

/** The severity band a blast radius puts a service in (core ADR-061): below
 *  the noise threshold info, below the issue threshold warning, else
 *  critical; a noise-tier node is always info. */
export function severityBand(blast, noiseTier, noiseT, issueT) {
  if (noiseTier) return "info"
  if (blast == null || noiseT == null || issueT == null) return null
  if (blast >= issueT) return "critical"
  if (blast >= noiseT) return "warning"
  return "info"
}

/** Two-hop dependency map geometry in a 340 × 236 viewBox. */
export function depGeometry(up, down) {
  const cx = 170, cy = 118
  const place = (list, y, spread, dir) => list.map((n, i) => {
    const t = list.length === 1 ? 0.5 : i / (list.length - 1)
    const x = cx + (t - 0.5) * spread
    return { n: n.length > 13 ? n.slice(0, 12) + "…" : n, full: n, x, y: y + (dir < 0 ? -1 : 1) * Math.abs(Math.sin(t * Math.PI)) * -10 * dir }
  })
  const ups = place(up.slice(0, 6), 34, 290, -1)
  const downs = place(down.slice(0, 4), 202, 190, 1)
  const edges = ups.concat(downs).map(p => ({ x1: cx, y1: cy, x2: p.x, y2: p.y }))
  return { cx, cy, ups, downs, edges }
}
