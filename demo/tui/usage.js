// Usage section of the workspaces panel (?) — LLM token usage: GET /v2/usage?hours=N (core ≥ 572decea), the
// fleet-wide hourly ring of every model call core made, one row per (hour,
// tenant, kind, model). Drawn as a stacked per-hour bar chart (eighth-step
// block tops) plus a breakdown table, grouped by kind, tenant or model.
// `daily` is a coarser per-tenant series from older counters: it fills only
// UTC days the hourly ring does not cover, never on top of hourly rows.
// Cost is an estimate from public list prices, by exact model id. Cached
// (part of input) and think (part of output) come from cores that report
// them; older hours show –. Grouped by tenant, embedding calls (kind
// "embedding": the local embedder, no price) leave every token column and
// the chart and get an EMBED column of their own, so a quiet tenant whose
// events were all embedded and dropped does not read as the top spender.
import { DASH, arr, num, formatCount, HttpError, createClient } from "./api.js";
import { esc, panelTitle, sub, cellW } from "./ui.js";

export const WINDOWS = [{ id: "24h", hours: 24 }, { id: "7d", hours: 168 }];
export const GROUPS = ["kind", "tenant", "model"];
const POLL_MS = 60 * 1000;
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const CHART_H = 8;           // rows; each row is 8 eighths
const TOP_N = 7;             // groups with their own colour; the rest fold into "other"
const PALETTE = ["var(--info)", "var(--ok)", "var(--warn)", "var(--violet)", "var(--magenta)", "var(--label)", "#facc15"];
const OTHER = "other", BACKFILL = "daily backfill";
const OTHER_C = "var(--dim)", BACKFILL_C = "var(--faint2)";
const EIGHTHS = "▁▂▃▄▅▆▇█";
const HBAR = "▏▎▍▌▋▊▉█";

// USD per 1M tokens, exact model id, the providers' published paid-tier
// prices (Gemini: ai.google.dev/gemini-api/docs/pricing, the <=200k prompt
// tier). in/out are text input and output (thinking is billed as output),
// cache the cached part of the input, ain/aout the audio part of input and
// output (Live models). A missing class is billed at in/out. No fuzzy
// matching: an unlisted model renders no cost, never a guess.
export const PRICES = {
  "gemini-2.5-flash": { in: 0.3, out: 2.5, cache: 0.03, ain: 1 },
  "gemini-2.5-pro": { in: 1.25, out: 10, cache: 0.125 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4, cache: 0.025 },
  "gemini-3-flash-preview": { in: 0.5, out: 3, cache: 0.05, ain: 1 },
  "gemini-3.5-flash": { in: 1.5, out: 9, cache: 0.15 },
  "gemini-3.8-flash": { in: 0.75, out: 3.75, cache: 0.075 },
  "gemini-3-pro-preview": { in: 2, out: 12, cache: 0.2 },
  "gemini-3.1-pro-preview": { in: 2, out: 12, cache: 0.2 },
  // Claude (platform.claude.com pricing): the workspace spot reports its turns under
  // this id. Cache writes bill at 1.25x input but are counted in input, so a cost
  // here is a floor.
  "claude-sonnet-5-5": { in: 2, out: 10, cache: 0.2 },
  "gpt-4o": { in: 2.5, out: 10, cache: 1.25 },
  "gpt-4o-mini": { in: 0.15, out: 0.6, cache: 0.075 },
  "gemini-live-2.5-flash-native-audio": { in: 0.5, out: 2, ain: 3, aout: 12 },
  "gemini-2.5-flash-native-audio-preview-12-2025": { in: 0.5, out: 2, ain: 3, aout: 12 },
  "gemini-2.5-flash-native-audio-preview-09-2025": { in: 0.5, out: 2, ain: 3, aout: 12 },
  "gemini-3.8-live": { in: 0.75, out: 4.5, ain: 3, aout: 12 },
  // Decision model (core ADR-063); derived from billed per-call costs.
  "typesafe/jev-1.13": { in: 0.042, out: 0 },
};
// costOf prices one usage row (or group totals with the same fields): each
// token class at its own rate. null for an unlisted model.
export function costOf(r) {
  const p = PRICES[String(r.model || "").trim().toLowerCase()];
  if (!p) return null;
  const i = num(r.inputTokens), o = num(r.outputTokens);
  const ca = Math.min(num(r.cachedTokens), i), ai = Math.min(num(r.audioInputTokens), i - ca), ao = Math.min(num(r.audioOutputTokens), o);
  const at = (rate, base) => (rate == null ? base : rate);
  return ((i - ca - ai) * p.in + ca * at(p.cache, p.in) + ai * at(p.ain, p.in) + (o - ao) * p.out + ao * at(p.aout, p.out)) / 1e6;
}
const fmtCost = (c) => (c == null ? DASH : c < 0.01 ? "$" + c.toFixed(4) : "$" + c.toFixed(2));
const fmtMs = (ms) => (ms == null ? DASH : ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms");
// A limit's spent/cap pair: millions with two decimals, so 1.04M of 1.00M
// does not read as 1.0M/1.0M at 104%.
const fmtLim = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : formatCount(n));
const pct = (a, b) => (b > 0 ? (a / b * 100 < 10 ? (a / b * 100).toFixed(1) : Math.round(a / b * 100)) + "%" : DASH);

// ── fetch + polling ────────────────────────────────────────────────────────
let C = null; // { S, redraw }
// Per window: { data, error, status, missing, at }. missing = the core 404s.
const U = { byWin: {} };
let pollT = null;
export function initUsage(ctx) { C = ctx; }
export const winOf = (id) => WINDOWS.find((w) => w.id === id) || WINDOWS[0];

export async function loadUsage(id) {
  if (!C) return;
  const w = winOf(id || C.S.useWin);
  const slot = U.byWin[w.id] || (U.byWin[w.id] = {});
  if (slot.loading) return;
  slot.loading = true;
  try {
    slot.data = await createClient().get("/v2/usage?hours=" + w.hours);
    slot.error = ""; slot.status = 0; slot.missing = false; slot.at = Date.now();
  } catch (e) {
    slot.status = e instanceof HttpError ? e.status : 0;
    slot.missing = slot.status === 404;
    slot.error = slot.missing ? "" : String((e && e.message) || e);
    slot.at = Date.now(); // a failed read waits out the poll interval too, or every redraw would retry it
  } finally {
    slot.loading = false;
    C.redraw();
  }
}
// Poll every minute while the panel is in view (and the tab visible).
export function pollUsage(on) {
  if (!on) { clearInterval(pollT); pollT = null; return; }
  if (pollT) return;
  loadUsage();
  pollT = setInterval(() => { if (!document.hidden) loadUsage(); }, POLL_MS);
}
// For the '?' panel's failed-endpoint list (a 404 is a plain note instead).
export function usageFailures() {
  return Object.entries(U.byWin).filter(([, s]) => s.error)
    .map(([id, s]) => ({ key: "usage", path: "/v2/usage?hours=" + winOf(id).hours, status: s.status || undefined, error: s.error, stale: !!s.data }));
}
export const usageSlot = (id) => U.byWin[id] || {};

// The '?' panel's LLM call count: the same ring the usage section draws, all tenants,
// loaded on demand and at most once a minute. Null until it has answered.
export function usageTotals(id) {
  const s = U.byWin[id];
  if (!s || (!s.loading && Date.now() - (s.at || 0) > POLL_MS)) loadUsage(id);
  if (!s || !s.data) return null;
  const from = num(s.data.from);
  const t = { calls: 0, errors: 0, input: 0, output: 0 };
  arr(s.data.buckets).filter((r) => num(r.start) >= from).forEach((r) => {
    t.calls += num(r.calls); t.errors += num(r.errors); t.input += num(r.inputTokens); t.output += num(r.outputTokens);
  });
  return t;
}

// The usage ring's categories (llm, decision, embedding) for one window and
// tenant scope, for panel 3's decision box. Null until the ring has answered.
export function usageCats(id, scope = "") {
  const s = U.byWin[id];
  if (!s || (!s.loading && Date.now() - (s.at || 0) > POLL_MS)) loadUsage(id);
  if (!s || !s.data) return null;
  return usageModel(s.data, { hours: winOf(id).hours, scope }).cats;
}

// Today's (UTC) machine tokens by call kind, summed over every tenant, from
// the status limits block — the core's one ledger (ADR-078), the same figures
// the gate decides on. Null without it.
export function limitsByKind(st) {
  const tenants = ((st || {}).limits || {}).tenants;
  if (!tenants) return null;
  const out = {};
  Object.values(tenants).forEach((t) => Object.entries(t.kinds || {}).forEach(([k, l]) => { out[k] = (out[k] || 0) + num(l.spent); }));
  return out;
}

// ── aggregation (pure) ─────────────────────────────────────────────────────
const groupKey = (r, by) => String(r[by] || "") || "(none)";

// usageModel(resp, { hours, group, scope, step, only }) → everything the panel draws.
// step = hours per chart column; only = one group's name, charted alone.
export function usageModel(resp, { hours = 24, group = "kind", scope = "", step = 1, only = "" } = {}) {
  const d = resp || {};
  const from = num(d.from), to = num(d.to) || Date.now();
  const inScope = (r) => !scope || r.tenant === scope;
  const hourly = arr(d.buckets).filter((r) => num(r.start) >= from);
  const rows = hourly.filter(inScope);
  // UTC days the ring covers at all (any tenant): backfill only the others.
  const covered = new Set(hourly.map((r) => Math.floor(num(r.start) / DAY)));
  const backfill = hours > 24
    ? arr(d.daily).filter(inScope).filter((r) => !covered.has(Math.floor(num(r.start) / DAY)) && num(r.start) + DAY > from && num(r.start) <= to)
    : [];

  // By tenant, embeddings are set apart: counted on the group, never in its
  // token columns, share, cost or chart.
  const sep = group === "tenant";
  const isEmbed = (r) => sep && String(r.kind || "") === "embedding";
  // groups: totals, then the top N keep a colour, alphabetical among them
  const G = new Map();
  const acc = (key) => G.get(key) || G.set(key, { name: key, calls: 0, errors: 0, input: 0, output: 0, cached: 0, think: 0, durMs: 0, durCalls: 0, cost: 0, unpriced: 0, embedCalls: 0, embedTokens: 0 }).get(key);
  rows.forEach((r) => {
    const g = acc(groupKey(r, group));
    const i = num(r.inputTokens), o = num(r.outputTokens), c = costOf(r);
    if (isEmbed(r)) { g.embedCalls += num(r.calls); g.embedTokens += i + o; return; }
    g.calls += num(r.calls); g.errors += num(r.errors); g.input += i; g.output += o;
    g.cached += num(r.cachedTokens); g.think += num(r.thinkingTokens);
    if (num(r.durationMs) > 0) { g.durMs += num(r.durationMs); g.durCalls += num(r.calls); }
    if (c == null) g.unpriced += i + o; else g.cost += c;
  });
  // A backfill day spread evenly over its hours; only hours inside the window count.
  const bfHours = [];
  let bfRow = null;
  backfill.forEach((r) => {
    const s = num(r.start);
    const inWin = [];
    for (let h = 0; h < 24; h++) { const t = s + h * HOUR; if (t >= from && t <= to) inWin.push(t); }
    if (!inWin.length) return;
    const f = inWin.length / 24, i = num(r.inputTokens) * f, o = num(r.outputTokens) * f;
    bfRow = bfRow || { name: BACKFILL, calls: 0, errors: 0, input: 0, output: 0, cached: 0, think: 0, durMs: 0, durCalls: 0, cost: 0, unpriced: 0, embedCalls: 0, embedTokens: 0, backfill: true };
    bfRow.calls += num(r.calls) * f; bfRow.input += i; bfRow.output += o; bfRow.unpriced += i + o;
    inWin.forEach((t) => bfHours.push({ t, v: (num(r.inputTokens) + num(r.outputTokens)) / 24 }));
  });

  const all = [...G.values()].map((g) => ({ ...g, total: g.input + g.output })).sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1));
  const kept = all.slice(0, TOP_N).map((g) => g.name).sort();
  const color = new Map(kept.map((n, i) => [n, PALETTE[i]]));
  const folded = all.length > TOP_N;
  const colorOf = (name) => (name === BACKFILL ? BACKFILL_C : color.get(name) || OTHER_C);
  const seriesOf = (name) => (color.has(name) ? name : OTHER);
  const picked = only && (all.some((g) => g.name === only) || (only === BACKFILL && bfRow)) ? only : "";
  const series = picked ? [picked] : kept.concat(folded && !color.has(OTHER) ? [OTHER] : []); // a real "other" kind absorbs the fold

  // chart columns
  const nCols = Math.max(1, Math.ceil(hours / step));
  const cols = Array.from({ length: nCols }, (_, i) => ({ start: from + i * step * HOUR, segs: new Map(), bf: 0 }));
  const colIx = (t) => Math.floor((t - from) / (step * HOUR));
  rows.forEach((r) => {
    if (isEmbed(r)) return;
    if (picked && groupKey(r, group) !== picked) return;
    const c = cols[colIx(num(r.start))];
    if (!c) return;
    const k = picked || seriesOf(groupKey(r, group));
    c.segs.set(k, (c.segs.get(k) || 0) + num(r.inputTokens) + num(r.outputTokens));
  });
  if (!picked || picked === BACKFILL) bfHours.forEach(({ t, v }) => { const c = cols[colIx(t)]; if (c) c.bf += v; });

  const table = bfRow ? all.concat([{ ...bfRow, total: bfRow.input + bfRow.output }]).sort((a, b) => b.total - a.total) : all;
  const T = table.reduce((t, g) => {
    t.calls += g.calls; t.errors += g.errors; t.input += g.input; t.output += g.output;
    t.cached += g.cached; t.think += g.think; t.durMs += g.durMs; t.durCalls += g.durCalls; t.cost += g.cost; t.unpriced += g.unpriced;
    t.embedCalls += g.embedCalls; t.embedTokens += g.embedTokens; return t;
  }, { calls: 0, errors: 0, input: 0, output: 0, cached: 0, think: 0, durMs: 0, durCalls: 0, cost: 0, unpriced: 0, embedCalls: 0, embedTokens: 0 });
  T.total = T.input + T.output;
  // The summary line counts the LLM only: the decision model and the
  // embedder are not LLM spend.
  const blank = () => ({ calls: 0, errors: 0, input: 0, output: 0, cached: 0, think: 0, durMs: 0, durCalls: 0, cost: 0, unpriced: 0 });
  const C = { llm: blank(), decision: blank(), embedding: blank() };
  rows.forEach((r) => {
    const k = String(r.kind || ""), c = C[k === "decision" || k === "embedding" ? k : "llm"];
    const i = num(r.inputTokens), o = num(r.outputTokens), cost = costOf(r);
    c.calls += num(r.calls); c.errors += num(r.errors); c.input += i; c.output += o;
    c.cached += num(r.cachedTokens); c.think += num(r.thinkingTokens);
    if (num(r.durationMs) > 0) { c.durMs += num(r.durationMs); c.durCalls += num(r.calls); }
    if (cost == null) c.unpriced += i + o; else c.cost += cost;
  });
  if (bfRow) { C.llm.calls += bfRow.calls; C.llm.input += bfRow.input; C.llm.output += bfRow.output; C.llm.unpriced += bfRow.unpriced; }
  Object.values(C).forEach((c) => { c.total = c.input + c.output; });
  return { from, to, hours, step, group, scope, picked, cols, series, colorOf, table, totals: T, cats: C, backfill: !!bfRow && (!picked || picked === BACKFILL), embed: sep, empty: !rows.length && !bfRow };
}

// The table's row names in display order, for moving a selection.
export function usageRows(slot, { win = "24h", group = "kind", scope = "" } = {}) {
  return slot && slot.data ? usageModel(slot.data, { hours: winOf(win).hours, group, scope }).table.map((g) => g.name) : [];
}

// ── chart (pure) ───────────────────────────────────────────────────────────
// Each column is one stack in eighths of a row; a character cell takes the
// colour of the series covering most of its filled part.
function stackCells(col, series, max) {
  const scale = (CHART_H * 8) / max;
  const bounds = []; // [series, lo, hi] in eighths
  let cum = 0, prev = 0;
  series.forEach((s) => {
    const v = col.segs.get(s) || 0;
    if (!v) return;
    cum += v;
    const hi = Math.round(cum * scale);
    bounds.push([s, prev, hi]); prev = hi;
  });
  let bf = false;
  if (col.bf > 0) { cum += col.bf; const hi = Math.round(cum * scale); bounds.push([BACKFILL, prev, hi]); prev = hi; bf = true; }
  let top = prev;
  if (cum > 0 && top === 0) { top = 1; bounds[bounds.length - 1][2] = 1; } // never hide a non-zero column
  const cells = [];
  for (let r = 0; r < CHART_H; r++) {
    const lo = r * 8, fill = Math.max(0, Math.min(8, top - lo));
    if (!fill) { cells.push(null); continue; }
    let best = null, bestN = 0;
    bounds.forEach(([s, a, b]) => { const n = Math.min(b, lo + fill) - Math.max(a, lo); if (n > bestN) { bestN = n; best = s; } });
    cells.push({ ch: EIGHTHS[fill - 1], s: best });
  }
  return { cells, bf };
}

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const p2 = (n) => String(n).padStart(2, "0");
// x labels in local time: hours for 24h, days (plus hours if room) for 7d.
function xLabels(m, cw) {
  const n = m.cols.length, width = n * cw;
  const line = Array(width).fill(" ");
  let lastEnd = -1;
  const put = (i, text) => {
    const at = i * cw;
    if (at <= lastEnd + 1 || at + text.length > width) return;
    for (let k = 0; k < text.length; k++) line[at + k] = text[k];
    lastEnd = at + text.length - 1;
  };
  if (m.hours <= 24) {
    const every = [1, 2, 3, 4, 6, 12].find((e) => (e / m.step) * cw >= 6) || 12;
    m.cols.forEach((c, i) => { const d = new Date(c.start); if (d.getHours() % every === 0) put(i, p2(d.getHours()) + ":00"); });
  } else {
    const perDay = (24 / m.step) * cw;
    m.cols.forEach((c, i) => {
      const d = new Date(c.start), h = d.getHours();
      if (h < m.step) put(i, perDay >= 7 ? DOW[d.getDay()] + " " + p2(d.getDate()) : DOW[d.getDay()]);
      else if (perDay >= 24 && h >= 12 && h - m.step < 12) put(i, "12h");
    });
  }
  return line.join("").replace(/\s+$/, "");
}

// Hours per column for the window at this many character columns.
export function stepFor(hours, budgetCh) {
  if (hours <= 24) return 1;
  return [1, 2, 3, 4, 6, 12, 24].find((s) => Math.ceil(hours / s) <= budgetCh) || 24;
}

export function chartHtml(m, widthCh = 100) {
  const totals = m.cols.map((c) => [...c.segs.values()].reduce((a, b) => a + b, 0) + c.bf);
  const max = Math.max(0, ...totals);
  const yTop = formatCount(max), gut = Math.max(yTop.length, 1) + 1;
  const budget = Math.max(m.cols.length, widthCh - gut - 2);
  const cw = Math.max(1, Math.min(4, Math.floor(budget / m.cols.length)));
  const glyphW = cw >= 2 ? cw - 1 : 1, gap = cw >= 2 ? " " : "";
  const stacks = m.cols.map((c) => (max > 0 ? stackCells(c, m.series, max) : { cells: [], bf: false }));
  const lines = [];
  for (let r = CHART_H - 1; r >= 0; r--) {
    const lab = r === CHART_H - 1 ? yTop : r === 0 ? "0" : "";
    let s = `<span class="fg-faint">${esc(lab.padStart(gut - 1))}${r === CHART_H - 1 || r === 0 ? "┤" : "│"}</span>`;
    stacks.forEach((st) => {
      const cell = st.cells[r];
      if (!cell) { s += " ".repeat(glyphW) + gap; return; }
      const col = st.bf && cell.s === BACKFILL ? BACKFILL_C : m.colorOf(cell.s);
      s += `<span style="color:${col}">${cell.ch.repeat(glyphW)}</span>${gap}`;
    });
    lines.push(s.replace(/\s+$/, ""));
  }
  lines.push(`<span class="fg-faint">${" ".repeat(gut - 1)}└${"─".repeat(m.cols.length * cw)}</span>`);
  lines.push(`<span class="fg-dim">${" ".repeat(gut)}${esc(xLabels(m, cw))}</span>`);
  const legend = m.series.concat(m.backfill ? [BACKFILL] : []).map((s) => `<span style="color:${m.colorOf(s)}">■</span> <span class="fg-text">${esc(s)}</span>`).join("   ");
  return `<pre class="uchart">${lines.join("\n")}</pre><div class="sigrow ulegend">${legend}</div>`;
}

// ── table (pure) ───────────────────────────────────────────────────────────
function shareBar(frac, w = 12) {
  const e = Math.round(Math.max(0, Math.min(1, frac)) * w * 8);
  const full = Math.floor(e / 8), part = e % 8;
  return "█".repeat(full) + (part ? HBAR[part - 1] : "");
}
function tableHtml(m, lim) {
  const sel = m.picked;
  const T = m.totals;
  // Name column fits the longest name ("■ " + name), at least the old 16ch,
  // capped so a runaway model id cannot push the numbers off screen.
  const nameCh = Math.min(36, Math.max(16, ...m.table.map((g) => String(g.name).length + 3)));
  const nameCell = (cls, inner) => `<span class="c${cls ? " " + cls : ""}" style="width:${nameCh}ch">${inner}</span>`;
  const head = `<div class="th">${nameCell("", esc(m.group.toUpperCase()))}${cellW(56, "r", "CALLS")}${cellW(64, "r", "INPUT")}${cellW(64, "r", "OUTPUT")}${cellW(64, "r opt", "CACHED")}${cellW(64, "r opt", "THINK")}${cellW(64, "r", "TOTAL")}${cellW(112, "", "SHARE")}${cellW(56, "r", "COST")}${cellW(64, "r opt", "TOK/CALL")}${cellW(64, "r opt", "AVG LAT")}${cellW(96, "r", "FAILED")}${m.embed ? cellW(64, "r opt", "EMBED") : ""}${lim ? cellW(LIMIT_W, "", "LIMIT TODAY") : ""}</div>`;
  const body = m.table.map((g) => {
    const c = g.name === BACKFILL ? BACKFILL_C : m.colorOf(g.name);
    const frac = T.total > 0 ? g.total / T.total : 0;
    const cost = g.backfill || (g.cost === 0 && g.unpriced > 0) ? DASH : fmtCost(g.cost) + (g.unpriced > 0 ? "+" : "");
    return `<div class="tr urow${g.name === sel ? " sel" : ""}" data-act="usesel" data-name="${esc(g.name)}">${nameCell("", `<span style="color:${c}">■</span> <span class="${g.backfill ? "fg-faint" : "fg-strong"}">${esc(g.name)}</span>`)}` +
      cellW(56, "r fg-text", formatCount(Math.round(g.calls))) +
      cellW(64, "r fg-dim", formatCount(g.input)) +
      cellW(64, "r fg-dim", formatCount(g.output)) +
      cellW(64, "r fg-dim opt", g.cached > 0 ? formatCount(g.cached) : DASH) +
      cellW(64, "r fg-dim opt", g.think > 0 ? formatCount(g.think) : DASH) +
      cellW(64, "r fg-strong", formatCount(g.total)) +
      `<span class="c" style="width:${112 / 13}em"><span class="ubar" style="color:${c}">${shareBar(frac, 8).padEnd(8, " ")}</span> <span class="fg-dim">${pct(g.total, T.total)}</span></span>` +
      cellW(56, "r fg-text", cost) +
      cellW(64, "r fg-dim opt", g.calls > 0 ? formatCount(Math.round(g.total / g.calls)) : DASH) +
      cellW(64, "r fg-dim opt", g.durCalls > 0 ? fmtMs(g.durMs / g.durCalls) : DASH) +
      cellW(96, "r " + (g.errors > 0 ? "fg-warn" : "fg-faint2"), g.backfill ? DASH : g.errors + " · " + pct(g.errors, g.calls)) +
      (m.embed ? cellW(64, "r fg-dim opt", g.embedCalls > 0 ? formatCount(Math.round(g.embedCalls)) : DASH) : "") +
      (lim ? limitCell(g.backfill ? null : limitOf(lim, g.name)) : "") +
      `</div>`;
  }).join("");
  return head + `<div class="rows">${body}</div>`;
}

// ── daily limits row (pure) ────────────────────────────────────────────────
// One line under the stats: today's (UTC) spend of the tenant in view as a
// share of its own total cap. With no tenant in view it is the tenant nearest
// its cap, named. Empty without status or a cap.
function limitsHtml(st, scope) {
  const tenants = st && st.limits && st.limits.tenants;
  if (!tenants) return "";
  const tone = (f) => (f >= 1 ? "fg-crit" : f >= 0.8 ? "fg-warn" : "fg-ok");
  const pill = (k, f, note = "") => `<span class="pill">${k ? `<span class="pk">${esc(k)}</span>` : ""}<span class="${tone(f)} b">${Math.round(f * 100)}%</span>${note ? `<span class="fg-faint">${esc(note)}</span>` : ""}</span>`;
  const spent = (t) => num((tenants[t] || {}).spent), capFor = (t) => num((tenants[t] || {}).cap);
  const who = scope || Object.keys(tenants).filter((t) => capFor(t) > 0).sort((a, c) => spent(c) / capFor(c) - spent(a) / capFor(a))[0] || "";
  // The tenant's own total cap; the call kinds' caps are the table's LIMIT TODAY column.
  const levels = [];
  if (who && capFor(who) > 0) levels.push(pill(scope ? "" : who, spent(who) / capFor(who), fmtLim(spent(who)) + "/" + fmtLim(capFor(who))));
  if (!levels.length) return "";
  return `<div class="hl ustats"><span class="pill" style="min-width:${LABEL_CH}ch"><span class="pk">limits today</span></span>${levels.join("")}</div>`;
}

// ── stat row (pure) ────────────────────────────────────────────────────────
// Summary label column width, so the values line up under each other.
const LABEL_CH = 13;

function statsHtml(m) {
  const C = m.cats;
  const v = (val, unit = "") => `<span class="fg-strong">${esc(val)}</span>${unit ? ` <span class="fg-text">${esc(unit)}</span>` : ""}`;
  const sep = `<span class="fg-faint2"> · </span>`;
  const line = (label, c, parts) => `<div class="hl ustats"><span class="pill" style="min-width:${LABEL_CH}ch"><span class="pk">${esc(label)}</span></span><span>${parts.filter(Boolean).join(sep)}</span></div>`;
  const common = (c, perCall) => [
    v(formatCount(c.total), "tokens"),
    v(formatCount(Math.round(c.calls)), "calls"),
    perCall && c.calls > 0 ? v(formatCount(Math.round(c.total / c.calls)), "per call") : "",
    c.durCalls > 0 ? v(fmtMs(c.durMs / c.durCalls), "avg") : "",
    c.errors > 0 ? `<span class="fg-warn">${esc(String(c.errors))} failed</span>` : "",
    c.total - c.unpriced > 0 ? v(fmtCost(c.cost), "est.") : "",
  ];
  // One line: the LLM total. The table below carries the rest, the
  // decision model and the embedder included.
  return line("LLM", C.llm, common(C.llm, true));
}

// ── daily limits (pure) ────────────────────────────────────────────────────
// For the model grouping: the daily budget a model draws on, from the status
// blob (limits; voiceQuota for voice). The text models (chat, guardrail, RCA)
// share one budget, the decision model and voice have their own. Scoped to a
// tenant it is that tenant's spend against its cap (the text budget falls
// back to the instance limit); with all tenants, the instance total against
// the instance limit. Returns model name → { spent, cap }, or null with no status.
function limitsFor(st, scope) {
  if (!st) return null;
  const cfg = st.config || {}, L = st.limits, tenants = (L && L.tenants) || {};
  const lt = scope ? tenants[scope] || {} : null;
  const text = L ? (scope ? { spent: num(lt.spent), cap: num(lt.cap) > 0 ? num(lt.cap) : num(L.cap) } : { spent: num(L.spent), cap: num(L.cap) }) : null;
  const decs = Object.values(tenants).map((t) => t.decision).filter(Boolean);
  const dec = !decs.length ? null : scope ? lt.decision || null : { spent: decs.reduce((a, d) => a + num(d.spent), 0), cap: 0 };
  const vq = st.voiceQuota, vcaps = (vq && vq.tenantCaps) || {};
  const vown = scope ? (vcaps[scope] != null ? vcaps[scope] : vcaps["*"]) : undefined;
  const voice = vq ? { spent: scope ? num((vq.byTenant || {})[scope]) : num(vq.tokensToday), cap: num(vown) > 0 ? num(vown) : num(vq.limit) > 0 ? num(vq.limit) : 0 } : null;
  const by = {};
  [cfg.model, cfg.guardrailModel, cfg.rcaModel].filter(Boolean).forEach((x) => { if (text) by[x] = text; });
  if (cfg.decisionModel && dec) by[cfg.decisionModel] = dec;
  [cfg.voiceModel, cfg.jucceModel].filter(Boolean).forEach((x) => { if (voice) by[x] = voice; });
  return Object.keys(by).length ? by : null;
}

// For the kind grouping: each reasoning call kind the core gates against its
// own daily cap, and the decision kind against the decision model's own
// per-tenant budget, straight from the status limits block — spend, cap and
// the gate holding the kind, the same answer the core's call gate gives
// (ADR-078). Voice and chat are metered on budgets of their own and get no
// cell. A kind cap is each tenant's own allowance (every loop runs per
// tenant), so the cell reads the scoped tenant's line, or with no tenant in
// view the line nearest its cap (a held one first).
// Returns kind → { spent, cap, blockedBy }, or null without status.
function kindLimitsFor(st, scope) {
  const tenants = st && st.limits && st.limits.tenants;
  if (!tenants) return null;
  const rows = scope ? [tenants[scope] || {}] : Object.values(tenants);
  const near = (l) => (l.blockedBy ? 2 : 0) + (num(l.cap) > 0 ? Math.min(1, num(l.spent) / num(l.cap)) : 0);
  const pick = (get) => rows.map(get).filter(Boolean).sort((a, b) => near(b) - near(a) || num(b.spent) - num(a.spent))[0] || null;
  const kinds = new Set();
  rows.forEach((t) => Object.entries(t.kinds || {}).forEach(([k, l]) => { if (num(l.cap) > 0 || l.blockedBy) kinds.add(k); }));
  const by = {};
  kinds.forEach((k) => { const l = pick((t) => (t.kinds || {})[k]); if (l) by[k] = l; });
  const dec = pick((t) => t.decision);
  if (dec) by.decision = dec;
  return Object.keys(by).length ? by : null;
}

// Exact model id, else the configured id that ends the ring's name or the other
// way round ("models/x" vs "x", "vendor/x" vs "x").
// LIMIT TODAY column width in px: bar, percent and spent/cap.
const LIMIT_W = 208;

const limitOf = (lim, name) => lim[name] || lim[Object.keys(lim).find((k) => name.endsWith("/" + k) || k.endsWith("/" + name)) || ""] || null;

function limitCell(l) {
  const w = `width:${LIMIT_W / 13}em`;
  if (!l) return `<span class="c fg-faint2" style="${w}">${DASH}</span>`;
  if (!(l.cap > 0)) return `<span class="c fg-faint" style="${w}">no limit ${formatCount(l.spent)}</span>`;
  const frac = l.spent / l.cap, tone = frac >= 1 ? "fg-crit" : frac >= 0.8 ? "fg-warn" : "fg-ok";
  return `<span class="c" style="${w}"><span class="ubar ${tone}">${shareBar(frac, 6).padEnd(6, " ")}</span> <span class="fg-text">${Math.round(frac * 100)}%</span> <span class="fg-dim">${fmtLim(l.spent)}/${fmtLim(l.cap)}</span></span>`;
}

// ── panel (pure given the slot) ────────────────────────────────────────────
// slot = { data, error, status, missing, at }; widthCh = panel width in characters.
export function usageView(slot, { win = "24h", group = "kind", scope = "", widthCh = 100, hasTenants = false, status = null, sel = "" } = {}) {
  const w = winOf(win);
  const toggle = (opts, cur) => opts.map((o) => (o === cur ? `<span class="fg-strong b">${esc(o)}</span>` : `<span class="fg-faint">${esc(o)}</span>`)).join(`<span class="fg-faint2"> · </span>`);
  const head = `<div class="tbar">${panelTitle("usage", scope)}<span class="fill"></span><span class="hint">${hasTenants ? "T to switch tenant · " : ""}w window · g group</span></div>
    <div class="sigrow"><span class="fg-label">window</span> ${toggle(WINDOWS.map((x) => x.id), w.id)}<span class="fg-faint2">   │   </span><span class="fg-label">group by</span> ${toggle(GROUPS, group)}${slot.at ? `<span class="fg-faint2">   │   updated ${esc(new Date(slot.at).toLocaleTimeString())} · every 60s</span>` : ""}</div>`;
  const wrap = (inner) => `<div class="col g6 sig usage">${head}${inner}</div>`;
  if (slot.missing) return wrap(`<div class="sigrow fg-dim">this core has no /v2/usage yet (needs core ≥ 572decea)</div>`);
  if (!slot.data) {
    if (slot.error) return wrap(`<div class="sigrow fg-crit">/v2/usage failed: ${esc(slot.error)}</div><div class="sigrow fg-faint">listed under ? · retries every 60s</div>`);
    return wrap(`<div class="sigrow fg-faint">loading /v2/usage?hours=${w.hours}…</div>`);
  }
  const step = stepFor(w.hours, Math.max(24, widthCh - 10));
  const m = usageModel(slot.data, { hours: w.hours, group, scope, step, only: sel });
  const stale = slot.error ? `<div class="sigrow fg-warn">refresh failed (${esc(slot.error)}) — showing the previous answer</div>` : "";
  const limits = limitsHtml(status, scope);
  if (m.empty) return wrap(stale + statsHtml(m) + limits + `<div class="sigrow fg-faint">no LLM calls in the last ${esc(w.id)}${scope ? " for " + esc(scope) : ""}</div>`);
  const cap = `tokens per ${step === 1 ? "hour" : step + "h"} · ` + (m.picked ? `${m.picked} only` : `stacked by ${group}`) + ` · local time` + (m.embed ? " · embeddings apart" : "") + (m.backfill ? " · muted: daily backfill (tenant only)" : "");
  return wrap(stale + statsHtml(m) + limits +
    sub(cap) + chartHtml(m, widthCh) +
    sub(`by ${group}`) + tableHtml(m, group === "model" ? limitsFor(status, scope) : group === "kind" ? kindLimitsFor(status, scope) : null));
}
