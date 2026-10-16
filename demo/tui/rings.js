// The goal rings and the centre: one model for the TUI (goals.js) and mobile
// (mobile/model/vitals.js, health.js). The core brings the facts (the health
// arms, the week's issue count, the tenant's goals); which goals are in force
// and everything computed against them is the viewer's own, here.

export const GOAL_KEYS = ["use", "red", "sig", "inc"];
export const DEFAULT_GOALS = { use: 90, red: 95, sig: 90, inc: 10 };
export const INC_MAX = 1000;
// A critical issue (an error, something down) counts as this many against the
// weekly goal; a warning or info as one.
export const CRITICAL_WEIGHT = 3;
// Where the viewer's own goals are kept (localStorage, per browser). One set
// per tenant, under GOALS_KEY:<tenant>; the bare key is the set kept before
// goals were per tenant, which a tenant with no set of its own still reads.
export const GOALS_KEY = "triage.goals";
export const goalsKey = (tenant) => (tenant ? `${GOALS_KEY}:${tenant}` : GOALS_KEY);

// The core names the goals after the rings; an older core used the short keys.
const CORE_NAMES = { use: "capacity", red: "reliability", sig: "traffic", inc: "readiness" };

const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// The centre's working, in words: the rings averaged, times readiness, times
// availability when something is down. `m3` is ringModel's `measured`.
export function centreMath(m3, readiness, avail) {
  const p = (v) => (v == null ? "—" : Math.round(v * 100) + "%");
  return `avg(USE ${p(m3.use)}, RED ${p(m3.red)}, SIG ${p(m3.sig)}) × readiness ${p(readiness)}` + (avail != null && avail < 0.995 ? ` × up ${p(avail)}` : "");
}

// Saturation, reliability and traffic are whole percents, 50..100; readiness is
// issues per week, 0..INC_MAX in halves.
export const goalOk = (k, v) => typeof v === "number" && (k === "inc"
  ? v >= 0 && v <= INC_MAX && Number.isInteger(v * 2)
  : Number.isInteger(v) && v >= 50 && v <= 100);

// The goals the viewer set, from what the browser stored: only the valid
// fields, so a goal never set is absent and follows the tenant's. The old
// shape ({clarity, warn, mttr}) has none of them.
export function ownGoals(stored) {
  const o = stored && typeof stored === "object" ? stored : {};
  const out = {};
  GOAL_KEYS.forEach((k) => { if (goalOk(k, o[k])) out[k] = o[k]; });
  return out;
}

// The viewer's own goals for a tenant: its own set, else the bare one from
// before goals were per tenant (its raw stored value, parsed), else none.
// `read(key)` is the stored string or null. An empty set is a choice (the
// tenant's goals), so it counts as stored.
export function ownGoalsFor(read, tenant) {
  const parse = (k) => { try { return JSON.parse(read(k) || "null"); } catch (_) { return null; } };
  const mine = tenant ? parse(goalsKey(tenant)) : null;
  return ownGoals(mine && typeof mine === "object" ? mine : parse(GOALS_KEY));
}

// The goals in force, per goal: the viewer's own, else the core's for the
// tenant (GET /v2/tenants/{t}/goals: the tenant's cell, or the core's
// default), else the built-in. `source` says which: "own", "tenant" or
// "default".
export function resolveGoals(own, core) {
  const goals = {}, source = {};
  const src = (core && core.source) || {};
  GOAL_KEYS.forEach((k) => {
    const name = core && CORE_NAMES[k] in core ? CORE_NAMES[k] : k;
    if (own && goalOk(k, own[k])) { goals[k] = own[k]; source[k] = "own"; }
    else if (core && goalOk(k, core[name])) { goals[k] = core[name]; source[k] = src[name] === "cell" ? "tenant" : "default"; }
    else { goals[k] = DEFAULT_GOALS[k]; source[k] = "default"; }
  });
  return { goals, source };
}

// One arm (0..1) from the core's health arms. Reliability is errors and
// latency together, errors weighing a little more: (0.3 e + 0.25 l) / 0.55;
// both must be present.
export function armOf(arms, k) {
  if (!arms) return undefined;
  if (k === "use") return fin(arms.saturation);
  if (k === "sig") return fin(arms.traffic);
  const e = fin(arms.errors), l = fin(arms.latency);
  return e == null || l == null ? undefined : clamp01((0.3 * e + 0.25 * l) / 0.55);
}

// One infra ring: the measured arm as a percent, its ring (closed at the
// goal) and whether the goal is met. Null when the arm is unknown.
export function armRing(a, goal) {
  if (a == null) return null;
  const value = a * 100;
  return { value, fill: Math.min(1, value / Math.max(1, goal)), met: value >= goal };
}

// This week's issues as counted against the goal.
export const weightedIssues = (count, critical) => count + (CRITICAL_WEIGHT - 1) * (critical || 0);

// The readiness ring: closed while the week's weighted count is within the
// goal, goal / count once over it. Null when the count is unknown.
export const incFill = (weighted, goal) => (weighted == null ? null : weighted <= goal ? 1 : clamp01(goal / weighted));

// The rings and the centre. `arms` is the health block's arms (null when the
// core scored nothing), `weighted` the week's weighted issue count (null when
// unknown), `deployments` how many deployments (cluster and namespace) the
// view covers: the readiness goal is per deployment, so the view's goal is
// the goal times that count, and a tenant within goal in every deployment
// is within goal (ADR-086).
//
//   fills     each ring, 0..1, null when unknown
//   measured  the infra arms as measured, 0..1
//   incGoal   the view's readiness goal: goals.inc × deployments
//   avail     the core's availability arm, 0..1, null when unknown
//   score     the centre: the measured arms averaged, times availability, times the readiness
//             ring. The arms count as measured, not as rings, so an arm over
//             its goal but short of 100 still shows; a readiness goal set
//             out of reach takes nothing off.
//   attain    the centre as text, floored so a point short never reads 100%
//   goalsMet  "all met", "3 of 4 met", "no data yet"
export function ringModel({ arms = null, weighted = null, goals, deployments = 1 }) {
  const rings = {}, fills = {}, measured = {};
  ["use", "red", "sig"].forEach((k) => {
    const r = armRing(armOf(arms, k), goals[k]);
    rings[k] = r;
    fills[k] = r ? r.fill : null;
    measured[k] = r ? r.value / 100 : null;
  });
  const incGoal = goals.inc * Math.max(1, Math.trunc(deployments) || 1);
  fills.inc = incFill(weighted, incGoal);
  const got = Object.values(measured).filter((v) => v != null);
  // Services that are not ready sit in no ring (a down service reports no
  // telemetry), so the core's availability arm takes its share off the centre.
  const a = fin(arms && arms.availability), avail = a == null ? null : clamp01(a);
  const score = !got.length && fills.inc == null ? null
    : (got.length ? got.reduce((x, y) => x + y, 0) / got.length : 1) * (fills.inc ?? 1) * (avail ?? 1);
  const known = Object.values(fills).filter((f) => f != null);
  const met = known.filter((f) => f >= 0.999).length;
  return {
    rings, fills, measured, avail, score, incGoal,
    attain: score == null ? "—" : Math.floor(score * 100 + 1e-9) + "%",
    met, known: known.length,
    goalsMet: !known.length ? "no data yet" : met === known.length ? "all met" : `${met} of ${known.length} met`,
  };
}

// One step of a goal from the editors: a percent goal moves by 1 within
// 50..100; readiness by 1, by 5 once past 20, so a large goal is reachable.
export function stepGoal(k, v, d) {
  if (k !== "inc") return Math.max(50, Math.min(100, v + d));
  return Math.max(0, Math.min(INC_MAX, v + d * (v + (d < 0 ? -1 : 0) >= 20 ? 5 : 1)));
}
