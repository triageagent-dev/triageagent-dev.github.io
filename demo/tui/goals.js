// Panel 0 — goals. The web UI's Home dashboard (components/vitals/overview.tsx)
// in terminal dress: the same figures, from a port of lib/vitals/model.ts and
// lib/vitals/infra-model.ts over the payloads the TUI already fetches, drawn as
// boxed sections with SVG rings, bars and bubbles in the TUI palette.
//
// Departures from the UI model, all from the TUI's one-tenant scope: inView is
// the scoped tenant (or none without a registry), and infra health comes from
// status.tenantStats[t].health, the mirror of /v2/tenants/{t}/health without
// its full `services` list (the TUI does not fetch that endpoint).
import { DASH, arr, num, parseSourceKind } from "./api.js";
import { esc, panelTitle } from "./ui.js";
import { CORONA_SPAN, coronaHand, coronaTicks, denseHistory } from "./corona.js";
import { statusBand } from "./band.js";
import { CRITICAL_WEIGHT, GOALS_KEY, armOf, armRing, centreMath, goalsKey, ownGoals, ownGoalsFor, resolveGoals, ringModel, weightedIssues } from "./rings.js";

// ── goals ───────────────────────────────────────────────────────────────────
// The viewer's own goals live in this browser, one set per tenant (rings.js
// goalsKey, shared with mobile); a goal not set here follows the core's for the
// tenant (GET /v2/tenants/{t}/goals), then the built-ins. A browser that has never
// saved goals but holds the removed desktop UI's per-user ones reads those.
const LEGACY_GOALS_KEY = "triage.goals.v1";
export function loadOwnGoals(user, tenant) {
  const read = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  if (read(goalsKey(tenant)) != null || read(GOALS_KEY) != null) return ownGoalsFor(read, tenant);
  try { return ownGoals(JSON.parse(read(`${LEGACY_GOALS_KEY}:${user || "anonymous"}`) || "null")); } catch (e) { return {}; }
}
export function saveOwnGoals(tenant, own) {
  try { localStorage.setItem(goalsKey(tenant), JSON.stringify(own)); } catch (e) { /* private mode */ }
}
// { goals, source }: the goals in force and where each comes from.
export const readGoals = (user, tenant, core) => resolveGoals(loadOwnGoals(user, tenant), core);

// ── model (lib/vitals/model.ts) ─────────────────────────────────────────────
const pct = (f) => (f == null ? DASH : Math.round(f * 100) + "%");
const fin = (v) => (typeof v === "number" && isFinite(v) ? v : undefined);

const RINGS = [
  { k: "use", name: "Saturation", hue: "#22d3ee", r: 70 },
  { k: "red", name: "Reliability", hue: "#e879f9", r: 60 },
  { k: "sig", name: "Traffic", hue: "#8b8bf0", r: 50 },
  { k: "inc", name: "Readiness", hue: "#fbbf24", r: 40 },
];
const SIGNALS = [
  { k: "res", api: "resourcePressure", label: "resource pressure", c: "#22d3ee" },
  { k: "req", api: "RequestErrorAnomaly", label: "request errors", c: "#ef4444" },
  { k: "log", api: "LogErrorAnomaly", label: "log errors", c: "#f59e0b" },
  { k: "evt", api: "podFailure", label: "k8s events", c: "#9184d9" },
  // Alerts a monitoring or cloud provider sent through a connector. A quiet
  // connector is not a heartbeat, so it never turns green either.
  { k: "con", api: "connector", label: "connectors", c: "#60a5fa", neutral: true },
  // Reports from a person or an agent (chat, voice, Teams, a2a, MCP). None
  // is not a health state, so it never turns green.
  { k: "hum", api: "human", label: "h2a/a2a/mcp", c: "#f472b6", neutral: true },
];
// A signal with nothing in its window is the ok state: green, whatever the
// signal; grey is no data. A neutral one (connectors, h2a/a2a/mcp) keeps its own colour,
// since no report is neither.
const sigColor = (s, v) => (v == null ? "var(--faint2)" : v > 0 || s.neutral ? s.c : "var(--ok)");
const SEV_RANK = { critical: 0, warning: 1, info: 2 };

function weightedMean(rows, key) {
  let sum = 0, w = 0;
  rows.forEach((r) => {
    const v = fin(r[key]);
    if (v == null) return;
    const weight = Math.max(1, r.sampledIssues || 1);
    sum += v * weight; w += weight;
  });
  return w ? sum / w : null;
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = Date.UTC(t.getUTCFullYear(), 0, 1);
  return { y: t.getUTCFullYear(), w: Math.ceil(((t.getTime() - y0) / 86400000 + 1) / 7) };
}
const weeksIn = (y) => isoWeek(new Date(Date.UTC(y, 11, 28))).w;
function weekWindow(now, n) {
  let { y, w } = isoWeek(new Date(now));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.unshift({ key: `${y}-W${String(w).padStart(2, "0")}`, label: "W" + w });
    w -= 1;
    if (w < 1) { y -= 1; w = weeksIn(y); }
  }
  return out;
}
function weekStart(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() || 7) - 1) * 86400000;
}
function normWeekKey(k) {
  const m = String(k).match(/(\d{4})-?W?(\d{1,2})/);
  return m ? `${m[1]}-W${m[2].padStart(2, "0")}` : null;
}

const PREFIXES = { use: ["memory", "psi", "oom", "cpu"], red: ["errors", "p99"], sig: ["traffic", "silent"] };
const ARM_LABEL = { use: "saturation", red: "errors", sig: "traffic" };
const p100 = (x) => Math.round(x * 100) + "%";
function reasonFor(svc, k) {
  for (const r of arr((svc || {}).reasons)) {
    const low = String(r).trim().toLowerCase();
    if (PREFIXES[k].some((p) => low.startsWith(p))) return low.replace(/^p99 (\d+(?:\.\d+)?)ms$/, "p99 $1 ms").replace(/^psi\b/, "PSI");
  }
  return null;
}
function worstFor(list, k) {
  let best = null, bv = Infinity;
  list.forEach((s) => { const v = armOf(s.arms, k); if (v != null && v < 1 && v < bv) { best = s; bv = v; } });
  return best;
}
// "kafka memory 92%": the worst service for the arm and its measured reason.
function captionOf(h, k, v) {
  if (v >= 1) return "all services ok";
  const svc = worstFor(arr(h.services).length ? h.services : arr(h.worst), k);
  if (!svc) return `${ARM_LABEL[k]} ${p100(v)}`;
  let reason = reasonFor(svc, k);
  if (!reason && k === "red") {
    const e = fin((svc.arms || {}).errors) ?? 1, l = fin((svc.arms || {}).latency) ?? 1;
    reason = `${l < e ? "latency" : "errors"} ${p100(Math.min(e, l))}`;
  }
  return `${svc.service} ${reason ?? `${ARM_LABEL[k]} ${p100(armOf(svc.arms, k) ?? v)}`}`;
}
function infraOf(h, goals) {
  const none = { now: DASH, caption: DASH, fill: null, met: null };
  if (!h || !((fin(h.scored) || 0) > 0)) return { use: none, red: none, sig: none };
  const card = (k) => {
    const a = armOf(h.arms, k), ring = armRing(a, goals[k]);
    return ring ? { ...ring, now: String(Math.round(ring.value)), caption: captionOf(h, k, a) } : none;
  };
  return { use: card("use"), red: card("red"), sig: card("sig") };
}

const serviceOf = (src) => { const p = String(src || "").split("/").filter(Boolean); return p[p.length - 1] || src || DASH; };
const ordinal = (n) => n + (["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4)] || "th");
function ageShort(iso, now) {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 60) return m + "m";
  const h = Math.round(m / 60);
  return h < 48 ? h + "h" : Math.round(h / 24) + "d";
}
// The signals box window: [key, label, seconds]. The core keeps 24 h of 5 min
// buckets, so 7d cannot be filled yet.
const SIGNAL_WINDOWS = [["1h", "1 h", 3600], ["6h", "6 h", 21600], ["12h", "12 h", 43200], ["24h", "24 h", 86400]];
const SIGWIN_KEY = "triage.signalWindow";
let sigWin = (() => { try { return localStorage.getItem(SIGWIN_KEY) || "24h"; } catch (e) { return "24h"; } })();
export function setSignalWindow(k) {
  sigWin = k;
  try { localStorage.setItem(SIGWIN_KEY, k); } catch (e) { /* private mode */ }
}

export function cycleSignalWindow() {
  const i = SIGNAL_WINDOWS.findIndex(([k]) => k === sigWin);
  setSignalWindow(SIGNAL_WINDOWS[(i + 1) % SIGNAL_WINDOWS.length][0]);
}

// Sums every `n` consecutive buckets so a long window stays at ~72 bars.
function chunkHistory(hist, keys, n) {
  if (n <= 1) return hist;
  const out = [];
  for (let i = 0; i < hist.length; i += n) {
    const c = { t: hist[i].t };
    hist.slice(i, i + n).forEach((b) => keys.forEach((k) => { if (b[k]) c[k] = (c[k] || 0) + b[k]; }));
    out.push(c);
  }
  return out;
}

export function fmtDur(sec) {
  if (sec == null) return DASH;
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h < 24 ? h + "h " + String(m).padStart(2, "0") + "m" : Math.floor(h / 24) + "d " + (h % 24) + "h";
}

// cn is { cluster, ns } (either may be empty): the issues, the not-ready
// apps and the infra rings (raw.scopedHealth, the core's per-scope score) are
// narrowed to it; the zones, signals and predictions stay the tenant's.
export function buildGoals(D, raw, goals, now = Date.now(), cn = {}) {
  const scoped = !!(cn.cluster || cn.ns);
  const inScope = (cluster, ns) => (!cn.cluster || cluster === cn.cluster) && (!cn.ns || ns === cn.ns);
  // Where each service runs (the apps list). An issue or a baseline row whose
  // source names no cluster (a reflection-sourced one) belongs to the scope
  // when the service it is about runs there.
  const places = new Map();
  arr((raw.apps || {}).applications).forEach((a) => {
    const k = a.serviceName || a.namespace;
    if (k) places.set(k, (places.get(k) || []).concat({ cluster: a.cluster || "", ns: a.namespace || "" }));
  });
  const serviceIn = (svc) => (places.get(svc) || []).some((p) => inScope(p.cluster, p.ns));
  const st = raw.status || {};
  const tsMap = (st.tenantStats || {}).tenants || {};
  const scope = D.tenant || "";
  const inView = arr((raw.tenants || {}).tenants).length && scope ? [scope] : [];
  const rows = inView.length ? inView.map((t) => tsMap[t]).filter(Boolean) : Object.values(tsMap);
  const graph = raw.graph || null;
  const nodes = arr((graph || {}).nodes);

  // Where an issue runs: the core's word first (a frame-raised issue is
  // stamped with the instance it was about, ADR-085, or placed by its
  // service's instances), then its source path, then the apps list.
  const issueIn = (i) => {
    const cl = arr(i.clusters).length ? i.clusters : i.cluster ? [i.cluster] : [];
    const ns = arr(i.namespaces).length ? i.namespaces : i.namespace ? [i.namespace] : [];
    if (cl.length || ns.length) return (!cn.cluster || cl.includes(cn.cluster)) && (!cn.ns || ns.includes(cn.ns));
    const sk = parseSourceKind(i.source, i.summary);
    return sk.cluster ? inScope(sk.cluster, sk.ns) : serviceIn(serviceOf(i.source));
  };
  const all = arr((raw.issues || {}).issues).filter((i) => (!scope || !i.tenant || i.tenant === scope) && (!scoped || issueIn(i)));
  const open = all.filter((i) => i.status !== "resolved")
    .sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3) || new Date(b.firstSeen) - new Date(a.firstSeen));
  const crit = open.filter((i) => i.severity === "critical").length;
  const warn = open.filter((i) => i.severity === "warning").length;
  const other = open.length - crit - warn;
  const degraded = arr((raw.apps || {}).applications).filter((a) => !a.ready && inScope(a.cluster || "", a.namespace || "")).length;
  const repeat = weightedMean(rows, "repeatRatePct");

  // Zones: disjoint lifetime totals; drift overlaps and is never summed.
  let zones = null;
  if (rows.length) {
    const z = { noise: 0, unknown: 0, signal: 0, issue: 0, drift: 0 };
    rows.forEach((r) => { const e = r.events || {}; Object.keys(z).forEach((k) => { z[k] += num(e[k]); }); });
    zones = { ...z, total: z.noise + z.unknown + z.signal + z.issue };
  }
  // "vitals now": forecast precision (hits / scored predictions), early
  // detection (warnSec: a correct forecast's lead time; MTTD is in the ? panel) and
  // lead — the share of sampled issues that had precursor signals first.
  const frst = weightedMean(rows.filter((r) => num(r.predictionHits) + num(r.predictionMisses) > 0), "predictionPrecisionPct");
  const leadPct = weightedMean(rows.filter((r) => num(r.sampledIssues) > 0).map((r) => ({ ...r, precursorCoveragePct: num(r.precursorCoveragePct) })), "precursorCoveragePct");
  const lead = weightedMean(rows, "predictionAvgLeadMs");
  const warnSec = lead == null ? null : lead / 1000;
  const since = weekStart(now);
  const rec = all.flatMap((i) => {
    const end = i.status === "resolved" ? Date.parse((i.resolution || {}).resolvedAt || "") : NaN;
    const start = Date.parse(i.firstSeen);
    return end >= since && end >= start ? [(end - start) / 1000] : [];
  });
  const mttrSec = rec.length ? rec.reduce((a, b) => a + b, 0) / rec.length : null;

  // Weeks, on a contiguous ISO calendar.
  const counts = new Map();
  const thisKey = weekWindow(now, 1)[0].key;
  let critical = null;
  arr((raw.analytics || {}).baselines).forEach((b) => {
    if (b.weeklySeverity) {
      critical = critical || 0;
      Object.entries(b.weeklySeverity).forEach(([k, w]) => { if (normWeekKey(k) === thisKey) critical += num((w || {}).critical); });
    }
    const svc = b.service || DASH;
    const m = counts.get(svc) || new Map();
    Object.entries(b.weeklyIssueCounts || {}).forEach(([k, v]) => { const nk = normWeekKey(k); if (nk) m.set(nk, (m.get(nk) || 0) + (v || 0)); });
    counts.set(svc, m);
  });
  const hasWeeks = [...counts.values()].some((m) => m.size > 0);
  const weekly = hasWeeks ? weekWindow(now, 12).map((w) => ({ t: w.label, n: [...counts.values()].reduce((a, m) => a + (m.get(w.key) || 0), 0) })) : [];
  // Issues per deployment and week (core ADR-086): the tenant counts every
  // deployment, a scope its own. An older core without the series falls
  // back to the cluster baselines, or to the issue list for a namespace,
  // which keeps only the most recently resolved ones: a floor.
  const normC = (c) => (c === "default" ? "" : c || "");
  const cnC = normC(cn.cluster);
  const depRows = arr((raw.analytics || {}).deployments);
  const depIn = (c, n) => (!cnC || c === cnC) && (!cn.ns || n === cn.ns);
  let incWeek = weekly.length ? weekly[weekly.length - 1].n : null;
  if (depRows.length) {
    incWeek = 0; critical = 0;
    depRows.filter((d) => depIn(normC(d.cluster), d.namespace || "")).forEach((d) => {
      Object.entries(d.weeklyIssueCounts || {}).forEach(([k, v]) => { if (normWeekKey(k) === thisKey) incWeek += v || 0; });
      Object.entries(d.weeklySeverity || {}).forEach(([k, w]) => { if (normWeekKey(k) === thisKey) critical += num((w || {}).critical); });
    });
  } else if (scoped && !cn.ns) {
    incWeek = 0; critical = 0;
    arr((raw.analytics || {}).baselines).forEach((b) => {
      if (b.cluster ? b.cluster !== cn.cluster : !serviceIn(b.service)) return;
      Object.entries(b.weeklyIssueCounts || {}).forEach(([k, v]) => { if (normWeekKey(k) === thisKey) incWeek += v || 0; });
      Object.entries(b.weeklySeverity || {}).forEach(([k, w]) => { if (normWeekKey(k) === thisKey) critical += num((w || {}).critical); });
    });
  } else if (scoped) {
    const week = all.filter((i) => Date.parse(i.firstSeen) >= since);
    incWeek = week.length;
    critical = week.filter((i) => i.severity === "critical").length;
  }
  const weighted = incWeek == null ? null : weightedIssues(incWeek, critical);
  // The readiness goal is per deployment (cluster and namespace): the view's
  // goal is the goal times the deployments it covers, read from the apps
  // list, so a tenant within goal in every deployment is within goal.
  const deps = new Set();
  arr((raw.apps || {}).applications).forEach((a) => { const c = normC(a.cluster), n = a.namespace || ""; if ((c || n) && depIn(c, n)) deps.add(c + "/" + n); });
  const deployments = Math.max(1, deps.size);

  // The rings and the centre (rings.js, shared with mobile); infra health is
  // one tenant's, so several in view leave the infra rings unknown.
  const pick = scoped ? raw.scopedHealth : rows.length === 1 ? rows[0].health : null;
  const health = pick && (fin(pick.scored) || 0) > 0 ? pick : null;
  const infra = infraOf(health, goals);
  const { fills, measured, avail, attain, goalsMet, incGoal } = ringModel({ arms: health && health.arms, weighted, goals, deployments });
  // The band reads the open issues and the goals together (band.js).
  const { band, meaning: bandMeaning, tone } = statusBand({ crit, warn, other, degraded, repeat, fills, weighted, incGoal });
  const bandCls = { crit: "fg-crit", warn: "fg-warn", watch: "fg-accent", ok: "fg-ok" }[tone];
  const shortest = RINGS.filter((g) => fills[g.k] != null).sort((a, b) => fills[a.k] - fills[b.k])[0] || null;

  const byType = (api) => rows.reduce((a, r) => a + num((r.signalsByType || {})[api]), 0);
  const fleet = SIGNALS.map((s) => ({ ...s, v: byType(s.api) }));
  const histories = rows.map((r) => arr(r.signalsHistory)), apis = SIGNALS.map((s) => s.api);
  const win = SIGNAL_WINDOWS.find(([k]) => k === sigWin) || SIGNAL_WINDOWS[SIGNAL_WINDOWS.length - 1];
  const group = Math.ceil(win[2] / 300 / 72);
  const hist = chunkHistory(denseHistory(histories, apis, now, win[2] / 300), apis, group);
  const clock = denseHistory(histories, apis, now, CORONA_SPAN);

  const byName = new Map(nodes.map((n) => [n.name, n]));
  const nodeFor = (svc) => byName.get(svc) || nodes.filter((n) => svc.startsWith(n.name + "-")).sort((a, b) => b.name.length - a.name.length)[0];
  const downstream = (name) => {
    const seen = new Set([name]), q = [name];
    while (q.length) arr((byName.get(q.shift()) || {}).calledBy).forEach((c) => { if (!seen.has(c)) { seen.add(c); q.push(c); } });
    return seen.size - 1;
  };
  // The 4 most recently opened; the box title keeps the full open count.
  // "open Nh" is this stint: a reopened issue counts from its reopen stamp,
  // not from the first sighting its earlier stint started at.
  const openedAt = (i) => i.reopenedAt || i.firstSeen;
  const live = [...open].sort((a, b) => new Date(openedAt(b)) - new Date(openedAt(a))).slice(0, 4).map((i) => {
    const svc = serviceOf(i.source), node = nodeFor(svc), down = node ? downstream(node.name) : 0;
    // The "Nth time" part is marked (hot) when the panel draws the line.
    const meta = [
      node && node.blastRadius != null ? { t: `blast ${node.blastRadius.toFixed(3)}` } : null,
      node ? { t: `${down} service${down === 1 ? "" : "s"} downstream` } : null,
      i.reopenCount ? { t: `${ordinal(i.reopenCount + 1)} time`, hot: true } : null,
      arr(i.relatedEvents).length ? { t: `${i.relatedEvents.length} related events` } : null,
    ].filter(Boolean);
    if (!meta.length) meta.push({ t: (i.rca || {}).rootCause ? "root cause identified" : "cause unknown" });
    return {
      id: i.id, sev: String(i.severity || "info").toLowerCase(), svc, age: "open " + ageShort(openedAt(i), now), meta,
      summary: String(i.summary || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || (i.rca || {}).rootCause || DASH,
    };
  });

  const reasons = [crit ? `${crit} critical` : "", warn ? `${warn} warning` : "", other ? `${other} open` : "",
    degraded ? `${degraded} not ready` : "", repeat ? `repeat rate is ${Math.round(repeat)}%` : ""].filter(Boolean);
  const repeater = open.find((i) => i.reopenCount);
  const state = reasons.length
    ? `${band}: ${reasons.join(", ")}${repeater ? ` — ${serviceOf(repeater.source)} came back ${ordinal((repeater.reopenCount || 0) + 1)} time` : ""}.`
    : "All clear: nothing open, nothing degraded, nothing repeating.";
  const insight = shortest ? `${state} Against your goals, ${shortest.name.toLowerCase()} is the short ring at ${pct(fills[shortest.k])}.` : state;

  const predictions = arr((raw.analytics || {}).precursorMatches).map((m) => {
    const c = m.confidence || 0;
    const steps = m.totalSteps ? `${m.matchedSteps}/${m.totalSteps} precursor steps matched` : "precursor pattern matched";
    return { svc: m.service || DASH, cluster: m.cluster || "", env: [m.cluster, m.tenant].filter(Boolean).join(" · "),
      p: Math.max(0, Math.min(100, Math.round(c <= 1 ? c * 100 : c))), why: steps + (m.activeIssue ? " — issue already open" : "") };
  }).sort((a, b) => b.p - a.p).slice(0, 6);

  const heat = weekWindow(now, 8);
  const heatRows = [...counts.entries()]
    .map(([n, m]) => { const v = heat.map((w) => m.get(w.key) || 0); return { n, v, total: v.reduce((a, b) => a + b, 0) }; })
    .filter((r) => r.total > 0).sort((a, b) => b.total - a.total).slice(0, 8);

  return {
    hasData: !!raw.status, band, bandMeaning, bandCls, openCount: open.length, degraded,
    zones, frst, leadPct, warnSec, mttrSec, infra, fills, measured, avail, incWeek, weighted, critical, weekly, attain, goalsMet, goals, incGoal, deployments,
    fleet, hist, sigWin: { k: win[0], group }, clock, now, live, insight, predictions, heatWeeks: heat.map((w) => w.label), heatRows,
    nodes, scopeLabel: scoped ? [cn.cluster, cn.ns].filter(Boolean).join("/") : "",
  };
}

// ── drawing ─────────────────────────────────────────────────────────────────
// title: text, or { html } already escaped (the tenant name in its colour).
const box = (title, right, body, cls = "", attrs = "") =>
  `<section class="gbox ${cls}"${attrs}><div class="ghead"><span class="gt">${typeof title === "object" ? title.html : esc(title)}</span><span class="fill"></span>${right ? `<span class="gr">${right}</span>` : ""}</div>${body}</section>`;
// A box that opens the goals editor (panel 8) when clicked.
const TO_GOALS = ` data-act="gopanel" data-v="gset" style="cursor:pointer"`;
const loc = (n) => (n == null ? DASH : Number(n).toLocaleString());

function ringsSvg(m) {
  const ticks = (() => {
    if (!m.clock.length) return "";
    const xy = (t) => `x1="${t.x1.toFixed(1)}" y1="${t.y1.toFixed(1)}" x2="${t.x2.toFixed(1)}" y2="${t.y2.toFixed(1)}"`;
    return coronaTicks(m.clock, SIGNALS, 20).map((t) => t.segs.length
      ? t.segs.map((g) => `<line ${xy(g)} stroke="${g.sig.c}" stroke-width="1.7" stroke-opacity="${g.op}"/>`).join("")
      : `<line ${xy(t)} stroke="${t.alive ? "var(--ok)" : "var(--faint2)"}" stroke-width="1.7" stroke-linecap="round" stroke-opacity="${t.op}"/>`).join("") +
      `<line ${xy(coronaHand(m.now, 105))} stroke="var(--strong)" stroke-width="2.2" stroke-linecap="round"><title>now</title></line>`;
  })();
  const tracks = RINGS.map((g) => `<circle cx="100" cy="100" r="${g.r}" fill="none" stroke="var(--rule)" stroke-width="8"/>`).join("");
  const arcs = RINGS.filter((g) => m.fills[g.k] != null).map((g) => {
    const c = 2 * Math.PI * g.r, f = m.fills[g.k];
    // A met ring is a plain closed circle: round caps overlapping at the seam
    // leave a notch. A short one starts and ends on its true angles: the caps
    // reach half a stroke past the dash, so the dash is shortened by a stroke
    // and begun half a stroke in.
    if (f >= 0.999) return `<circle cx="100" cy="100" r="${g.r}" fill="none" stroke="${g.hue}" stroke-width="8"><title>${g.name} ${pct(f)}</title></circle>`;
    const dash = Math.max(0.1, f * c - 8);
    return `<circle cx="100" cy="100" r="${g.r}" fill="none" stroke="${g.hue}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${(c - dash).toFixed(1)}" stroke-dashoffset="-4"><title>${g.name} ${pct(f)}</title></circle>`;
  }).join("");
  return `<div class="gring">
    <svg viewBox="-15 -15 230 230" style="transform:rotate(-90deg)">${ticks}${tracks}${arcs}</svg>
    <div class="gcentre"><span class="gbig">${esc(m.attain)}</span></div>
  </div>`;
}

// A bar of █/░ cells is the terminal's own gauge; the coloured span keeps the hue.
function cellBar(fill, width, hue) {
  if (fill == null) return `<span class="fg-faint2">${"·".repeat(width)}</span>`;
  const n = Math.max(fill > 0 ? 1 : 0, Math.round(fill * width));
  return `<span style="color:${hue}">${"█".repeat(n)}</span><span class="fg-faint2">${"░".repeat(width - n)}</span>`;
}

// The mobile goal tiles (mobile/components/vitals.js VitalTiles):
// 2x2, each filled to its progress (solid when met), a big number and the
// goal line; the worst service is named while an arm is short.
const TILES = [
  { k: "use", name: "Saturation", what: "memory, stalls, OOM", tip: "Memory against its limit, CPU, memory and I/O pressure stalls, and OOM kills", icon: "ph-cpu", c1: "#1f8496", c1x: "#166a7a", c2: "#0c2733", tint: "#eafcff", iconFg: "#67e8f9" },
  { k: "red", name: "Reliability", what: "errors, p99 latency", tip: "Request errors and p99 latency", icon: "ph-gauge", c1: "#a5449a", c1x: "#88357f", c2: "#331336", tint: "#fdeeff", iconFg: "#f0abfc" },
  { k: "sig", name: "Traffic", what: "vs own baseline", tip: "Traffic against each service's own baseline", icon: "ph-waveform", c1: "#6355d6", c1x: "#4a3cb4", c2: "#1e1a3d", tint: "#efeeff", iconFg: "#b3aef8" },
  { k: "inc", name: "Readiness", what: "issues this week", tip: "Issues opened this week against your goal, a critical counting as 3", icon: "ph-chart-bar", c1: "#b8741a", c1x: "#94590f", c2: "#3a2508", tint: "#fff7e6", iconFg: "#fcd34d" },
];
function goalRows(m) {
  const g = m.goals;
  const armGoal = (c, goal) => (c.met === false && c.caption !== DASH ? `goal ${goal} · ${c.caption}` : `goal ${goal}`);
  const incGoalText = `goal ≤ ${m.incGoal}/wk` + (m.deployments > 1 ? ` (${m.deployments} × ${g.inc})` : "");
  // Weighted count against the view's goal first, so a narrow tile still
  // shows the goal; the full working is in the tooltip.
  const incLine = m.weighted == null ? incGoalText
    : `${m.weighted} / ${m.incGoal} this week${m.critical ? ` · ${m.critical} crit` : ""}`;
  const vals = {
    use: { now: m.infra.use.now, goal: armGoal(m.infra.use, g.use) },
    red: { now: m.infra.red.now, goal: armGoal(m.infra.red, g.red) },
    sig: { now: m.infra.sig.now, goal: armGoal(m.infra.sig, g.sig) },
    inc: { now: pct(m.fills.inc), goal: incLine },
  };
  return `<div class="gtiles">${TILES.map((v) => {
    const fill = m.fills[v.k], { now, goal } = vals[v.k];
    const met = fill != null && fill >= 0.999;
    const p = fill == null ? 0 : Math.max(6, Math.min(100, Math.round(fill * 100)));
    const bg = fill == null ? v.c2 : met ? `linear-gradient(160deg,${v.c1},${v.c1x})`
      : `linear-gradient(90deg,${v.c1} 0%,${v.c1} ${p}%,rgba(255,255,255,.45) ${p}%,rgba(255,255,255,.45) ${p + 0.6}%,${v.c2} ${p + 0.6}%,${v.c2} 100%)`;
    return `<div class="gtile" style="background:${bg}">
      <span class="gtn"><i class="ph-fill ${v.icon}" style="color:${v.iconFg}"></i>${v.name}</span>
      <span class="gtw" title="${esc(v.tip)}">${esc(v.what)}</span>
      <span class="gtv" style="color:${fill == null ? v.iconFg : "#fff"}">${esc(now)}</span>
      <span class="gtg">${esc(goal)}</span>
    </div>`;
  }).join("")}</div>`;
}

function vitalsNow(m) {
  const items = [
    ["awareness", m.frst == null ? DASH : Math.round(m.frst) + "%"],
    ["early warn", fmtDur(m.warnSec)],
    ["lead", m.leadPct == null ? DASH : Math.round(m.leadPct) + "%"],
  ];
  return `<div class="gvit">${items.map(([k, v]) => `<div class="gcell"><span class="fg-dim">${k}</span><span class="fg-strong">${esc(v)}</span></div>`).join("")}</div>`;
}

// The service graph as a ring: nodes on a circle (by name), edges as chords,
// nodes coloured by blast radius against the graph's own thresholds. Panel 1
// shows it while no application is selected.
// focus, when given, names the nodes in view; the rest are drawn as context.
export function graphSvg(graph, focus) {
  const nodes = arr((graph || {}).nodes);
  if (!nodes.length) return `<div class="empty">no service graph</div>`;
  const inc = num((graph || {}).issueThreshold, 0.25), noise = num((graph || {}).noiseThreshold, 0.015);
  const sorted = [...nodes].sort((a, b) => (a.name < b.name ? -1 : 1));
  const pos = new Map(sorted.map((n, i) => {
    const a = (i / sorted.length) * Math.PI * 2 - Math.PI / 2;
    return [n.name, { x: 150 + Math.cos(a) * 92, y: 110 + Math.sin(a) * 92, a }];
  }));
  const edges = sorted.flatMap((n) => arr(n.calls).filter((c) => pos.has(c)).map((c) => {
    const p = pos.get(n.name), q = pos.get(c);
    return `<path d="M${p.x.toFixed(1)},${p.y.toFixed(1)} Q150,110 ${q.x.toFixed(1)},${q.y.toFixed(1)}" fill="none" stroke="var(--rule2)" stroke-width="0.7"/>`;
  })).join("");
  const dots = sorted.map((n) => {
    const p = pos.get(n.name), b = num(n.blastRadius, 0);
    const c = b >= inc ? "var(--crit)" : b >= noise ? "var(--warn)" : "var(--faint)";
    const r = 2.5 + Math.min(1, b / Math.max(inc, 0.001)) * 3.5;
    const lx = 150 + Math.cos(p.a) * 104, ly = 110 + Math.sin(p.a) * 104;
    const anchor = Math.abs(Math.cos(p.a)) < 0.2 ? "middle" : Math.cos(p.a) > 0 ? "start" : "end";
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${c}"><title>${esc(n.name)} · blast ${b.toFixed(3)}</title></circle>` +
      (sorted.length <= 40 ? `<text x="${lx.toFixed(1)}" y="${(ly + 2.5).toFixed(1)}" text-anchor="${anchor}" class="glabel${focus && !focus.has(n.name) ? " ctx" : ""}">${esc(n.name)}</text>` : "");
  }).join("");
  return `<svg class="ggraph" viewBox="-30 0 360 220">${edges}${dots}</svg>
    <div class="gl gsmall"><span class="fill"></span><span class="fg-crit">● issue ≥${inc}</span>&nbsp; <span class="fg-warn">● signal ≥${noise}</span>&nbsp; <span class="fg-faint">● noise</span></div>`;
}

function sparkSvg(series, color) {
  const max = Math.max(1, ...series);
  return `<svg class="gspark" viewBox="0 0 ${series.length * 3} 20" preserveAspectRatio="none">${series.map((v, i) => {
    const h = v ? Math.max(1.5, (v / max) * 20) : 0.6;
    return `<rect x="${i * 3}" y="${(20 - h).toFixed(1)}" width="2.2" height="${h.toFixed(1)}" fill="${v ? color : "var(--rule2)"}"/>`;
  }).join("")}</svg>`;
}

// Solid fill + lighter rim, stepped by percentage so neighbouring risks read
// apart: fuchsia, pink, orange, amber, cyan, violet, slate — no alarm reds.
const BUBBLE_TONES = [
  [95, "#c026d3", "#f0abfc"], [80, "#db2777", "#f9a8d4"], [70, "#ea580c", "#fdba74"],
  [50, "#d97706", "#fcd34d"], [30, "#0891b2", "#67e8f9"], [15, "#6355d6", "#b3aef8"], [0, "#475569", "#94a3b8"],
];
export const bubbleTone = (p) => { const t = BUBBLE_TONES.find(([min]) => p >= min); return [t[1], t[2]]; };

function bubbles(m) {
  if (!m.predictions.length) return `<p class="para fg-dim"><span class="fg-ok">✓</span> No precursor matches for this tenant — nothing is currently trending toward an issue.</p>`;
  const svgs = m.predictions.map((p) => {
    const r = 22 + p.p * 0.2;
    const tone = bubbleTone(p.p);
    const d = r * 2 + 4;
    return `<svg width="${d}" height="${d}" viewBox="0 0 ${d} ${d}" data-act="predjump" data-svc="${esc(p.svc)}" data-cluster="${esc(p.cluster)}" style="cursor:pointer"><title>${esc(p.svc)} · ${esc(p.env)} — ${esc(p.why)}</title>
      <circle cx="${d / 2}" cy="${d / 2}" r="${r}" fill="${tone[0]}" stroke="${tone[1]}" stroke-width="1.5"/>
      <text x="${d / 2}" y="${d / 2 - 1}" text-anchor="middle" class="gbub" fill="#ffffff">${p.p}%</text>
      <text x="${d / 2}" y="${d / 2 + 12}" text-anchor="middle" class="glabel" style="fill:#ffffff">${esc(p.svc.length > 9 ? p.svc.slice(0, 8) + "…" : p.svc)}</text></svg>`;
  }).join("");
  const top = m.predictions[0];
  return `<div class="gbubs">${svgs}</div><p class="para fg-dim">${esc(top.svc)}${top.env ? " · " + esc(top.env) : ""} — ${esc(top.why)}</p>`;
}

// Panel 8, setting the goals — the mobile Goals screen's words: what the
// frameworks mean, what each ring measures, a start from today's numbers,
// then one row per goal with its value and whose it is. j/k pick a goal, h/l
// change it (it becomes the viewer's own), a adopts today's numbers, r gives
// one back to the tenant's, R all of them.
const SOURCE_LABEL = { own: "yours", tenant: "tenant", default: "default" };
const TERMS = [
  ["USE", "utilisation · saturation · errors", "A method for resources such as CPU, memory and disks: how busy each is, how much work is queued behind it, and how often it fails."],
  ["RED", "rate · errors · duration", "A method for services: requests per second, how many of them fail, and how long they take."],
  ["Golden signals", "latency · traffic · errors · saturation", "The four signals to watch on any service: response time, demand, failure rate, and how full the service is."],
];
const WHAT = {
  use: "Saturation: memory against its limit, CPU, memory and I/O pressure stalls, and OOM kills across your services. 100 means nothing is under pressure.",
  red: "Request errors and p99 latency combined, errors weighing a little more. 100 means every service answers cleanly and fast.",
  sig: "Traffic against each service's own baseline. 100 means no service has gone quiet or fallen away.",
};
// adoptable is { use, red, sig } from today's arms (whole numbers, 50–100),
// or null when the tenant has not reported infra health.
export function adoptableGoals(D, raw, goals) {
  const m = buildGoals(D, raw, goals);
  const out = {};
  ["use", "red", "sig"].forEach((k) => { const v = m.infra[k].value; if (v != null) out[k] = Math.max(50, Math.min(100, Math.floor(v))); });
  return Object.keys(out).length ? out : null;
}
export function goalsSetPanel(D, raw, gr, edit) {
  const { goals, source } = gr;
  const m = buildGoals(D, raw, goals);
  const sel = edit ? edit.i : 0;
  const terms = box("USE · RED · Signals framework", "", TERMS.map(([k, means, note]) =>
    `<div class="gterm"><div><span class="fg-strong">${k}</span> <span class="fg-dim">· ${means}</span></div><div class="fg-dim gsmall">${note}</div></div>`).join(""));
  const intro = `<p class="para fg-dim">A ring closes when its arm of infra health meets the goal. These are the promises you make to the people you serve — not defaults from us. The word under the rings is separate: it only reflects what is open or degraded right now.</p>`;
  const now = (k) => m.infra[k].now;
  const canAdopt = ["use", "red", "sig"].some((k) => m.infra[k].value != null);
  const adopt = box("start from what you do today", `<button type="button" class="glink" data-act="key" data-k="a"${canAdopt ? "" : " disabled"}>a adopt</button>`,
    `<p class="para fg-dim">${canAdopt
      ? `Sets USE ${esc(now("use"))}, RED ${esc(now("red"))} and SIG ${esc(now("sig"))} — this tenant's current numbers. Then tighten one at a time.`
      : "This tenant has not reported any infra health yet, so there is nothing to start from."}</p>`);
  const incWhat = m.critical != null && m.incWeek != null
    ? `Your goal ÷ issues opened this week, up to 100%. This week: ${m.incWeek} issues, ${m.critical} critical; a critical counts as ${CRITICAL_WEIGHT}, so ${m.weighted} against a goal of ${m.incGoal}${m.deployments > 1 ? ` (${m.deployments} deployments × ${goals.inc})` : ""}.`
    : `Your goal ÷ issues opened this week, up to 100%. A critical counts as ${CRITICAL_WEIGHT}; the goal is per deployment.`;
  const rows = RINGS.map((g, i) => {
    const on = i === sel, goal = goals[g.k];
    const nowV = g.k === "inc" ? pct(m.fills.inc) : now(g.k);
    const stepBtn = (d, t) => `<button type="button" class="gestep" data-act="goalstep" data-i="${i}" data-d="${d}" aria-label="${d < 0 ? "lower" : "raise"} ${g.name} goal">${t}</button>`;
    return `<div class="gset${on ? " sel" : ""}" data-act="goalsel" data-i="${i}">
      <div class="gl gerow"><span style="color:${g.hue}">${on ? "▸" : "●"}</span><span class="gen">${g.name}</span>
      ${stepBtn(-1, "−")}<span class="gev fg-strong">${g.k === "inc" ? "≤ " + goal + "/wk" : goal}</span>${stepBtn(1, "+")}
      <span class="${source[g.k] === "own" ? "fg-accent" : "fg-dim"}">${SOURCE_LABEL[source[g.k]]}</span><span class="fill"></span><span class="fg-dim">now ${esc(nowV)}</span></div>
      <div class="fg-dim gsmall gwhat">${esc(g.k === "inc" ? incWhat : WHAT[g.k])}</div>
    </div>`;
  }).join("");
  const m3 = m.measured || {};
  const math = centreMath(m3, m.fills.inc, m.avail);
  const anyOwn = Object.values(source).includes("own");
  const setBox = box("goals", `<span class="${m.goalsMet === "all met" ? "fg-ok" : "fg-dim"}">${esc(m.goalsMet)}</span>`,
    rows +
    `<div class="gl gattain"><span class="gbig">${esc(m.attain)}</span><span class="col"><span>At these goals · ${esc(m.goalsMet)}</span><span class="fg-dim gsmall">${esc(math)}</span></span></div>` +
    `<div class="fg-dim gsmall">${anyOwn ? "The goals you set are stored in this browser. R goes back to the tenant's." : "These are the tenant's goals. One you change becomes yours, stored in this browser."}</div>` +
    `<div class="fg-faint gsmall">j/k goal · h/l change · a today's numbers · r the tenant's · R all · esc back</div>`);
  return `<div class="tbar">${panelTitle("goals", D.tenant)}</div><div class="goals gsetp"><div class="gsetcols"><div class="gcol">${setBox}</div><div class="gcol">${terms}${intro}${adopt}</div></div></div>`;
}

// gr is readGoals(): { goals, source }. edit is the editor's state ({ i }),
// or null while it is closed.
export function goalsPanel(D, raw, gr, cn = {}) {
  const { goals } = gr;
  const m = buildGoals(D, raw, goals, Date.now(), cn);
  // Under the rings: the applications by state, as panel 2's filters count
  // them; each opens panel 2 on that state. The signals box below already
  // carries the signal counts.
  const C = (D.apps || {}).counts || {};
  const appStates = [["Apps", C.all, "", "var(--dim)"], ["healthy", C.ready, "ready", "var(--ok)"], ["unhlth", C.notReady, "not-ready", "var(--crit)"],
    ["unknown", C.unknown, "unknown", "var(--faint2)"], ["drift", C.drift, "drift", "var(--faint2)"], ["virtual", C.virtual, "virtual", "var(--accent)"]]
    .filter(([k, n]) => n != null && (n > 0 || k === "Apps" || k === "healthy" || k === "unhlth"));
  const fleet = `<div class="gl gfleet">${appStates.map(([k, n, v, c]) => `<span data-act="appfilt" data-v="${v}" style="cursor:pointer"><span style="color:${c}">●</span> ${k} <span class="fg-strong">${loc(n)}</span></span>`).join("")}</div>`;
  const fleetBox = box({ html: (D.tenant ? `<span class="fg-label">${esc(D.tenant)}</span>` : "goals") + esc((m.scopeLabel ? " · " + m.scopeLabel : "") + " score") }, `<span class="fg-faint">${m.hist.length ? "last 12 h · 5 min ticks" : "no signal history yet"}</span>`,
    ringsSvg(m) +
    `<div class="gband ${m.bandCls}">${m.hasData ? esc(m.band.toUpperCase()) : DASH}</div><div class="gmean fg-dim">${esc(m.hasData ? m.bandMeaning : "waiting for the core")}</div>` +
    fleet, "", TO_GOALS);

  const strip = `<div class="gstrip">${RINGS.map((g) => { const f = m.fills[g.k]; return `<span style="background:${f == null ? "var(--rule)" : f >= 0.999 ? g.hue : `linear-gradient(90deg,${g.hue} ${Math.round(f * 100)}%,var(--rule) ${Math.round(f * 100)}%)`}"></span>`; }).join("")}</div>`;
  const mid = box("goals", `<span class="${m.goalsMet === "all met" ? "fg-ok" : "fg-dim"}">${esc(m.goalsMet)}</span>`,
    goalRows(m) + strip, "", TO_GOALS);
  const predBox = box("predictions", "", vitalsNow(m));

  const sevCls = (s) => (s === "critical" ? "fg-crit" : s === "warning" ? "fg-warn" : "fg-info");
  const sevTag = (s) => (s === "critical" ? "CRIT" : s === "warning" ? "WARN" : "INFO");
  const issues = !m.hasData ? "" : m.openCount > 0
    ? box(`${m.openCount} open issue${m.openCount === 1 ? "" : "s"}`, "",
      m.live.map((i) => `<div class="ginc ${sevCls(i.sev)}" data-act="conjump" data-id="${esc(i.id)}" style="cursor:pointer">
        <div class="gl"><span class="${sevCls(i.sev)}">[${sevTag(i.sev)}]</span>&nbsp;<span class="fg-strong">${esc(i.svc)}</span><span class="fill"></span><span class="${sevCls(i.sev)}">${esc(i.age)}</span></div>
        <div class="fg-text">${esc(i.summary)}</div>
        <div class="fg-dim gsmall">${i.meta.map((x) => (x.hot ? `<span class="fg-warn b">${esc(x.t)}</span>` : esc(x.t))).join(" · ")}</div></div>`).join(""), "gcrit")
    : box("nothing open", "", `<p class="para"><span class="fg-ok">✓</span> ${m.zones ? loc(m.zones.total) : 0} events triaged${m.degraded ? ` with no issue open — but ${m.degraded} workload${m.degraded === 1 ? " is" : "s are"} not ready.` : " and none of them needs you now."}</p>`);
  const right = issues;

  const winBar = SIGNAL_WINDOWS.map(([k]) => `<button type="button" class="filt${m.sigWin.k === k ? " on" : ""}" data-act="sigwin" data-v="${k}">${k}</button>`).join("");
  const signals = box(`signals · last ${m.sigWin.k} · ${5 * m.sigWin.group}m/bucket`, winBar, SIGNALS.map((s) => {
    const series = m.hist.map((b) => b[s.api] || 0);
    const v = m.fleet.find((f) => f.k === s.k).v, c = sigColor(s, v);
    return `<div class="gl gsigrow"><span style="color:${c}" class="gsl">${esc(s.label)}</span><span class="fg-strong gsv">${loc(v)}</span>${series.length ? sparkSvg(series, c) : `<span class="fg-faint2">no history</span>`}</div>`;
  }).join(""));
  const breakBox = box("what is about to break", `<span class="fg-dim">${m.predictions.length ? `${m.predictions.length} ranked` : "no matches"}</span>`, bubbles(m));

  return `<div class="goals">
    <div class="grow3">
      <div class="gcol">${fleetBox}</div><div class="gcol gmid">${mid}${predBox}</div><div class="gcol gright">${breakBox}${right}</div><div class="gcol gsigs">${signals}</div>
    </div>
  </div>`;
}
