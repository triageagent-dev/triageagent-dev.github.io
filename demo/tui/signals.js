// The src section of the workspaces panel (?) — sources: the cluster agents (approvals.js) on top, then signals. A port of triagectl's ui/signals.go: collectors →
// sensors → (value scorecard ∥ signals sparklines) → top services, for the
// scoped tenant (or an "all tenants" aggregate when nothing is scoped), read
// off the /v2/agent/status blob the client already fetches.
import { DASH, ago, arr, num, coveragePctLabel } from "./api.js";
import { esc, panelTitle, sub } from "./ui.js";

// ── session history ring (signals.go sampleSignals / ringDeltas) ───────────
const RING_CAP = 120;
const ALL = ""; // aggregate ring key; never a real tenant name
const BUCKET_S = 300; // hub signalsHistory bucket width
const SPARK_MAX = 30, SPARK_MIN = 8;

const F_RED = "RequestErrorAnomaly", F_LOG = "LogErrorAnomaly", F_POD = "podFailure", F_USE = "resourcePressure";
// Slogan order "USE RED SIGNALS": use, red, log, k8s. k8s is a display
// rename of the podFailure wire key.
const FAMILIES = [
  { key: F_USE, label: "use", color: "#22d3ee" },
  { key: F_RED, label: "red", color: "var(--crit)" },
  { key: F_LOG, label: "log", color: "#f1fa8c" },
  { key: F_POD, label: "k8s", color: "var(--violet)" },
];
const FAM_COLOR = Object.fromEntries(FAMILIES.map((f) => [f.key, f.color]));
const OTLP_COLOR = "#fb923c";
// An agent reports its OTLP sources every ~60s; three missed reports is stale.
const OTLP_STALE_S = 180;
const KEY_LINE = "net=requests · otlp=pushed points · use=saturation · red=wire errors · log=log errors · k8s=platform events";

const rings = new Map();

// Called on every fresh /v2/agent/status (the CLI calls it on every
// SetSnapshot): one sample per tenant plus a summed aggregate, all stamped
// with the same client-side time.
export function sampleSignals(st) {
  const ts = st && st.tenantStats;
  if (!ts) return;
  const at = Date.now();
  const agg = { at, red: 0, log: 0, pod: 0, use: 0, open: 0 };
  Object.entries(ts.tenants || {}).forEach(([t, e]) => {
    const s = sbt(e);
    const smp = { at, red: s[F_RED], log: s[F_LOG], pod: s[F_POD], use: s[F_USE], open: num(((e || {}).issues || {}).openNow) };
    agg.red += smp.red; agg.log += smp.log; agg.pod += smp.pod; agg.use += smp.use; agg.open += smp.open;
    push(t, smp);
  });
  push(ALL, agg);
}
const sbt = (e) => {
  const m = (e || {}).signalsByType || {};
  return { [F_RED]: num(m[F_RED]), [F_LOG]: num(m[F_LOG]), [F_POD]: num(m[F_POD]), [F_USE]: num(m[F_USE]) };
};
function push(key, s) {
  const r = rings.get(key) || [];
  r.push(s);
  if (r.length > RING_CAP) r.splice(0, r.length - RING_CAP);
  rings.set(key, r);
}
const sampleVal = (s, key) => ({ [F_RED]: s.red, [F_LOG]: s.log, [F_POD]: s.pod, [F_USE]: s.use }[key] || 0);
function ringDeltas(ring, key) {
  if (!ring || ring.length < 2) return null;
  const out = [];
  let prev = sampleVal(ring[0], key);
  ring.slice(1).forEach((s) => { const x = sampleVal(s, key); out.push(Math.max(0, x - prev)); prev = x; });
  return out;
}

// ── formatting (format.go) ─────────────────────────────────────────────────
export function humanizeLeadMs(ms) {
  if (!(ms > 0)) return "";
  const s = ms / 1000;
  if (s < 60) return Math.trunc(s + 0.5) + "s";
  const m = s / 60;
  if (m < 60) return Math.trunc(m + 0.5) + "m";
  return (m / 60).toFixed(1) + "h";
}
const wholePct = (x) => Math.trunc(num(x) + 0.5) + "%";

// ── tenant entry (signalsEntry / aggregateTenantStats) ─────────────────────
function signalsEntry(st, scope) {
  const ts = st && st.tenantStats;
  if (!ts) return { entry: {}, ringKey: ALL, ok: false };
  if (scope) return { entry: (ts.tenants || {})[scope] || {}, ringKey: scope, ok: true };
  return { entry: aggregate(ts), ringKey: ALL, ok: true };
}
function aggregate(ts) {
  const out = { events: { noise: 0, signal: 0, issue: 0, unknown: 0 }, issues: { opened: 0, reopened: 0, resolved: 0, openNow: 0 }, sampledIssues: 0, predictionHits: 0, predictionMisses: 0 };
  let rep = 0, pre = 0, auto = 0, autoW = 0;
  const hist = new Map();
  Object.values(ts.tenants || {}).forEach((e) => {
    const ev = e.events || {}, c = e.issues || {};
    ["noise", "signal", "issue", "unknown"].forEach((k) => { out.events[k] += num(ev[k]); });
    ["opened", "reopened", "resolved", "openNow"].forEach((k) => { out.issues[k] += num(c[k]); });
    const sampled = num(e.sampledIssues);
    out.sampledIssues += sampled;
    out.predictionHits += num(e.predictionHits);
    out.predictionMisses += num(e.predictionMisses);
    if (sampled > 0) { rep += num(e.repeatRatePct) * sampled; pre += num(e.precursorCoveragePct) * sampled; }
    const res = sampled - num(c.openNow);
    if (res > 0) { auto += num(e.autoResolvedPct) * res; autoW += res; }
    Object.entries(e.signalsByType || {}).forEach(([k, x]) => { out.signalsByType = out.signalsByType || {}; out.signalsByType[k] = (out.signalsByType[k] || 0) + num(x); });
    arr(e.signalsHistory).forEach((b) => {
      const a = hist.get(b.t) || { t: b.t };
      ["LogErrorAnomaly", "RequestErrorAnomaly", "podFailure", "resourcePressure", "requests", "requestErrors", "otlpPoints"].forEach((k) => { a[k] = num(a[k]) + num(b[k]); });
      hist.set(b.t, a);
    });
  });
  if (out.sampledIssues > 0) { out.repeatRatePct = rep / out.sampledIssues; out.precursorCoveragePct = pre / out.sampledIssues; }
  if (hist.size) out.signalsHistory = [...hist.values()].sort((a, b) => a.t - b.t);
  if (autoW > 0) out.autoResolvedPct = auto / autoW;
  if (out.predictionHits + out.predictionMisses > 0) out.predictionPrecisionPct = out.predictionHits / (out.predictionHits + out.predictionMisses) * 100;
  const E = out.events, tot = E.noise + E.signal + E.issue + E.unknown;
  if (tot > 0) out.coveragePct = (E.noise + E.signal + E.issue) / tot * 100;
  if (out.issues.opened > 0) out.eventsPerIssue = tot / out.issues.opened;
  return out;
}

// ── hub history (denseExpandSignalsHistory etc.) ───────────────────────────
function denseExpand(sparse, nowMs) {
  if (!sparse || !sparse.length) return null;
  const by = new Map();
  let oldest = sparse[0].t;
  sparse.forEach((b) => { by.set(b.t, b); if (b.t < oldest) oldest = b.t; });
  const now = Math.floor(nowMs / 1000);
  let end = now - (now % BUCKET_S);
  by.forEach((_, t) => { if (t > end) end = t; });
  if (end < oldest) end = oldest;
  const out = [];
  for (let t = oldest; t <= end; t += BUCKET_S) out.push(by.get(t) || { t });
  return out;
}
const recent = (d, n) => (d && d.length > n ? d.slice(d.length - n) : d);
export function sparkline(deltas, width) {
  const d = deltas || [];
  const max = d.reduce((m, x) => (x > m ? x : m), 0);
  if (max === 0) return { glyphs: "▁".repeat(d.length || width), max: 0 };
  const G = "▁▂▃▄▅▆▇█";
  const glyphs = d.map((x) => {
    if (x <= 0) return G[0];
    let i = Math.floor((x * 7) / max);
    if (i <= 0) i = 1;
    if (i > 7) i = 7;
    return G[i];
  }).join("");
  return { glyphs, max };
}
function requestRate(b, nowMs) {
  const now = Math.floor(nowMs / 1000);
  let el = BUCKET_S;
  if (b.t + BUCKET_S > now) { el = now - b.t; if (el < 60) el = 60; }
  return num(b.requests) / el;
}

// ── sections ───────────────────────────────────────────────────────────────
const secTitle = (t) => sub(t, ' data-sec="1"');
const dash = `<span class="fg-faint2">${DASH}</span>`;
const dot = `<span class="fg-faint2"> · </span>`;

const COLLECTORS = [
  { key: "red_metrics", label: "red", gated: true },
  { key: "log_metrics", label: "log", gated: true },
  { key: "use_metrics", label: "use", gated: true },
  { key: "app_delta", label: "app", gated: false },
  { key: "topology_snapshot", label: "topo", gated: true, cap: "topology" },
];
const tsMs = (iso) => { const t = new Date(iso || 0).getTime(); return isFinite(t) ? t : 0; };

function collectorsSection(st, scope, nowMs) {
  let html = secTitle("collectors");
  const ca = st.clusterAgentStats;
  const rows = ca ? arr(ca.sessions).filter((s) => !scope || s.tenant === scope).sort((a, b) => (a.cluster < b.cluster ? -1 : a.cluster > b.cluster ? 1 : 0)) : [];
  if (!rows.length) return html + `<div class="sigrow">${dash}</div>`;
  rows.forEach((s) => {
    const frames = s.frames || {}, caps = arr(s.capabilities);
    let latest = 0;
    Object.values(frames).forEach((f) => { latest = Math.max(latest, tsMs(f.lastAt)); });
    const parts = [latest ? `ws ok ${esc(ago(new Date(latest).toISOString(), nowMs))}` : `ws ${dash}`];
    COLLECTORS.forEach((k) => {
      let stat = frames[k.key], present = !!stat;
      if (k.key === "app_delta") {
        present = false; stat = { count: 0, lastAt: null };
        ["app_delta", "snapshot"].forEach((x) => { const f = frames[x]; if (!f) return; present = true; stat.count += num(f.count); if (tsMs(f.lastAt) > tsMs(stat.lastAt)) stat.lastAt = f.lastAt; });
      }
      const capable = k.gated && caps.includes(k.cap || k.key);
      if (present && num(stat.count) > 0) parts.push(`${k.label} <span class="fg-ok">ok</span> ${esc(ago(stat.lastAt, nowMs))} ago`);
      else if (capable) parts.push(`${k.label} <span class="fg-warn">armed</span>`);
      else parts.push(`${k.label} <span class="fg-faint">off</span>`);
    });
    html += `<div class="sigrow"><span class="fg-violet">${esc(s.cluster)}</span>: ${parts.join(dot)}</div>`;
  });
  return html;
}

function sensorsSection(st, scope, nowMs) {
  const ca = st.clusterAgentStats;
  if (!ca) return "";
  const rows = [];
  const seen = new Set();
  // otlp: per cluster, the agent's OTLP receiver (agent ADR-0017) as one
  // indicator, summed over its sources.
  const otlp = new Map();
  arr(ca.sessions).forEach((s) => {
    if (scope && s.tenant !== scope) return;
    if (!s.sensors) return;
    if (!otlp.has(s.cluster) && arr(s.sensors.otlp).length) {
      const o = { sources: 0, last: 0, red: 0, log: 0, pods: 0 };
      arr(s.sensors.otlp).forEach((x) => {
        o.sources++;
        o.last = Math.max(o.last, num(x.lastSeen));
        arr(x.families).forEach((f) => {
          if (f.family === "red") o.red += num(f.dataPoints);
          if (f.family === "log") o.log += num(f.dataPoints);
          if (f.family === "use") o.pods += num(f.pods);
        });
      });
      otlp.set(s.cluster, o);
    }
    // A cluster-mode agent's report rides on every tenant row of its
    // session: list each node once.
    arr(s.sensors.sensors).forEach((x) => {
      const k = s.cluster + "/" + x.node;
      if (seen.has(k)) return;
      seen.add(k);
      rows.push({ cluster: s.cluster, s: x });
    });
  });
  if (!rows.length && !otlp.size) return "";
  rows.sort((a, b) => (a.cluster !== b.cluster ? (a.cluster < b.cluster ? -1 : 1) : (a.s.node < b.s.node ? -1 : a.s.node > b.s.node ? 1 : 0)));
  // Five rows show (.sigscroll in styles.css); the rest scroll.
  let html = secTitle("sensors") + `<div class="sigscroll">`;
  rows.forEach(({ cluster, s }) => {
    const errs = num(s.sendErrors) + arr(s.roles).reduce((a, r) => a + num(r.gatherErrors), 0);
    const parts = [
      esc(s.version || DASH),
      s.connected ? `<span class="fg-ok">ok</span>` : `<span class="fg-crit">down</span>`,
      esc(num(s.lastSeen) > 0 ? ago(new Date(s.lastSeen * 1000).toISOString(), nowMs) : DASH),
      "ack " + Math.trunc(num(s.ackRttMicros) / 1000) + "ms",
      "heap " + Math.trunc(num(s.heapBytes) / 1048576) + "MiB",
      "goroutines " + num(s.goroutines),
      `<span class="${errs ? "fg-warn" : ""}">errors ${errs}</span>`,
    ];
    html += `<div class="sigrow"><span class="fg-violet">${esc(cluster)}</span>/${esc(s.node)}: ${parts.join(dot)}</div>`;
  });
  otlp.forEach((o, cluster) => {
    // OTLP is push-only, so there is no connection to be up or down: the
    // state is the newest export's age and whether any source still has
    // fresh points. A source is listed for a while after its last push,
    // so "down" with sources is a collector that stopped.
    const ageS = o.last > 0 ? Math.max(0, Math.floor(nowMs / 1000) - o.last) : Infinity;
    const fresh = o.red + o.log + o.pods > 0;
    const state = !fresh ? `<span class="fg-crit">down</span>` : ageS > OTLP_STALE_S ? `<span class="fg-warn">stale</span>` : `<span class="fg-ok">ok</span>`;
    const parts = [
      state,
      esc(o.last > 0 ? ago(new Date(o.last * 1000).toISOString(), nowMs) : DASH),
      "sources " + o.sources,
      "red " + o.red + " pts",
      "log " + o.log + " pts",
      "use " + o.pods + " pods",
    ];
    html += `<div class="sigrow"><span class="fg-violet">${esc(cluster)}</span>/otlp: ${parts.join(dot)}</div>`;
  });
  return html + `</div>`;
}

function signalsSection(entry, ok, ring, nowMs) {
  const dense = denseExpand(entry.signalsHistory, nowMs);
  let title = "signals";
  if (dense) {
    const plotted = Math.min(dense.length, SPARK_MAX);
    const span = humanizeLeadMs(plotted * BUCKET_S * 1000);
    if (span) title += " · last ~" + span + " · 5m/bucket";
  } else if (ring && ring.length >= 2) {
    const n = ring.length, plotted = Math.min(n - 1, SPARK_MAX);
    const ms = ring[n - 1].at - ring[n - 1 - plotted].at;
    if (ms > 0) title += " · last " + plotted + " updates · ~" + humanizeLeadMs(ms);
  }
  let html = secTitle(title);
  if (dense) {
    const net = recent(dense.map((b) => num(b.requests)), SPARK_MAX);
    if (net.some((x) => x > 0)) {
      const newest = dense[dense.length - 1];
      const sp = sparkline(net, SPARK_MAX);
      let err = "";
      if (num(newest.requestErrors) > 0 && num(newest.requests) > 0) err = `  <span class="fg-crit">${(newest.requestErrors / newest.requests * 100).toFixed(1)}% err</span>`;
      html += `<div class="sigrow"><span class="sl">net</span><span class="sn wide">${requestRate(newest, nowMs).toFixed(1)}rps</span><span class="spark" style="color:var(--info)">${sp.glyphs}</span>${err}</div>`;
    }
    // otlp: the fresh data points the agents' OTLP sources carried per
    // bucket. Shown once any bucket in view had some, so a collector that
    // stops pushing reads as the series falling to the floor, not as the
    // row vanishing.
    const otlp = recent(dense.map((b) => num(b.otlpPoints)), SPARK_MAX);
    if (otlp.some((x) => x > 0)) {
      const newest = num(dense[dense.length - 1].otlpPoints);
      const sp = sparkline(otlp, SPARK_MAX);
      const state = newest > 0 ? "" : `  <span class="fg-crit">silent</span>`;
      html += `<div class="sigrow"><span class="sl">otlp</span><span class="sn wide">${newest} pts</span><span class="spark" style="color:${OTLP_COLOR}">${sp.glyphs}</span>${state}</div>`;
    }
  }
  FAMILIES.forEach((f) => {
    const total = ok ? num((entry.signalsByType || {})[f.key]) : 0;
    const deltas = recent(dense ? dense.map((b) => num(b[f.key])) : ringDeltas(ring, f.key), SPARK_MAX);
    const sp = sparkline(deltas, SPARK_MAX);
    html += `<div class="sigrow"><span class="sl">${f.label}</span><span class="sn fg-dim">${total}</span><span class="spark" style="color:${sp.max > 0 ? f.color : "var(--ok)"}">${sp.glyphs}</span></div>`;
  });
  return html + `<div class="sigrow fg-faint2">${esc(KEY_LINE)}</div>`;
}

const RED_RE = /^service served (\d+) requests, (\d+) errors in \d+s window(?:; sample: (.*?))?(?:; p99 (\d+)ms)?$/;
const USE_RE = /^resource pressure: (.+) in \d+s window(?:; sample: (.*))?$/;
const WINDOW_MS = 30 * 60 * 1000;
const svcLabel = (ev) => {
  if (ev.service) return ev.service;
  const parts = String(ev.source || "").split("/");
  return parts[parts.length - 1] || ev.source || "";
};
function topRows(st, scope, nowMs, type, re) {
  const agg = new Map();
  arr((st.events || {}).recent).forEach((ev) => {
    if (ev.type !== type) return;
    if (scope && ev.tenant !== scope) return;
    const t = tsMs(ev.timestamp);
    if (!t || nowMs - t > WINDOW_MS || t > nowMs) return;
    const m = re.exec(String(ev.message || ""));
    if (!m) return;
    const svc = svcLabel(ev);
    const a = agg.get(svc) || { svc, errors: 0, requests: 0, sample: "", p99: 0, clauses: "", last: 0 };
    if (type === F_RED) { a.requests += Number(m[1]); a.errors += Number(m[2]); }
    if (t > a.last) {
      a.last = t;
      if (type === F_RED) { if (m[3]) a.sample = m[3]; if (m[4]) a.p99 = Number(m[4]); }
      else { a.clauses = m[1]; a.sample = m[2] || ""; }
    }
    agg.set(svc, a);
  });
  const out = [...agg.values()];
  out.sort(type === F_RED ? (a, b) => b.errors - a.errors : (a, b) => b.last - a.last);
  return out.slice(0, 5);
}
function topServicesSection(st, scope, nowMs) {
  const red = topRows(st, scope, nowMs, F_RED, RED_RE);
  const use = topRows(st, scope, nowMs, "ResourcePressureAnomaly", USE_RE);
  if (!red.length && !use.length) return "";
  let html = secTitle("top services");
  red.forEach((r) => {
    const rate = r.requests > 0 ? (r.errors / r.requests * 100) : 0;
    let tail = r.sample;
    if (r.p99 > 0) tail = tail ? tail + "  p99 " + r.p99 + "ms" : "p99 " + r.p99 + "ms";
    html += `<div class="sigrow top"><span class="sl" style="color:${FAM_COLOR[F_RED]}">red</span><span class="c" style="width:12ch">${esc(r.svc)}</span><span class="c" style="width:17ch">${r.errors} err / ${r.requests} req</span><span class="c" style="width:8ch">${rate.toFixed(1)}%</span><span class="c flex fg-faint">${esc(tail)}</span></div>`;
  });
  use.forEach((r) => {
    html += `<div class="sigrow top"><span class="sl" style="color:${FAM_COLOR[F_USE]}">use</span><span class="c" style="width:12ch">${esc(r.svc)}</span><span class="c" style="width:46ch;max-width:50%">${esc(r.clauses)}</span><span class="c flex fg-faint">${esc(r.sample)}</span></div>`;
  });
  return html;
}

function scorecardSection(entry, ok, drift) {
  const html = secTitle("scorecard");
  if (!ok) return html + `<div class="sigrow">${dash}</div>`;
  return html + scorecardRows(entry, drift);
}

// The seven value-scorecard rows (valueScorecardLinesFor) — the src section and the
// tenant picker's pane render the same rows.
export function scorecardRows(entry, drift = 0) {
  let html = "";
  const ev = entry.events || {}, c = entry.issues || {};
  const sampled = num(entry.sampledIssues), resolved = sampled - num(c.openNow);
  const evTotal = num(ev.noise) + num(ev.signal) + num(ev.issue) + num(ev.unknown);
  const row = (label, val, note) => `<div class="sigrow score"><span class="scl">${esc(label)}</span>${val == null ? dash : `<span class="fg-strong">${esc(val)}</span>`}${val != null && note ? `<span class="fg-faint">  ${esc(note)}</span>` : ""}</div>`;
  let lead = "";
  if (num(entry.predictionHits) + num(entry.predictionMisses) > 0) { const l = humanizeLeadMs(num(entry.predictionAvgLeadMs)); if (l) lead = " · avg lead " + l; }
  let fit = null, fitNote = "";
  if (num(entry.services) > 0) {
    fit = num(entry.servicesReporting) + " of " + num(entry.services) + " services reporting";
    if (num(entry.servicesDark) > 0) fitNote += "·  " + entry.servicesDark + " never reported";
    if (drift > 0) fitNote += (fitNote ? "  " : "") + "·  " + drift + " not in the graph";
  }
  html += row("coverage", evTotal > 0 ? coveragePctLabel(num(entry.coveragePct)) : null, "events grounded in a known service");
  html += row("graph fit", fit, fitNote);
  html += row("compression", num(entry.eventsPerIssue) > 0 && num(c.opened) > 0 ? entry.eventsPerIssue.toFixed(1) : null, "events → 1 issue");
  html += row("early warning", sampled > 0 ? wholePct(entry.precursorCoveragePct) : null, "issues that had precursor signals first");
  html += row("hands-free", sampled > 0 && resolved > 0 ? wholePct(entry.autoResolvedPct) : null, "resolved with no human action");
  html += row("prediction", num(entry.predictionHits) + num(entry.predictionMisses) > 0 ? wholePct(entry.predictionPrecisionPct) : null, "predictions confirmed" + lead);
  html += row("repeats", sampled > 0 ? wholePct(entry.repeatRatePct) : null, "issues that came back");
  return html;
}

// renderSignalsSplit's wide body: collectors and sensors full width, then
// scorecard (numbers, left) ∥ signals (graphics, right), then top services.
// top: the agents section (approvals.js), "" when the caller may not see it.
export function signalsPanel(D, raw, hasTenants, top = "") {
  const st = (raw && raw.status) || {};
  const scope = D.tenant || "";
  const nowMs = Date.now();
  const { entry, ringKey, ok } = signalsEntry(st, scope);
  const ring = rings.get(ringKey) || null;
  const drift = D.apps && D.apps.counts ? D.apps.counts.drift : 0;
  const statusMissing = !raw || !raw.status;
  return `<div class="col g6 sig">
    <div class="tbar">${panelTitle("sources", scope)}<span class="fill"></span><span class="hint">${hasTenants ? "T to switch tenant · " : ""}${top ? "j/k agent · " : ""}tab / &#8679;tab section</span></div>
    ${top ? `<div class="col">${top}</div>` : ""}
    ${statusMissing ? `<span class="fg-crit">/v2/agent/status unavailable — every section below renders ${DASH}</span>` : ""}
    <div class="col">${collectorsSection(st, scope, nowMs)}</div>
    ${(() => { const s = sensorsSection(st, scope, nowMs); return s ? `<div class="col">${s}</div>` : ""; })()}
    <div class="grid">
      <div class="col">${scorecardSection(entry, ok, drift)}</div>
      <div class="col">${signalsSection(entry, ok, ring, nowMs)}</div>
    </div>
    ${(() => { const s = topServicesSection(st, scope, nowMs); return s ? `<div class="col">${s}</div>` : ""; })()}
  </div>`;
}
