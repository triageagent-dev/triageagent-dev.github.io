/**
 * The event stream: grouped like the CLI/desktop (type + source minus the
 * trailing resource name), filterable by classifier zone, each row carrying
 * the reasoning line for its zone.
 */
import { parseSource } from "./format.js"

export const ZONES = ["noise", "unknown", "signal", "issue"]

/** Shown names: the wire's issue zone is a concern in the app. */
export const ZONE_LABEL = { noise: "Noise", unknown: "Unknown", signal: "Signal", issue: "Issue" }

export function asZone(v) {
  return ZONES.includes(v ?? "") ? v : null
}

/** Why a row landed in its zone — the classifier's reasoning, said plainly. */
export const CLS_WHY = {
  noise: "deduplicated · absorbed before ranking, nobody paged",
  unknown: "no service-graph match · cannot be ranked yet",
  signal: "ranked on the service graph · below the issue threshold",
  issue: "crossed the issue threshold · promoted to an issue",
}

export const CLS_NOTE = {
  noise: "Noise: the classifier absorbed this before ranking — a duplicate or a known-benign pattern. Nobody was paged.",
  unknown: "Unknown: the event names nothing the service graph knows, so it could not be ranked. Adding the workload to the graph lets future events rank.",
  signal: "Ranked signal: the event matched a service on the graph and ranks above noise, but stayed below the issue threshold.",
  issue: "Issue: the event crossed the issue threshold and was promoted to (or absorbed into) an issue.",
}

export const ZONE_COLOR = {
  noise: "#595d6c",
  unknown: "#d3d7e6",
  signal: "#f97316",
  issue: "#ef4444",
}

export const zoneColor = (cls) => ZONE_COLOR[asZone(cls) ?? "noise"]

/**
 * The tenant's recent events.
 *
 * On the v3 core, /v2/agent/events/recent?tenant=<t> answers [] because ring
 * events carry no tenant field; the snapshot therefore reads it WITHOUT
 * ?tenant= when the caller has exactly one readable tenant (see
 * api/snapshot.ts). Either way, an entry that does carry `tenant` is kept
 * only when it names the current tenant. If the feed is still empty,
 * status.events.recent (same filter) is used rather than an empty list.
 */
export function tenantEvents(snap) {
  if (!snap) return []
  const mine = (e) => !e.tenant || e.tenant === snap.tenant
  const primary = (snap.events?.events ?? []).filter(mine)
  if (primary.length) return primary
  return (snap.status?.events?.recent ?? []).filter(mine)
}

export function groupKey(e) {
  const parts = (e.source ?? "").split("/")
  const kind = parts.length >= 4 ? parts.slice(0, -1).join("/") : e.source
  return `${kind}::${e.type ?? "event"}`
}

const ts = (e) => {
  const t = new Date(e.timestamp ?? "").getTime()
  return Number.isFinite(t) ? t : 0
}

export function groupEvents(events, zone) {
  const map = new Map()
  for (const e of events) {
    const z = asZone(e.classification)
    if (zone && z !== zone) continue
    const k = groupKey(e) + "::" + (z ?? "")
    const g = map.get(k)
    if (!g) map.set(k, { key: k, event: e, count: 1, times: [ts(e)], zone: z })
    else {
      g.count++
      g.times.push(ts(e))
      if (ts(e) > ts(g.event)) g.event = e
    }
  }
  return Array.from(map.values()).sort((a, b) => ts(b.event) - ts(a.event))
}

/** Every member of a group, bucketed over the feed's own span (real timestamps only). */
export function occurrences(times, from, to, buckets = 12) {
  const out = new Array(buckets).fill(0)
  const span = Math.max(1, to - from)
  for (const t of times) {
    if (!t) continue
    const i = Math.min(buckets - 1, Math.max(0, Math.floor(((t - from) / span) * buckets)))
    out[i]++
  }
  return out
}

export function feedSpan(events) {
  const t = events.map(ts).filter(Boolean)
  if (!t.length) return null
  return { from: Math.min(...t), to: Math.max(...t) }
}

/** The issue that lists this event among its related events, if any. */
export function relatedIssue(issues, eventId) {
  return issues?.find(i =>
    i.relatedEvents?.includes(eventId) || i.relatedEventDetails?.some(d => d.id === eventId),
  ) ?? null
}

/** A numeric classifier score carried in `raw`, when the core put one there. */
export function rawScore(raw, keys) {
  if (!raw) return null
  for (const k of keys) {
    const v = raw[k]
    if (typeof v === "number" && Number.isFinite(v)) return (Math.round(v * 100) / 100).toString()
  }
  return null
}

export function sourceParts(source) {
  const p = parseSource(source)
  return ([
    ["kind", p.kind === "k8s" ? (p.resource || "k8s") : p.kind],
    ["cluster", p.cluster],
    ["env", p.namespace],
  ]).filter(([, v]) => !!v)
}
