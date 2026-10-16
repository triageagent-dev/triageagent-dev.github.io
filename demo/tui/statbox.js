// Panel 3's two boxes under the lists: the classifier (and the policy that
// sets its numbers) under the events, the decision model (Jev) under the
// issues. Pure: status blob in, HTML out. The core sends counters only, so
// every bar is a share of its own parts.
import { esc } from "./ui.js";
import { formatCount, formatDuration, DASH } from "./api.js";
import { tenantSum, shieldSum, dur } from "./logic.js";

const num = (x) => Number(x) || 0;
const pct = (part, all) => (all > 0 ? (part > 0 && (100 * part) / all < 1 ? "<1%" : Math.round((100 * part) / all) + "%") : DASH);
const cnt = (x) => formatCount(num(x));

// A bar cut into coloured parts, with its legend beside it (parts at zero
// stay out of both). parts: [{ k, n, c }]
// where c is a CSS colour. Empty parts take no room; no parts at all is a
// flat track.
export function stack(parts) {
  const live = parts.filter((p) => num(p.n) > 0), all = live.reduce((a, p) => a + num(p.n), 0);
  const segs = live.map((p) => `<span style="flex:${num(p.n)};background:${p.c}" title="${esc(p.k + " " + cnt(p.n) + " · " + pct(p.n, all))}"></span>`).join("");
  const legend = (live.length ? live : parts.slice(0, 1)).map((p) => `<span class="sl"><span class="sw" style="background:${p.c}"></span><span class="fg-dim">${esc(p.k)}</span> <span class="fg-strong">${esc(cnt(p.n))}</span>${all > 0 && num(p.n) > 0 ? ` <span class="fg-faint">${esc(pct(p.n, all))}</span>` : ""}</span>`).join("");
  return `<div class="stk">${segs}</div><div class="stkl">${legend}</div>`;
}

// spent against a cap: a filled track with the percent beside it.
export function meter(spent, cap) {
  if (!(cap > 0)) return `<span class="fg-strong">${esc(cnt(spent))}</span> <span class="fg-faint">no limit</span>`;
  const f = Math.min(1, spent / cap), tone = spent >= cap ? "var(--crit)" : f >= 0.8 ? "var(--warn)" : "var(--ok)";
  return `<span class="mtr"><span style="width:${(f * 100).toFixed(1)}%;background:${tone}"></span></span> <span class="fg-strong">${Math.round(f * 100)}%</span> <span class="fg-dim">${esc(cnt(spent))} / ${esc(cnt(cap))}</span>`;
}

const row = (k, inner) => `<div class="sbrow"><span class="k">${esc(k)}</span><span class="b">${inner}</span></div>`;
const facts = (xs) => xs.filter((x) => x && x[1] !== "" && x[1] != null).map(([k, val]) => `<span class="fa"><span class="fg-dim">${esc(k)}:</span> <span class="fg-strong">${esc(val)}</span></span>`).join("");
const box = (title, note, body) => `<div class="sbox"><div class="sbt"><span class="t">${esc(title)}</span>${note ? `<span class="fg-faint"> · ${esc(note)}</span>` : ""}</div>${body}</div>`;

// A bar when the parts split into more than one; a bar of a single colour says
// nothing, so that row's one figure goes into the box's facts line instead.
function barOrFact(k, parts, flat) {
  const live = parts.filter((p) => num(p.n) > 0);
  if (live.length > 1) return row(k, stack(parts));
  if (live.length === 1) flat.push([k, live[0].k + " " + cnt(live[0].n)]);
  return "";
}

const C = { noise: "var(--faint2)", signal: "var(--info)", issue: "var(--crit)", unknown: "var(--violet)", ok: "var(--ok)", warn: "var(--warn)" };

const agoMin = (iso, now) => {
  const t = Date.parse(iso || "");
  if (!t) return "";
  const m = Math.max(0, Math.round((now - t) / 60000));
  return m < 60 ? m + "m ago" : m < 1440 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago";
};

// Daily kind caps as the policy sets them, kinds with the same cap together:
// "500K agent, chat · 100K rca" (every tenant has its own allowance of each).
const short = (x) => cnt(x).replace(/\.0(?=[KMB]?$)/, "");
function kindCaps(st) {
  const t = Object.values((st.limits || {}).tenants || {})[0];
  const by = new Map();
  Object.entries((t || {}).kinds || {}).forEach(([k, l]) => { if (num(l.cap) > 0) by.set(num(l.cap), (by.get(num(l.cap)) || []).concat(k)); });
  return [...by.entries()].sort((a, b) => b[0] - a[0]).map(([cap, ks]) => short(cap) + " " + ks.sort().join(", ")).join(" · ");
}

// Under the events: what the classifier made of everything, and the numbers
// the policy has set for it.
export function classifierBox({ status: st = {}, tenant = "", events = [], now = Date.now() }) {
  const c = st.classifierStats || {}, g = st.guardrailStats || {}, rr = st.reflexRules || {}, pol = st.policy || {};
  const ts = ((st.tenantStats || {}).tenants || {});
  const te = tenant ? (ts[tenant] || {}).events : null;
  const mix = (e) => [{ k: "noise", n: e.noise, c: C.noise }, { k: "signal", n: e.signal, c: C.signal }, { k: "issue", n: e.issue, c: C.issue }, { k: "unknown", n: e.unknown, c: C.unknown }];
  const sev = ["critical", "warning", "info"].map((s) => ({ k: s, n: events.filter((e) => String(e.severity || "").toLowerCase() === s).length, c: s === "critical" ? "var(--crit)" : s === "warning" ? "var(--warn)" : "var(--info)" }));
  const cut = c.noiseThreshold != null ? [["noise below", String(c.noiseThreshold)], ["issue from", String(c.issueThreshold)]] : [];
  const flat = [];
  const body = [
    pol.name || cut.length ? row("policy", (pol.name ? `<span class="fa"><span class="fg-violet">${esc(pol.name + " v" + (pol.version != null ? pol.version : "?"))}</span></span>` : "") + facts([["from", pol.source || ""], ["applied", agoMin(pol.appliedAt, now)], ...cut])) : "",
    kindCaps(st) ? row("daily caps", `<span class="fa fg-strong">${esc(kindCaps(st))}</span>`) : "",
    // The scoped tenant's own events; the classifier's counters across every tenant only with none scoped.
    c.enabled === false ? row("classifier", `<span class="fg-warn">disabled</span>`) : te ? row(tenant, stack(mix(te))) : row("all tenants", stack(mix(c))),
    barOrFact("recent", sev, flat),
    g.infraPassed != null || g.k8sBypassed != null ? barOrFact("guardrail", [{ k: "k8s bypass", n: g.k8sBypassed, c: C.ok }, { k: "passed", n: g.infraPassed, c: C.signal }, { k: "dropped", n: num(g.noiseDropped) + num(g.injectionDropped), c: C.warn }], flat) : "",
    row("other", facts([
      ...flat,
      ["embeddings", cnt(c.embeddingCalls) + (num(c.embeddingErrors) ? ", " + cnt(c.embeddingErrors) + " failed" : "")],
      rr.enabled ? ["reflex rules", num(rr.active) + " active, " + cnt(rr.hits) + " hits"] : null,
    ])),
  ].join("");
  return box("classifier", "every event, system one", body);
}

// Under the issues: the decision model's budget, calls and verdicts, then
// how the issues came out. cats = the usage ring's categories (24h) or null.
export function decisionBox({ status: st = {}, tenant = "", cats = null, issues = [] }) {
  const cfg = st.config || {}, L = st.loops || {}, pr = st.predictionRank, t = tenantSum(st, tenant);
  const sh = shieldSum(st.shield || {}, tenant);
  const lt = (st.limits || {}).tenants || {};
  const decs = tenant ? [lt[tenant] && lt[tenant].decision].filter(Boolean) : Object.values(lt).map((x) => x.decision).filter(Boolean);
  const spent = decs.reduce((a, d) => a + num(d.spent), 0), cap = tenant ? num((decs[0] || {}).cap) : decs.reduce((a, d) => a + num(d.cap), 0);
  const model = L.decisionModel || cfg.decisionModel || "";
  if (!model) return box("decision", "", row("model", `<span class="fg-faint2">off — no decision model wired</span>`));
  const d = cats && cats.decision;
  const calls = d ? row("24h", facts([
    ["calls", cnt(d.calls)], ["failed", cnt(d.errors)],
    d.durCalls ? ["avg", Math.round(d.durMs / d.durCalls) + " ms"] : null,
    ["tokens", cnt(d.input) + " in / " + cnt(d.output) + " out"],
  ])) : "";
  const ts = (st.tenantStats || {}).tenants || {};
  const mttd = (tenant ? [ts[tenant]] : Object.values(ts)).filter(Boolean).map((e) => num(e.mttdP90Ms)).filter((x) => x >= 1000);
  const every = (x) => (x && dur(x) !== "off" ? dur(x) : "");
  // The issues in the list by severity: all of them, and the open ones.
  const bySev = (xs) => [["critical", "var(--crit)"], ["warning", "var(--warn)"], ["info", "var(--info)"]].map(([k, c]) => ({ k, c, n: xs.filter((i) => String(i.severity || "").toLowerCase() === k).length }));
  const openIssues = issues.filter((i) => String(i.status || "").toLowerCase() !== "resolved");
  const flat = [];
  const sevText = (xs) => bySev(xs).filter((p) => p.n > 0).map((p) => p.n + " " + p.k).join(", ");
  const body = [
    row("budget", meter(spent, cap)),
    row("sets", facts([
      ["cap", cap > 0 ? cnt(cap) + (tenant ? "/day" : " total/day") : ""],
      ["situation wake", every(L.situationWake)], ["quiet after", every(L.quietAfter)], ["clear after", every(L.clearAfter)],
      ["announce gap", every(L.announceMinGap)], ["reflection", every(L.reflection)], ["knowledge", every(L.knowledge)],
    ])),
    calls,
    pr ? barOrFact("prognosis", [{ k: "asked", n: pr.asked, c: C.signal }, { k: "kept", n: pr.cached, c: C.ok }, { k: "unanswered", n: pr.unanswered, c: C.warn }], flat) : "",
    sh ? barOrFact("severity", [{ k: "raised", n: sh.severityRaised, c: C.issue }, { k: "kept", n: sh.severityKept, c: C.noise }, { k: "lowered", n: sh.severityLowered, c: C.ok }], flat) : "",
    sh ? barOrFact("gate", [{ k: "passed", n: sh.gatePassed, c: C.ok }, { k: "held", n: sh.gateHeld, c: C.warn }, { k: "unanswered", n: sh.gateUnanswered, c: C.noise }], flat) : "",
    sh && sh.offered ? barOrFact("shield", [{ k: "sent", n: sh.atOnce + sh.reflectionSent + sh.fallbackSent, c: C.ok }, { k: "held", n: sh.reflectionHeld + sh.fallbackHeld + sh.capHeld + sh.blipHeld, c: C.warn }], flat) : "",
    t.hits + t.misses > 0 ? barOrFact("predictions", [{ k: "hit", n: t.hits, c: C.ok }, { k: "missed", n: t.misses, c: C.warn }], flat) : "",
    barOrFact("memory", [{ k: "by pattern", n: t.patternHeld, c: C.ok }, { k: "closed by pattern", n: t.patternClosed, c: C.signal }, { k: "by verdict", n: t.verdictHeld, c: C.warn }], flat),
    barOrFact("verdicts", [{ k: "expected", n: t.verdictExpected, c: C.ok }, { k: "noise", n: t.verdictNoise, c: C.noise }], flat),
    issues.length ? row("issues", stack(bySev(issues))) : "",
    row("other", facts([
      ["open", openIssues.length ? openIssues.length + " (" + sevText(openIssues) + ")" : ""],
      ["resolved", t.resolved ? cnt(t.resolved) : ""], ["reopened", t.reopened ? cnt(t.reopened) : ""],
      ...flat,
      ["flaps dropped", t.flap ? cnt(t.flap) : ""], ["raises held", t.held ? cnt(t.held) : ""],
      ["prediction lead", t.hits ? Math.round(t.leadMs / 60000) + "m" : ""],
      ["MTTD p90", mttd.length ? formatDuration(Math.max(...mttd) / 1000) : ""],
    ])),
  ].join("");
  return box("decision", model + " · gates guardrail, routing, severity", body);
}
