/**
 * Trends: issues over time and predictions. The only per-period series the
 * core has is baselines[].weeklyIssueCounts, laid on a contiguous ISO-week
 * calendar (weeks with no issues are empty columns, never dropped). Months
 * and quarters group those weeks by their Thursday. No per-vital history
 * exists on the wire, so no sparkline is drawn for one.
 */
import { lastSegment, num } from "./format.js"
import { normWeekKey, weekWindow } from "./weeks.js"

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function byWeek(analytics) {
  const m = new Map()
  for (const b of analytics?.baselines ?? []) {
    for (const [k, v] of Object.entries(b.weeklyIssueCounts ?? {})) {
      const nk = normWeekKey(k)
      if (nk) m.set(nk, (m.get(nk) ?? 0) + (v || 0))
    }
  }
  return m
}

export function periodSeries(analytics, now, period) {
  const weeks = byWeek(analytics)
  const hasHistory = weeks.size > 0
  if (!hasHistory) return { cols: [], total: 0, hasHistory }
  const span = period === "week" ? 12 : period === "month" ? 26 : 52
  const buckets = new Map()
  for (const w of weekWindow(now, span)) {
    const label = period === "week" ? w.label
      : period === "month" ? `${MON[w.thu.getUTCMonth()]}`
      : `Q${Math.floor(w.thu.getUTCMonth() / 3) + 1} ${String(w.thu.getUTCFullYear()).slice(2)}`
    buckets.set(label, (buckets.get(label) ?? 0) + (weeks.get(w.key) ?? 0))
  }
  const cols = [...buckets.entries()].map(([t, n]) => ({ t, n }))
  return { cols, total: cols.reduce((a, c) => a + c.n, 0), hasHistory }
}

/** Per-service weekly heat grid over the last 8 ISO weeks. */
export function heatGrid(analytics, now) {
  const win = weekWindow(now, 8)
  const counts = new Map()
  for (const b of analytics?.baselines ?? []) {
    const svc = b.service || "—"
    const m = counts.get(svc) ?? new Map()
    for (const [k, v] of Object.entries(b.weeklyIssueCounts ?? {})) {
      const nk = normWeekKey(k)
      if (nk) m.set(nk, (m.get(nk) ?? 0) + (v || 0))
    }
    counts.set(svc, m)
  }
  const rows = [...counts.entries()]
    .map(([n, m]) => { const v = win.map(w => m.get(w.key) ?? 0); return { n, v, total: v.reduce((a, b) => a + b, 0) } })
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)
  return { weeks: win.map(w => w.label), rows }
}

export function rankedPredictions(analytics) {
  const best = new Map()
  for (const m of analytics?.precursorMatches ?? []) {
    const c = m.confidence ?? 0
    const p = Math.max(0, Math.min(100, Math.round(c <= 1 ? c * 100 : c)))
    const key = [m.cluster ?? "", m.service ?? ""].join("/")
    const why = [
      m.totalSteps ? `${m.matchedSteps ?? 0}/${m.totalSteps} precursor steps matched` : "precursor pattern matched",
      m.liveSignalTypes?.length ? `live: ${m.liveSignalTypes.join(", ")}` : "",
      m.hasPattern === false ? "no learned pattern yet" : "",
      m.activeIssue ? "issue already open" : "",
    ].filter(Boolean).join(" · ")
    const rate = num(m.issueRateWeek)
    const row = {
      key, svc: m.service || "—", env: m.cluster || "", p, why,
      rate: rate != null && rate > 0 ? `${rate < 10 ? rate.toFixed(1) : Math.round(rate)}/wk` : "",
      active: !!m.activeIssue,
    }
    const cur = best.get(key)
    if (!cur || cur.p < p) best.set(key, row)
  }
  return [...best.values()].sort((a, b) => b.p - a.p)
}

/** Resolved issues with a recorded resolution time, slowest first. */
export function slowestResolved(issues, n = 3) {
  const out = []
  for (const i of issues) {
    if (!/resolv/i.test(i.status ?? "") || !i.resolution?.resolvedAt || !i.firstSeen) continue
    const sec = (new Date(i.resolution.resolvedAt).getTime() - new Date(i.firstSeen).getTime()) / 1000
    if (!Number.isFinite(sec) || sec <= 0) continue
    out.push({ id: i.id, label: lastSegment(i.source), sec })
  }
  return out.sort((a, b) => b.sec - a.sec).slice(0, n)
}

// ── Prognosis: the knowledge pass's per-service verdicts ─────────────────────

/** The service a verdict is about: its subject, else the title before " — ". */
function verdictService(it) {
  const subj = (it.subject ?? "").trim()
  if (subj) return subj.replace(/^service\//, "")
  const head = (it.title ?? "").split(/\s+[—-]\s+/)[0].trim()
  return head && !/\s/.test(head) ? head : ""
}

/**
 * Active `mindmap` cells tagged to this tenant, newest first. A shared,
 * untagged cell is nobody's verdict and is dropped (same rule as the desktop
 * Prognosis card and the CLI).
 */
export function prognosisRows(aw, tenant) {
  const items = aw?.items ?? aw?.Body?.items ?? []
  return items
    .filter(it => it.kind === "mindmap" && it.status === "active" && (it.tags ?? []).includes("tenant/" + tenant))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .map(it => ({
      id: it.id, title: it.title || it.id, content: it.content ?? "", confidence: it.confidence ?? "",
      svc: verdictService(it), updatedAt: it.updatedAt ?? "", staleAfter: it.staleAfter ?? "",
    }))
}

/** TUI bubble tones (public/tui/goals.js): solid fill + lighter rim, stepped by percentage. */
const BUBBLE_TONES = [
  [95, "#c026d3", "#f0abfc"], [80, "#db2777", "#f9a8d4"], [70, "#ea580c", "#fdba74"],
  [50, "#d97706", "#fcd34d"], [30, "#0891b2", "#67e8f9"], [15, "#6355d6", "#b3aef8"], [0, "#475569", "#94a3b8"],
]
export const bubbleTone = (p) => BUBBLE_TONES.find(([min]) => p >= min)
