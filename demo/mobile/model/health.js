/**
 * Infra fitness: the USE / RED / SIG goal cards, from the core's deterministic
 * health block (GET /v2/tenants/{t}/health, mirrored without `services` at
 * status.tenantStats.tenants[t].health). Pure; an absent figure is null and
 * renders "—", never a met goal.
 *
 * Reasons are strings written by the core: "errors 7.2%", "p99 4200ms",
 * "memory 96%", "psi 12%", "oom kills 3", "not ready 1/2",
 * "traffic 32% of baseline", "silent 12m".
 */
import { DASH, num } from "./format.js"
import { armOf, armRing } from "../../tui/rings.js"

/** One arm of one service, 0..1; RED is errors and latency combined (tui/rings.js). */
export { armOf }

/** The endpoint's body wins (newer, fuller); else the status block. */
export function healthOf(snap) {
  if (!snap) return null
  return snap.health ?? snap.status?.tenantStats?.tenants?.[snap.tenant]?.health ?? null
}

/** Whether the core scored anything; score 0 with scored 0 is no signal. */
export const hasScore = (h) => !!h && (num(h.scored) ?? 0) > 0

const arm = (a, k) => num(a?.[k])
const p100 = (x) => Math.round(x * 100) + "%"

/** The services the core listed: the full set when served, else the worst few. */
export const servicesOf = (h) => h?.services ?? h?.worst ?? []

/** Reason prefixes that speak for each arm. */
const PREFIXES = {
  use: ["memory", "psi", "oom", "cpu"],
  red: ["errors", "p99"],
  sig: ["traffic", "silent"],
}

/** The first reason of `s` that speaks for `k`, tidied ("p99 4200ms" -> "p99 4200 ms"). */
export function reasonFor(s, k) {
  for (const r of s?.reasons ?? []) {
    const low = r.trim().toLowerCase()
    if (PREFIXES[k].some(p => low.startsWith(p))) {
      return low.replace(/^p99 (\d+(?:\.\d+)?)ms$/, "p99 $1 ms").replace(/^psi\b/, "PSI")
    }
  }
  return null
}

/** Lowest-arm service below 1 among those carrying the arm; ties keep the earlier one. */
export function worstFor(list, k) {
  let best = null
  let bv = Infinity
  for (const s of list) {
    const v = armOf(s.arms, k)
    if (v != null && v < 1 && v < bv) { best = s; bv = v }
  }
  return best
}

const LABEL = { use: "saturation", red: "errors", sig: "traffic" }

/** "kafka · memory 92%": the worst service for the arm and its measured reason. */
function caption(h, k, v) {
  if (v >= 1) return "all services ok"
  const svc = worstFor(servicesOf(h), k)
  if (!svc) return `${LABEL[k]} ${p100(v)}`
  let reason = reasonFor(svc, k)
  if (!reason && k === "red") {
    // The RED reasons split by arm: show the one that is lower for this service.
    const e = arm(svc.arms, "errors") ?? 1, l = arm(svc.arms, "latency") ?? 1
    reason = `${l < e ? "latency" : "errors"} ${p100(Math.min(e, l))}`
  }
  return `${svc.service} ${reason ?? `${LABEL[k]} ${p100(armOf(svc.arms, k) ?? v)}`}`
}

const NONE = { value: null, now: DASH, caption: DASH, fill: null, met: null }

function card(h, k, goal) {
  const a = armOf(h.arms, k)
  const ring = armRing(a, goal)
  if (!ring) return NONE
  return { ...ring, now: String(Math.round(ring.value)), caption: caption(h, k, a) }
}

export function buildInfra(snap, goals, h = healthOf(snap)) {
  if (!h) return { hasHealth: false, score: null, use: NONE, red: NONE, sig: NONE }
  if (!hasScore(h)) return { hasHealth: true, score: null, use: NONE, red: NONE, sig: NONE }
  const score = num(h.score)
  return {
    hasHealth: true,
    score: score == null ? null : Math.round(score),
    use: card(h, "use", goals.use),
    red: card(h, "red", goals.red),
    sig: card(h, "sig", goals.sig),
  }
}

/** Every service that carries the arm, worst first. */
export function armRows(h, k) {
  return servicesOf(h)
    .flatMap(s => {
      const a = armOf(s.arms, k)
      return a == null ? [] : [{ service: s.service, value: a * 100, score: Math.round(num(s.score) ?? 0), reasons: s.reasons ?? [], stale: !!s.stale }]
    })
    .sort((x, y) => x.value - y.value || x.service.localeCompare(y.service))
}
