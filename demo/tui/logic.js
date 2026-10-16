// Panel 7 — logic: the triage pipeline and its loops as a ring, in the style
// of the service graph (panel 2): memory in the centre, the components on
// an oval ring, flows as chords, with the live counts and the windows the core
// runs right now, read off the /v2/agent/status blob (loops,
// guardrailStats, classifierStats, reflexRules, rsi, policy, notify,
// tenantStats). Dot size follows weight: the classifier is the main system 1
// and the largest.
// Tiers are coloured: reflex (no model), the flash model, system 1 (the
// classifier, and Jev, the decision model), system 2 (the reasoning loop).
import { esc, panelTitle } from "./ui.js";
import { limitsByKind } from "./usage.js";

const W = 1240, H = 720, CX = 620, CY = 360, RX = 310, RY = 250, MEM_R = 96;
// The right-hand labels run about 90 units wider than the left-hand ones, so the
// frame starts this far in to put the drawing, not just the ring, mid-pane.
const PAD_X = 44;
const TIER = {
  reflex: ["reflex · 0 tokens", "var(--dim)"],
  s1: ["model · flash", "#a78bfa"],
  sys1: ["system one · embedding", "#22d3ee"],
  jev: ["system one · jev", "#22d3ee"],
  shield: ["interrupt shield", "#f472b6"],
  s2: ["system two · reasoning", "#fbbf24"],
  s2rfl: ["system two · reflection", "#fbbf24"],
  s2rsi: ["system two · RSI", "#fbbf24"],
  cfg: ["config", "var(--faint)"],
};

// Paths p cycles through: the components each one runs through, and memory,
// which every path reads or writes. The rest of the ring dims while a path is
// shown.
export const PATHS = ["all", "system one", "system two", "jev", "llm"];
const PATH_IDS = {
  "system one": ["src", "s0", "gr", "cls", "rt", "iss", "rr", "prog", "is"],
  "system two": ["iss", "rfl", "rsn", "rsi"],
  jev: ["gr", "rt", "iss", "is"],
  llm: ["rt", "rfl", "rsn", "rsi"],
};

const n = (v) => (v == null ? "—" : Number(v).toLocaleString());
// "3h0m0s" → "3h", "30m0s" → "30m", "0s" → "off".
export function dur(s) {
  if (!s || s === "0s") return "off";
  const out = String(s).replace(/(\d)h0m0s$/, "$1h").replace(/(\d)m0s$/, "$1m").replace(/h0m/, "h");
  return out;
}

// The scoped tenant's stats, or all tenants summed.
export function tenantSum(st, tenant) {
  const all = (st.tenantStats || {}).tenants || {};
  const rows = tenant ? [all[tenant]].filter(Boolean) : Object.values(all);
  const sum = (f) => rows.reduce((a, r) => a + (Number(f(r)) || 0), 0);
  const sbt = (k) => sum((r) => (r.signalsByType || {})[k]);
  return {
    ok: sum((r) => (r.events || {}).ok),
    connector: sbt("connector"), human: sbt("human"),
    machine: sbt("LogErrorAnomaly") + sbt("RequestErrorAnomaly") + sbt("podFailure") + sbt("resourcePressure"),
    openNow: sum((r) => (r.issues || {}).openNow), opened: sum((r) => (r.issues || {}).opened),
    reopened: sum((r) => (r.issues || {}).reopened), resolved: sum((r) => (r.issues || {}).resolved),
    flap: sum((r) => r.flapSuppressionDrops), held: sum((r) => r.raiseHeldAccepted),
    // Memory before the opener (ADR-074/079/080): machine opens a human
    // verdict or a recognised pattern held off, open issues a pattern
    // closed, and the verdicts people gave.
    patternHeld: sum((r) => r.patternHeld), patternClosed: sum((r) => r.patternClosed), verdictHeld: sum((r) => r.verdictHeld),
    verdictExpected: sum((r) => r.verdictExpected), verdictNoise: sum((r) => r.verdictNoise),
    hits: sum((r) => r.predictionHits), misses: sum((r) => r.predictionMisses),
    leadMs: sum((r) => (r.predictionAvgLeadMs || 0) * (r.predictionHits || 0)) / Math.max(1, sum((r) => r.predictionHits)),
  };
}

// Live activity: each component's running counter, sampled whenever a status
// frame changes one. A counter that moved in the latest frame pulses its dot
// and the flows into it; the rate per minute is taken over the last few
// minutes of samples, in the browser (the core sends totals only).
const PULSE_MS = 1500, RATE_WINDOW_MS = 5 * 60 * 1000, RATE_MIN_SPAN_MS = 20 * 1000;
const live = { scope: null, samples: [], pulse: new Set(), at: 0 };

function track(scope, counters, now) {
  if (live.scope !== scope) { live.scope = scope; live.samples = []; live.pulse = new Set(); }
  // A replica leaving the mesh takes its counts out of the sums; start over
  // from the lower totals, or nothing would move until they climbed back.
  const prev = live.samples[live.samples.length - 1];
  if (prev && Object.keys(counters).some((k) => counters[k] != null && prev.v[k] != null && counters[k] < prev.v[k])) live.samples = [];
  const last = live.samples[live.samples.length - 1];
  const moved = last ? Object.keys(counters).filter((k) => counters[k] != null && last.v[k] != null && counters[k] > last.v[k]) : [];
  if (!last || Object.keys(counters).some((k) => counters[k] !== last.v[k])) {
    live.samples.push({ t: now, v: counters });
    if (moved.length) { live.pulse = new Set(moved); live.at = now; }
  }
  // Keep one sample older than the window as the rates' base.
  while (live.samples.length > 2 && live.samples[1].t <= now - RATE_WINDOW_MS) live.samples.shift();
  const base = live.samples[0], pulsing = now - live.at < PULSE_MS ? live.pulse : new Set();
  const span = now - base.t, rate = {};
  if (span >= RATE_MIN_SPAN_MS) {
    for (const k of Object.keys(counters)) {
      const d = counters[k] - base.v[k];
      if (counters[k] != null && base.v[k] != null && d > 0) rate[k] = d / (span / 60000);
    }
  }
  return { pulsing, rate };
}
const perMin = (r) => (r >= 10 ? Math.round(r) : r >= 1 ? r.toFixed(1) : r.toFixed(2)) + "/min";

// The pattern track's decisions from the status rsi block's perTenant rows:
// the scoped tenant's, or all tenants summed.
export function rsiPatternSum(rsi, tenant) {
  const per = (rsi || {}).perTenant || {};
  const rows = tenant ? [per[tenant]].filter(Boolean) : Object.values(per);
  const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return { decided: sum("patternsDecided"), pending: sum("patternsPending") };
}

export function shieldSum(shield, tenant) {
  if (!shield) return null;
  const rows = tenant ? [shield[tenant]].filter(Boolean) : Object.values(shield);
  const out = {};
  for (const r of rows) for (const [k, x] of Object.entries(r)) out[k] = (out[k] || 0) + (Number(x) || 0);
  for (const k of ["offered", "atOnce", "reflectionMessages", "reflectionSent", "reflectionHeld", "fallbackMessages", "fallbackSent", "fallbackHeld", "capHeld"]) out[k] = out[k] || 0;
  return out;
}

// A value inside a line: bright.
const v = (x) => `<tspan class="lg-v">${esc(x)}</tspan>`;
const dim = (x) => `<tspan class="lg-d">${esc(x)}</tspan>`;
const f1 = (x) => x.toFixed(1);

// A component on the ring: a dot sized by weight, its name, tier and live
// lines outside the ring, anchored away from the centre.
function dot(p, c, dimmed, pulse, rate) {
  const [tl, tc] = TIER[c.tier];
  const cos = Math.cos(p.a), sin = Math.sin(p.a);
  const lx = CX + cos * (RX + c.r + 12), ly = CY + sin * (RY + c.r + 12);
  const anchor = Math.abs(cos) < 0.1 ? "middle" : cos > 0 ? "start" : "end";
  const rows = [`<tspan class="lg-title">${esc(c.name)}${c.loop ? ` <tspan class="lg-loop">↻ ${esc(c.loop)}</tspan>` : ""}${rate ? ` <tspan class="lg-rate">${esc(perMin(rate))}</tspan>` : ""}</tspan>`,
    `<tspan class="lg-tier" style="fill:${tc}">${esc(tl)}</tspan>`, ...c.lines];
  // Stack upward above the ring's top, downward below it, centred at the sides.
  const step = 16, top = sin < -0.6 ? ly - (rows.length - 1) * step : sin > 0.6 ? ly + 10 : ly - ((rows.length - 1) * step) / 2 + 4;
  const text = rows.map((r, i) => `<text x="${f1(lx)}" y="${f1(top + i * step)}" text-anchor="${anchor}" class="lg-line">${r}</text>`).join("");
  const cls = `lg-dot${c.off ? " off" : ""}${dimmed ? " dimmed" : ""}${pulse ? " pulse" : ""}`;
  return `<g class="${cls}"><circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="${c.r}" fill="${tc}" stroke="${tc}"/>${text}</g>`;
}

// A flow between two ring components: a chord bent toward the centre, kept
// clear of the memory circle, the arrow stopping at the target's rim.
function chord(p, q, rp, rq, opts = {}) {
  const mx = (p.x + q.x) / 2 - CX, my = (p.y + q.y) / 2 - CY;
  let len = Math.hypot(mx, my), ux, uy;
  if (len < 1) { ux = -(q.y - p.y); uy = q.x - p.x; const l = Math.hypot(ux, uy); ux /= l; uy /= l; } else { ux = mx / len; uy = my / len; }
  const k = Math.max(MEM_R + 40, Math.min(len, RY) * 0.62);
  const cx = CX + ux * k, cy = CY + uy * k;
  const trim = (a, b, r) => { const d = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: a.x + ((b.x - a.x) / d) * r, y: a.y + ((b.y - a.y) / d) * r }; };
  const s = trim(p, { x: cx, y: cy }, rp + 3), e = trim(q, { x: cx, y: cy }, rq + 4);
  return path(`M${f1(s.x)},${f1(s.y)} Q${f1(cx)},${f1(cy)} ${f1(e.x)},${f1(e.y)}`, opts);
}

// A flow between the memory centre and a ring component, straight.
function spoke(p, r, opts = {}) {
  const d = Math.hypot(p.x - CX, p.y - CY), ux = (p.x - CX) / d, uy = (p.y - CY) / d;
  const a = { x: CX + ux * (MEM_R + 4), y: CY + uy * (MEM_R + 4) }, b = { x: p.x - ux * (r + 4), y: p.y - uy * (r + 4) };
  const [s, e] = opts.out ? [a, b] : [b, a];
  return path(`M${f1(s.x)},${f1(s.y)} L${f1(e.x)},${f1(e.y)}`, opts);
}

function path(d, opts) {
  return `<path d="${d}" class="lg-edge${opts.dash ? " dash" : ""}${opts.dimmed ? " dimmed" : ""}${opts.pulse ? " pulse" : ""}"${opts.both ? ' marker-start="url(#lg-arrow)"' : ""} marker-end="url(#lg-arrow)"><title>${esc(opts.title || "")}</title></path>`;
}

export function logicPanel(D, raw, pathName = "all") {
  const st0 = (raw && raw.status) || {};
  // The decision model ranks prognosis; predictionRank carries its counts.
  const pr = st0.predictionRank, ranked = !!(st0.loops || {}).decisionModel;
  const on = PATH_IDS[pathName] ? new Set(["mem", ...PATH_IDS[pathName], ...(pathName === "jev" && ranked ? ["prog"] : [])]) : null;
  const dimmed = (...ids) => !!on && !ids.every((x) => on.has(x));
  const st = (raw && raw.status) || {};
  const L = st.loops || {};
  const g = st.guardrailStats || {}, c = st.classifierStats || {}, rr = st.reflexRules || {};
  const rsi = st.rsi || {}, pol = st.policy || {}, nt = st.notify || {};
  const t = tenantSum(st, D.tenant);
  const jev = L.decisionModel || "";
  // Today by kind, summed over tenants, from the status limits block (the
  // core's one ledger, ADR-078).
  const byKind = limitsByKind(st) || {};
  const rsiT = (rsi.applyTenants || []).join(", ");
  // The pattern track's own decisions (core ADR-088): patterns the loop
  // recorded by itself in autonomous mode, and proposals still waiting for a
  // person; the scoped tenant's, or every tenant summed.
  const rsiP = rsiPatternSum(rsi, D.tenant);
  const mem = D.mem || {}, mk = mem.byKind || {};
  const thr = (x) => (x != null ? x : "—");
  // The interrupt shield (core ADR-063): the scoped tenant's counts, or all
  // tenants summed. The core leaves the block out until the first change is
  // offered, so its absence reads as zero.
  const sh = shieldSum(st.shield || {}, D.tenant);
  const shSent = sh ? sh.atOnce + sh.reflectionSent + sh.fallbackSent : 0;
  const shHeld = sh ? sh.reflectionHeld + sh.fallbackHeld + sh.capHeld : 0;
  const prec = t.hits + t.misses ? Math.round((100 * t.hits) / (t.hits + t.misses)) + "%" : "—";

  // Clockwise from the top: the classifier, routing and issues, the frame
  // and the interrupt shield, the loops, the policy, the rules, and the event path
  // from the sources back round to the classifier.
  const comps = [
    { id: "cls", name: "classifier", tier: "sys1", r: 26, lines: [
      `noise ${v(n(c.noise))} signal ${v(n(c.signal))} issue ${v(n(c.issue))}`,
      `${dim("cut")} ${v(thr(c.noiseThreshold))} ${dim("/")} ${v(thr(c.issueThreshold))} ${dim("· every event")}`] },
    // No model opens an issue (core ADR-073): machine events end in the
    // engine's rules; the agent call kind is the author pass after an open.
    { id: "rt", name: "routing", tier: "reflex", r: 17, lines: [
      `${dim("human →")} ${v(jev ? "jev" : "text")} ${dim("· machine →")} ${v("rules")}`,
      `${dim("author pass tokens today")} ${v(n(byKind.agent))}`] },
    { id: "iss", name: "issues", tier: "reflex", r: 15, lines: [
      `open ${v(n(t.openNow))} opened ${v(n(t.opened))}`, `reopened ${v(n(t.reopened))} resolved ${v(n(t.resolved))}`] },
    { id: "fr", name: "situation frame", tier: "reflex", r: 13, loop: dur(L.situationWake), lines: [
      `quiet ${v(dur(L.quietAfter))} hold ${v(dur(L.memHold))} clear ${v(dur(L.clearAfter))}`, `flaps ${v(n(t.flap))} held ${v(n(t.held))}`] },
    // The matcher rebuilds every 30 s; a ranked answer stands at least 5 min
    // and is re-asked at most every 30 min while its evidence holds (core
    // prediction_decision.go, compiled).
    { id: "prog", name: "prognosis", tier: ranked ? "jev" : "reflex", r: 14, loop: ranked ? "15m–30m" : "30s", lines: [
      ...(ranked && pr ? [`${dim("jev ranks · asked")} ${v(n(pr.asked))} ${dim("kept")} ${v(n(pr.cached))}`] : []),
      `hits ${v(n(t.hits))} misses ${v(n(t.misses))} ${dim("·")} ${v(prec)}${ranked ? ` ${dim("· matcher")} ${v("30s")}` : ""}`, `${dim("lead")} ${v(t.hits ? Math.round(t.leadMs / 60000) + "m" : "—")} ${dim("· precursors of past issues")}`] },
    { id: "is", name: "IS · interrupt shield", tier: jev ? "jev" : "shield", r: 13, lines: [
      `${jev ? `${v("jev")} ${dim("sets severity")}` : dim("engine severity")} ${dim("→")} ${v((nt.channels || []).length ? "on-call" : "no channel")}`,
      ...(sh ? [
        `offered ${v(n(sh.offered))} sent ${v(n(shSent))} ${dim("·")} shielded ${v(n(shHeld))}${sh.offered ? ` ${dim("(" + Math.round((100 * shHeld) / sh.offered) + "%)")}` : ""}`,
        `${dim("at once")} ${v(n(sh.atOnce))} ${dim("· reflection")} ${v(n(sh.reflectionMessages))} ${dim("· fallback")} ${v(n(sh.fallbackMessages))}`] : [])] },
    { id: "rfl", name: "reflection", tier: "s2rfl", r: 16, loop: dur(L.reflection), off: L.reflectionOn === false, lines: [
      `${dim("+ frame wake · cooldown")} ${v(dur(L.passCooldown))}`, `tokens today ${v(n(byKind.reflection))}`] },
    { id: "rsn", name: "reasoning · knowledge", tier: "s2", r: 20, loop: dur(L.knowledge), off: L.knowledgeOn === false, lines: [
      dim("resolved issues → facts, patterns"), `tokens today ${v(n(byKind.knowledge))}`] },
    { id: "rsi", name: "RSC/RSI · self-correction/improvement", tier: "s2rsi", r: 15, loop: dur(rsi.interval), off: !rsi.enabled, lines: [
      `${v(rsi.enabled ? rsi.mode || "on" : "off")} ${dim("after")} ${v(n(rsi.applyAfter))} ${dim("consistent ·")} ${v(rsiT || "all tenants")}`,
      `${dim("patterns · by the loop")} ${v(n(rsiP.decided))} ${dim("· awaiting a person")} ${v(n(rsiP.pending))}`] },
    { id: "pol", name: "policy cell", tier: "cfg", r: 13, lines: [
      `${v(pol.name || "built-in")} v${v(pol.version != null ? pol.version : "—")} ${dim("from")} ${v(pol.source || "—")}`] },
    { id: "rr", name: "reflex rules", tier: "reflex", r: 11, off: rr.enabled === false, lines: [
      `active ${v(n(rr.active))} hits ${v(n(rr.hits))}`] },
    { id: "src", name: "sources", tier: "cfg", r: 12, lines: [
      `heartbeats ${v(n(t.ok))} machine ${v(n(t.machine))}`, `connectors ${v(n(t.connector))} human ${v(n(t.human))}`] },
    { id: "s0", name: "stage 0 · graph", tier: "reflex", r: 11, lines: [
      dim("unknown, noise → drop · regex")] },
    { id: "gr", name: "guardrail", tier: jev ? "jev" : "reflex", r: 15, lines: [
      `${dim("human →")} ${v(jev ? "jev" : "regex")} ${dim("· machine bypass")} ${v(n(g.k8sBypassed))}`] },
  ];
  const P = {}, C = {};
  comps.forEach((cp, i) => {
    const a = (i / comps.length) * Math.PI * 2 - Math.PI / 2;
    P[cp.id] = { x: CX + Math.cos(a) * RX, y: CY + Math.sin(a) * RY, a };
    C[cp.id] = cp;
  });
  const sum = (...xs) => (xs.every((x) => x == null) ? null : xs.reduce((a, x) => a + (Number(x) || 0), 0));
  const { pulsing, rate } = track(D.tenant || "", {
    src: (st.queue || {}).total, s0: (st.queue || {}).total, gr: sum(g.k8sBypassed, g.infraPassed, g.noiseDropped, g.injectionDropped),
    cls: sum(c.noise, c.signal, c.issue, c.unknown), rt: byKind.agent,
    iss: sum(t.opened, t.reopened, t.resolved), fr: sum(t.flap, t.held), prog: sum(t.hits, t.misses, pr && pr.asked),
    is: sh.offered, rr: rr.hits, rfl: byKind.reflection, rsn: byKind.knowledge, rsi: sum(byKind.rsi, rsiP.decided), mem: mem.total,
  }, Date.now());
  const flows = (to) => pulsing.has(to);
  const fl = (a, b, o) => chord(P[a], P[b], C[a].r, C[b].r, { ...o, dimmed: dimmed(a, b), pulse: flows(b) || (o.both && flows(a)) });
  const sp = (a, o) => spoke(P[a], C[a].r, { ...o, dimmed: dimmed(a, "mem"), pulse: flows(o.out ? a : "mem") || (o.both && flows(o.out ? "mem" : a)) });

  const edges = [
    // the event path
    fl("src", "s0", { title: "events" }), fl("s0", "gr", { title: "events" }), fl("gr", "cls", { title: "events" }),
    fl("cls", "rt", { title: "not settled" }), fl("rt", "iss", { title: "open · join" }),
    fl("rr", "cls", { title: "settles" }),
    fl("iss", "fr", { both: true, title: "raise · resolve" }),
    fl("iss", "is", { dash: true, both: true, title: "new issue · jev sets its severity" }),
    fl("fr", "rfl", { title: "frame changed → wake" }),
    fl("rfl", "is", { dash: true, title: "announce ops" }),
    fl("rfl", "rr", { title: "proposes" }),
    fl("iss", "rsn", { dash: true, title: "resolved issues" }),
    fl("iss", "prog", { title: "precursor patterns" }),
    fl("prog", "rfl", { title: "elevated → reflection" }),
    fl("prog", "is", { dash: true, title: "prediction ≥ notify floor" }),
    fl("fr", "prog", { title: "situation line" }),
    fl("rsi", "pol", { dash: true, title: "overlay" }),
    // the policy governs
    ...["gr", "cls", "rt", "rfl"].map((x) => fl("pol", x, { dash: true, title: "governs" })),
    // memory: who reads it, who writes it
    sp("rt", { out: true, title: "context · cache" }),
    sp("rfl", { out: true, both: true, title: "reads · writes" }),
    sp("rsn", { title: "writes" }),
    sp("rsi", { out: true, title: "reads" }),
    sp("prog", { out: true, both: true, title: "event history · precursor patterns" }),
    sp("iss", { out: true, both: true, title: "issue and event cells · reseed" }),
  ].join("");

  const memory = `<g class="lg-mem${dimmed("mem") ? " dimmed" : ""}${pulsing.has("mem") ? " pulse" : ""}"><circle cx="${CX}" cy="${CY}" r="${MEM_R}"/>
    <text x="${CX}" y="${CY - 22}" text-anchor="middle" class="lg-title">memory${rate.mem ? ` <tspan class="lg-rate">${esc(perMin(rate.mem))}</tspan>` : ""}</text>
    <text x="${CX}" y="${CY - 2}" text-anchor="middle" class="lg-line">cells ${v(n(mem.total))} mindmaps ${v(n(mk.mindmap))}</text>
    <text x="${CX}" y="${CY + 16}" text-anchor="middle" class="lg-line">facts ${v(n(mk.stable_fact))} patterns ${v(n(mk.operational_pattern))}</text></g>`;

  return `<div class="logic">
    <div class="tbar">${panelTitle("proc", D.tenant, on ? ` · ${esc(pathName)}` : "")}</div>
    <div class="lg-scroll"><svg class="lg" viewBox="${PAD_X} 0 ${W} ${H}" role="img" aria-label="triage proc diagram">
      <defs><marker id="lg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="lg-head"/></marker></defs>
      ${edges}${memory}${comps.map((cp) => dot(P[cp.id], cp, dimmed(cp.id), pulsing.has(cp.id), rate[cp.id])).join("")}
    </svg></div>
  </div>`;
}
