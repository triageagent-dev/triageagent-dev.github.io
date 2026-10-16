// Panel 5's live layer, ported from X-Ray (xray-ui lib/api.ts, memory-graph.tsx,
// stats-hud.tsx, category-config.ts, xray-view.tsx):
//   - GET /v2/memory/ws: "hit" frames light the cells a read touched (and wash
//     their kind's region); "change" frames upsert/delete cells live.
//   - GET /v2/memory?q=: server-side search over the full store, so a search
//     is not scoped to the cells this client happens to hold.
//   - GET /v2/memory/metrics every 30s while the map shows: the stats HUD.
//   - GET /v2/categories: per-deployment labels, sectors and tiers.
import { itemTenant } from "./api.js";

export const HIT_FADE_MS = 20000;     // a hit fades back to base over this long
const SEARCH_LIMIT = 300, SEARCH_PER_KIND = 25;
const METRICS_MS = 30000;
const FLUSH_MS = 400;                 // change frames are coalesced into one redraw

export const L = {
  hits: new Map(),      // id → ms the cell was hit
  regions: new Map(),   // kind → ms its region was washed
  labels: new Map(),    // kind → ms its watermark pulsed
  hitCount: 0,          // hit frames received this session
  lastQuery: "",        // the read that produced the latest hit
  search: { q: "", items: [], busy: false },
  metrics: null,        // normalised /v2/memory/metrics
  categories: null,     // kind → { label, tier, angle, color }
  wsOpen: false,
};

let ctx = null;         // { tenant, user, onRaw(fn), onRedraw() }
export function bindLive(c) { ctx = c; }

// ── memory event stream ──────────────────────────────────────────────────
// GCLB drops the socket at its backend timeout by design, so reconnecting is
// the steady state, not an error path: back off, never hammer.
let ws = null, retry = 0, timer = null;
const pending = new Map();
let flushT = null;

export function connectMemWS() {
  if (ws || !ctx) return;
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/v2/memory/ws";
  let sock;
  try { sock = new WebSocket(url); }
  catch (e) { schedule(); return; }
  ws = sock;
  sock.onopen = () => { if (sock === ws) { retry = 0; L.wsOpen = true; } };
  sock.onmessage = (ev) => {
    if (sock !== ws) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || !msg.data) return;
    if (msg.type === "hit") onHit(msg.data);
    else if (msg.type === "change") onChange(msg.data);
  };
  sock.onclose = () => { if (sock !== ws) return; ws = null; L.wsOpen = false; schedule(); };
}
function schedule() {
  if (timer) return;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(retry++, 5));
  timer = setTimeout(() => { timer = null; connectMemWS(); }, delay);
}
export function closeMemWS() {
  if (timer) { clearTimeout(timer); timer = null; }
  const s = ws; ws = null; L.wsOpen = false;
  if (s) try { s.close(); } catch (e) { /* already closed */ }
}

// A hit is ids plus, from newer cores, a parallel kinds array; the region
// wash resolves the kind from it even when the hit cell is not drawn.
function onHit(d) {
  const ids = Array.isArray(d.itemIds) ? d.itemIds : [];
  if (!ids.length) return;
  const now = Date.now();
  ids.forEach((id) => L.hits.set(id, now));
  if (Array.isArray(d.kinds) && d.kinds.length >= ids.length) {
    new Set(d.kinds).forEach((k) => { if (k) { L.regions.set(k, now); L.labels.set(k, now); } });
  }
  L.hitCount++;
  L.lastQuery = d.query || "";
  ctx.onRedraw();
}

// Upserts are gated on the tenant in view (the stream is filtered to grants,
// not to the selected tenant), and private cells stay off the shared map, as
// in X-Ray. Deletes carry only an id.
function onChange(d) {
  if (d.op === "upsert" && d.item && d.item.id) {
    if (d.item.scope === "private") return;
    const t = ctx.tenant(), it = itemTenant(d.item);
    if (t && it && it !== t) return;
    pending.set(d.item.id, { op: "upsert", item: d.item });
  } else if (d.op === "delete" && d.id) {
    pending.set(d.id, { op: "delete" });
  } else return;
  if (!flushT) flushT = setTimeout(flush, FLUSH_MS);
}
function flush() {
  flushT = null;
  if (!pending.size) return;
  const ops = [...pending.entries()];
  pending.clear();
  ctx.onRaw((raw) => {
    const box = raw.memory || raw.memSummary;
    if (!box) return false;
    const byId = new Map((box.items || []).map((i) => [i.id, i]));
    for (const [id, op] of ops) {
      if (op.op === "upsert") byId.set(id, { ...(byId.get(id) || {}), ...op.item });
      else byId.delete(id);
    }
    box.items = [...byId.values()];
    return true;
  });
}

// ── server-side search ──────────────────────────────────────────────────
// Bare text only: field: terms (id:, kind:, tag: …) stay a local filter.
let searchT = null, searchSeq = 0;
export function searchFor(text) {
  const q = String(text || "").trim();
  if (q === L.search.q) return;
  clearTimeout(searchT);
  L.search = { q, items: [], busy: !!q };
  if (!q || /(^|\s)(id|kind|title|content|subject|tag):/.test(q)) { L.search.busy = false; return; }
  const seq = ++searchSeq;
  searchT = setTimeout(async () => {
    try {
      const p = new URLSearchParams({ q, limit: String(SEARCH_LIMIT), perKind: String(SEARCH_PER_KIND) });
      if (ctx.tenant()) p.set("tenant", ctx.tenant());
      const d = await getJSON("/v2/memory?" + p);
      if (seq !== searchSeq) return;
      L.search = { q, items: Array.isArray(d.items) ? d.items : [], busy: false };
    } catch (e) {
      if (seq !== searchSeq) return;
      L.search = { q, items: [], busy: false };
    }
    ctx.onRedraw();
  }, 300);
}

// ── metrics HUD ─────────────────────────────────────────────────────────
let metricsT = null;
export function pollMetrics(on) {
  if (!on) { clearInterval(metricsT); metricsT = null; return; }
  if (metricsT) return;
  const tick = async () => {
    try {
      const p = ctx.tenant() ? "?tenant=" + encodeURIComponent(ctx.tenant()) : "";
      L.metrics = normalizeMetrics(await getJSON("/v2/memory/metrics" + p));
      ctx.onRedraw();
    } catch (e) { /* the HUD keeps its last sample */ }
  };
  tick();
  metricsT = setInterval(tick, METRICS_MS);
}

// The wire names each block after its server stats struct; the HUD reads them
// under X-Ray's names (stats-hud.tsx normalizeMetrics).
function normalizeMetrics(d) {
  const s = d.memorySearchStats;
  return {
    // Active cells, as the map draws them; items also counts stale and archived.
    items: ((d.composition || {}).byStatus || {}).active ?? d.items ?? 0,
    voice: d.voice || null,
    quota: d.quota || null,
    search: s ? { total: s.total || 0, keywordHits: s.keywordHits || 0, kwTrigramHits: s.kwTrigramHits || 0, kwVoiceHits: s.kwVoiceHits || 0, kwVoiceMisses: s.kwVoiceMisses || 0, semanticCalls: s.semanticCalls || 0, semanticFallbacks: s.semanticFallbacks || 0 } : null,
    embed: d.embed || null,
    llmBudget: d.llmBudget || null,
    llm: d.llmStats || null,
    classifier: d.classifierStats || null,
    guardrail: d.guardrailStats || null,
    rag: d.ragStats || null,
    semanticCache: d.semanticCacheStats || null,
    tools: d.tools || null,
  };
}

export function hudRows() {
  const m = L.metrics;
  if (!m) return [];
  const f = (n) => Number(n || 0).toLocaleString();
  const rows = [["memory", f(m.items)]];
  if (m.voice) { rows.push(["voice sessions", f(m.voice.totalCalls)]); if (m.voice.activeCalls > 0) rows.push(["voice active", f(m.voice.activeCalls)]); }
  if (m.quota) rows.push(["audio quota", m.quota.limit === 0 ? "unlimited" : f(m.quota.used) + " / " + f(m.quota.limit)]);
  if (m.search) {
    const s = m.search;
    rows.push(["searches", f(s.total)]);
    if (s.keywordHits > 0) rows.push(["kw hits", f(s.keywordHits)]);
    if (s.kwTrigramHits > 0) rows.push(["trigram hits", f(s.kwTrigramHits)]);
    if (s.kwVoiceHits > 0) rows.push(["kw voice hits", f(s.kwVoiceHits)]);
    if (s.kwVoiceMisses > 0) rows.push(["kw voice miss", f(s.kwVoiceMisses)]);
    if (s.semanticCalls > 0) rows.push(["semantic", f(s.semanticCalls)]);
    if (s.semanticFallbacks > 0) rows.push(["sem fallbacks", f(s.semanticFallbacks)]);
  }
  if (m.embed) { if (m.embed.embedCalls > 0) rows.push(["embeddings", f(m.embed.embedCalls)]); if (m.embed.cacheHits > 0) rows.push(["embed cached", f(m.embed.cacheHits)]); }
  if (m.semanticCache && m.semanticCache.hits > 0) rows.push(["sem cache hits", f(m.semanticCache.hits)]);
  if (m.rag) { if (m.rag.retrievals > 0) rows.push(["rag retrievals", f(m.rag.retrievals)]); if (m.rag.hits > 0) rows.push(["rag hits", f(m.rag.hits)]); }
  if (m.classifier) {
    const c = m.classifier;
    if (c.signal > 0) rows.push(["signal", f(c.signal)]);
    if (c.noise > 0) rows.push(["noise", f(c.noise)]);
    if (c.issue > 0) rows.push(["issue", f(c.issue)]);
    if (c.unknown > 0) rows.push(["unclassified", f(c.unknown)]);
    if (c.embeddingCalls > 0) rows.push(["classifier embeds", f(c.embeddingCalls)]);
  }
  if (m.guardrail) { if (m.guardrail.noiseDropped > 0) rows.push(["noise dropped", f(m.guardrail.noiseDropped)]); if (m.guardrail.infraPassed > 0) rows.push(["infra passed", f(m.guardrail.infraPassed)]); }
  if (m.llm) {
    if (m.llm.calls > 0) rows.push(["llm calls", f(m.llm.calls)]);
    if (m.llm.agentCalls > 0) rows.push(["agent calls", f(m.llm.agentCalls)]);
    if (m.llm.promptTokens > 0) rows.push(["prompt tokens", f(m.llm.promptTokens)]);
    if (m.llm.completionTokens > 0) rows.push(["completion tokens", f(m.llm.completionTokens)]);
  }
  if (m.llmBudget && m.llmBudget.limit > 0) rows.push(["llm budget", f(m.llmBudget.tokensToday) + " / " + f(m.llmBudget.limit)]);
  if (m.tools) Object.entries(m.tools).forEach(([n, t]) => { if (t && t.calls > 0) rows.push([n, t.calls + "× " + Math.round(t.avg_us || 0) + "µs"]); });
  return rows;
}

// ── categories ──────────────────────────────────────────────────────────
// A deployment may relabel (and re-sector) the kinds; with none configured
// the map keeps its built-in sectors and the raw kind names.
export async function loadCategories() {
  try {
    const d = await getJSON("/v2/categories");
    const cats = Array.isArray(d.categories) ? d.categories : [];
    if (!cats.length) return;
    const n = cats.length, out = {};
    cats.forEach((c, i) => {
      if (!c || !c.kind || c.tag || out[c.kind]) return;
      out[c.kind] = {
        label: c.label || String(c.kind).replace(/_/g, " "),
        tier: typeof c.tier === "number" ? c.tier : 0.6,
        angle: typeof c.angle === "number" ? c.angle : (i * 2 * Math.PI) / n,
      };
    });
    L.categories = out;
    ctx.onRedraw();
  } catch (e) { /* keep the built-in sectors */ }
}

// ── fades ───────────────────────────────────────────────────────────────
// Elapsed ms of a live fade, or -1 once it has run out. The panel is redrawn
// from scratch on every update, so the SVG carries the elapsed time as a
// negative animation-delay and the fade carries on where it was.
export function fadeAge(map, key, span = HIT_FADE_MS) {
  const t = map.get(key);
  if (t == null) return -1;
  const age = Date.now() - t;
  if (age >= span) { map.delete(key); return -1; }
  return age;
}

async function getJSON(path) {
  const res = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(path + " → " + res.status);
  return res.json();
}
