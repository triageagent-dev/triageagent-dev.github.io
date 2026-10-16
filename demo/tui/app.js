// Triage TUI — browser client that renders the Triage core's live data the
// way `triagectl` does. Plain ES module, no build step.
import * as API from "./api.js";
import { esc, panelTitle, v, sub, kv, cellW, jumpSec } from "./ui.js";
import { sampleSignals, signalsPanel, scorecardRows, sparkline, humanizeLeadMs } from "./signals.js";
import * as APV from "./approvals.js";
import { goalsPanel, goalsSetPanel, adoptableGoals, readGoals, loadOwnGoals, saveOwnGoals, graphSvg, bubbleTone, setSignalWindow, cycleSignalWindow } from "./goals.js";
import { treemapHtml, GROUPS, SIZES } from "./treemap.js";
import { logicPanel, tenantSum, dur, PATHS as PROC_PATHS } from "./logic.js";
import { GOAL_KEYS, stepGoal } from "./rings.js";
import * as VOICE from "./voice.js";
import { memMapSvg, kindLabel } from "./memmap.js";
import * as LIVE from "./memlive.js";
import * as USE from "./usage.js";
import * as CHAT from "./chat.js";
import { classifierBox, decisionBox } from "./statbox.js";

const { DASH, ago, fullTime, formatCount, parseSourceKind, eventGroupKey, kindColor, oneLine } = API;

// ── constants ───────────────────────────────────────────────────────────────
// status + concerns arrive live over /v2/agent/ws; everything else (apps,
// graph, analytics, memory) is re-read quietly on this cadence.
const RESYNC_MS = 5 * 60 * 1000;
const TENANT_KEY = "triage-tui.tenant";
const KEYS_KEY = "triage-tui.keys"; // on-screen key row: "shown" or absent (hidden, the default)
const THEME_KEY = "triage-tui.theme"; // colour scheme: "dim" or absent (the bright default)
const PANELS = ["goal", "app", "con", "pred", "mem", "sig", "logic", "gset", "use", "chat", "cfg"];
const READY_CYCLE = ["", "not-ready", "ready", "unknown", "drift", "virtual"];
const SEV_CYCLE = ["", "critical", "warning", "info"];
const SEV_ORDER = { critical: 0, warning: 1, info: 2 };
const RELATED_MAX = 10;   // related events listed on an issue; the rest are counted in the heading

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } },
};

function applyTheme(dim) {
  document.documentElement.toggleAttribute("data-theme", dim);
  if (dim) document.documentElement.dataset.theme = "dim";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dim ? "#17181f" : "#1b1d2b";
}
applyTheme(store.get(THEME_KEY) === "dim");

// ── state ───────────────────────────────────────────────────────────────────
const S = {
  conn: "connecting",      // connecting | live | error | auth
  D: null, raw: null,
  failed: [],
  lastRefresh: null, lastAttempt: null,
  refreshing: false,
  loadError: null,
  tenantPref: store.get(TENANT_KEY) || "",
  keysShown: store.get(KEYS_KEY) === "shown",
  shiftHeld: false,
  showStats: false, // panel 3's classifier and decision boxes; "?" there swaps them in, hidden on every visit
  panel: "goal",
  filterText: "", filterEditing: false,
  clusterFilter: "", nsFilter: "", sevFilter: "", readyFilter: "",
  sel: { app: -1, con: 0, evt: 0, mem: -1, tnt: 0, pred: 0, pat: 0 },
  focus2: "con",           // panel 3 focus: con | evt
  showLoop: false,         // panel 7: "?" swaps the diagram for the issues (left) and patterns (right) lists
  focus7: "con",           // panel 7 loop view focus: con | pat
  detail7: null,           // panel 7 loop view detail: { kind, i }
  memView: "map",          // panel 5: map (Voronoi) | list (list + detail); ? toggles
  memBack: false,          // panel 5: the detail was opened from the map; esc goes back there
  useWin: "24h",           // panel 9: 24h | 7d; w cycles
  useGroup: "kind",        // panel 9: kind | tenant | model; g cycles
  appView: "graph",        // panel 2 right side: graph | treemap; m toggles
  tmGroup: "ns",           // panel 2 treemap grouping: ns | domain | tier
  tmSize: "weight",        // panel 2 treemap tile size: weight | traffic
  procPath: "all",         // panel 7: the path highlighted (logic.js PATHS); p cycles
  detail2: null,           // { kind: "con"|"evt", i }
  goalEdit: null,          // <8> the goals panel: { i } the goal picked
  flash: "", flashT: 0,
  scrollSel: false,
  progOpen: "", // <4> the prognosis cell shown in full
  predOpen: false, // <4> the selected bubble shown in full on the left
  logoutConfirm: false,    // q armed the y/n gate
  tntOpen: false,          // T opened the tenant picker modal
  epoch: 0,                // bumped by logout so an in-flight refresh is dropped
};

// ── helpers ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const nowMs = () => Date.now();
const sevClass = (s) => ({ critical: "fg-crit", warning: "fg-warn", info: "fg-info" }[String(s || "").toLowerCase()] || "fg-dim");
const sevBadge = (s) => {
  const k = String(s || "").toLowerCase();
  if (k === "critical") return "CRIT";
  if (k === "warning") return "WARN";
  if (k === "info") return "INFO";
  return (k || "?").toUpperCase().slice(0, 4);
};
const statusWord = (s) => {
  const k = String(s || "").toLowerCase();
  if (k === "new") return { t: "open", c: "fg-crit" };
  if (k === "investigating") return { t: "investigating", c: "fg-warn" };
  if (k === "resolved") return { t: "resolved", c: "fg-ok" };
  return { t: s || DASH, c: "fg-dim" };
};
const flash = (msg) => { S.flash = msg; S.flashT = Date.now(); renderCrumb(); setTimeout(() => { if (Date.now() - S.flashT >= 2900) { S.flash = ""; renderCrumb(); } }, 3000); };
const agoS = (ts) => { const a = ago(ts, nowMs()); return a === DASH ? "" : a + " ago"; };
const matches = (hay) => !S.filterText || hay.toLowerCase().includes(S.filterText.toLowerCase());

// ── derived lists (filters applied like the CLI's filtered* functions) ─────
function appRows() {
  if (!S.D) return [];
  return S.D.apps.rows.filter((r) => {
    switch (S.readyFilter) {
      case "ready": if (!r.readyKnown || !r.ready) return false; break;
      case "not-ready": if (!r.readyKnown || r.ready) return false; break;
      case "unknown": if (r.readyKnown || r.drift) return false; break;
      case "drift": if (!r.drift) return false; break;
      case "virtual": if (!r.virtual) return false; break;
      case "real": if (r.drift || r.virtual) return false; break;
    }
    if (S.clusterFilter && r.cluster !== S.clusterFilter) return false;
    if (S.nsFilter && r.ns !== S.nsFilter) return false;
    return matches([r.name, r.cluster, r.ns, r.version].join(" "));
  });
}
const clusterNsOk = (source, at) => {
  const sk = at || parseSourceKind(source);
  const clusters = sk.clusters || [sk.cluster], namespaces = sk.namespaces || [sk.ns];
  if (S.clusterFilter && !clusters.includes(S.clusterFilter)) return false;
  if (S.nsFilter && !namespaces.includes(S.nsFilter)) return false;
  return true;
};
function conRows() {
  if (!S.D) return [];
  return S.D.concerns.filter((c) => (!S.sevFilter || c.severity === S.sevFilter) && clusterNsOk(c.source, c) && matches([c.id, c.summaryFull, c.source, c.status].join(" ")));
}
function evtGroups() {
  if (!S.D) return [];
  const order = [], groups = new Map();
  S.D.events.list.forEach((e) => {
    if (S.sevFilter && e.severity !== S.sevFilter) return;
    if (!clusterNsOk(e.source)) return;
    if (!matches([e.id, e.message, e.source, e.type].join(" "))) return;
    const k = eventGroupKey(e);
    const g = groups.get(k);
    if (g) { g.count++; return; }
    groups.set(k, { e, count: 1 });
    order.push(k);
  });
  return order.map((k) => groups.get(k));
}
// Forecast bubbles under this score are not drawn: the core ranks every service with a live signal, down to one stray event.
const PRED_MIN = 25;
function predRows() {
  if (!S.D) return [];
  return S.D.predictions.filter((p) => (p.p || 0) >= PRED_MIN && (!S.clusterFilter || p.cluster === S.clusterFilter) && matches(p.svc + " " + p.cluster));
}
function actRows() {
  if (!S.D) return [];
  return S.D.activity.rows.filter((r) => (!S.clusterFilter || r.cluster === S.clusterFilter) && matches(r.n + " " + r.cluster));
}
// Memory search: id: kind: title: content: subject: tag: — bare text searches
// every field; terms are AND-ed (memory.go).
// Bare-text search also asks the core (GET /v2/memory?q=, as X-Ray did), so
// it covers the whole store; its results join the local matches.
function memRows() {
  if (!S.D) return [];
  const terms = S.filterText.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const local = memLocal(terms);
  const sr = LIVE.L.search;
  if (!terms.length || sr.q !== S.filterText.trim() || !sr.items.length) return local;
  const seen = new Set(local.map((it) => it.id)), scope = S.D.tenant;
  const extra = sr.items
    .filter((it) => it && it.id && !seen.has(it.id) && (!it.status || it.status === "active"))
    .filter((it) => !scope || !API.itemTenant(it) || API.itemTenant(it) === scope)
    .map((it) => ({ ...it, tenantTag: API.itemTenant(it), shared: !!scope && !API.itemTenant(it), backlinks: [] }));
  return local.concat(extra);
}
function memLocal(terms) {
  return S.D.mem.items.filter((it) => terms.every((t) => {
    const m = t.match(/^(id|kind|title|content|subject|tag):(.*)$/);
    const f = (x) => String(x || "").toLowerCase();
    if (m) {
      const q = m[2];
      if (m[1] === "id") return f(it.id).includes(q);
      if (m[1] === "kind") return f(it.kind).includes(q) || f(it.kind).replace(/_/g, " ").includes(q);
      if (m[1] === "title") return f(it.title).includes(q);
      if (m[1] === "content") return f(it.content).includes(q);
      if (m[1] === "subject") return f(it.subject).includes(q);
      if (m[1] === "tag") return (it.tags || []).some((x) => f(x).includes(q));
    }
    return [it.id, it.kind, it.title, it.subject, it.content, (it.tags || []).join(" ")].some((x) => f(x).includes(t));
  }));
}
function tntRows() {
  if (!S.D) return [];
  return S.D.tenants;
}
// Panel 7's loop view: the patterns in memory, newest first, the tenant's
// own and the shared ones, narrowed by / like the other lists.
const AUTHOR_TAG = "author/", SERVICE_TAG = "service/";
const tagVal = (it, p) => { const t = (it.tags || []).find((x) => String(x).startsWith(p)); return t ? String(t).slice(p.length) : ""; };
function patRows() {
  if (!S.D) return [];
  return S.D.mem.items.filter((it) => String(it.kind || "").includes("pattern") && matches([it.id, it.title, it.subject, (it.tags || []).join(" ")].join(" ")));
}
// Panel 7's loop view lists only the latest issues; the other panels list them all.
const LOOP_ISSUES = 25;
function loopConRows() { return conRows().slice(0, LOOP_ISSUES); }
function listFor(name) {
  return { app: appRows, con: S.panel === "logic" ? loopConRows : conRows, evt: evtGroups, mem: memRows, tnt: tntRows, pred: predRows, pat: patRows }[name]();
}
function clamp(name) {
  const n = listFor(name).length;
  // -1 is "nothing selected": panel 2 then shows the service graph, panel 5 its analytics.
  if (name === "mem" || name === "app") { if (S.sel[name] >= n) S.sel[name] = n - 1; return; }
  if (S.sel[name] >= n) S.sel[name] = Math.max(0, n - 1);
  if (S.sel[name] < 0) S.sel[name] = 0;
}

// ── data loading ────────────────────────────────────────────────────────────
// ── live feed: /v2/agent/ws (client/ws.go) ─────────────────────────────────
// The core pushes {status, issues} on every state change. The session
// cookie rides the same-origin upgrade. Frames are applied at most once a
// second; a dropped socket reconnects with backoff.
let ws = null, wsRetry = 0, wsTimer = null, wsPending = null, wsApplyAt = 0;
function connectWS() {
  if (ws || S.conn === "auth") return;
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/v2/agent/ws";
  try { ws = new WebSocket(url); }
  catch (e) { ws = null; scheduleWS(); return; }
  const epoch = S.epoch, sock = ws;
  sock.onopen = () => { if (sock !== ws) return; wsRetry = 0; S.wsOpen = true; if (S.D) S.conn = "live"; renderChrome(); };
  sock.onmessage = (ev) => { if (sock === ws && epoch === S.epoch) queueFrame(ev.data); };
  sock.onclose = () => {
    if (sock !== ws) return;
    ws = null; S.wsOpen = false;
    if (S.conn === "live") S.conn = "connecting";
    renderChrome();
    scheduleWS();
  };
}
function scheduleWS() {
  if (wsTimer || S.conn === "auth") return;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(wsRetry++, 5));
  wsTimer = setTimeout(() => { wsTimer = null; connectWS(); }, delay);
}
function closeWS() {
  if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
  const s = ws; ws = null; S.wsOpen = false;
  if (s) try { s.close(); } catch (e) { /* already closed */ }
}
function queueFrame(data) {
  wsPending = data;
  const wait = Math.max(0, wsApplyAt + 1000 - Date.now());
  setTimeout(applyFrame, wait);
}
function applyFrame() {
  if (!wsPending || !S.raw || !S.D) return;
  let f;
  try { f = JSON.parse(wsPending); } catch (e) { wsPending = null; return; }
  wsPending = null; wsApplyAt = Date.now();
  if (!f || (!f.status && !f.issues)) return;
  if (f.status) { S.raw.status = f.status; sampleSignals(f.status); }
  if (f.issues) S.raw.issues = f.issues;
  S.D = API.mapAll(S.raw, S.D.tenant, nowMs());
  sampleApps(S.D);
  S.lastRefresh = Date.now();
  render();
}

// Panel 5's live layer starts with the first good load: the memory event
// stream, the deployment's categories and — until a real
// hit arrives — X-Ray's opening flash on the three newest news cells.
let memLiveUser = null;
function memLiveStart() {
  LIVE.connectMemWS();
  if (memLiveUser === S.D.user) return;
  const first = memLiveUser === null;
  memLiveUser = S.D.user;
  if (!first) return;
  LIVE.loadCategories();
  if (!LIVE.L.hitCount) {
    const now = Date.now();
    S.D.mem.items.filter((it) => it.kind === "recent_change")
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .slice(0, 3).forEach((it) => LIVE.L.hits.set(it.id, now));
  }
}
let memDrawQueued = false;
function memRedraw() {
  if (memDrawQueued) return;
  memDrawQueued = true;
  requestAnimationFrame(() => { memDrawQueued = false; if (S.D && S.panel === "mem") renderPanel(); });
}

// The core's landing page as data (GET /v2/landing, public):
// version, who is signed in or where to sign in, the onboarding runbook and
// the instance-wide event count. Read on every refresh, before sign-in too.
async function loadLanding() {
  try {
    const r = await fetch("/v2/landing", { credentials: "same-origin" });
    if (!r.ok) return;
    S.landing = await r.json();
    if (!S.D) render();
  } catch (e) { /* the core is unreachable; the error screen covers it */ }
}

async function refresh() {
  if (S.refreshing) return;
  loadLanding();
  S.refreshing = true;
  S.lastAttempt = Date.now();
  const epoch = S.epoch;
  if (!S.D) S.conn = "connecting";
  renderChrome();
  try {
    const res = await API.fetchLive({ tenant: S.tenantPref });
    if (epoch !== S.epoch) return; // signed out while this was in flight
    // A failed endpoint keeps its previous payload (same tenant only), so one
    // flaky call never blanks a panel; the failure is listed under '?'.
    const raw = res.raw;
    if (S.raw && S.D && S.D.tenant === res.tenant) {
      res.failed.forEach((f) => { if (raw[f.key] == null && S.raw[f.key] != null) { raw[f.key] = S.raw[f.key]; f.stale = true; } });
    }
    if (raw.status && !res.failed.some((f) => f.key === "status")) sampleSignals(raw.status);
    S.raw = raw;
    S.failed = res.failed;
    if (S.clusterFilter || S.nsFilter) loadScopedHealth();
    S.D = API.mapAll(raw, res.tenant, nowMs());
    sampleApps(S.D);
    S.conn = S.wsOpen ? "live" : "connecting";
    S.loadError = null;
    S.lastRefresh = Date.now();
    connectWS();
    memLiveStart();
  } catch (e) {
    if (epoch !== S.epoch) return;
    S.failed = e.failed || [{ key: "all", path: e.path || "", status: e.status, error: String(e.message || e) }];
    if (e.status === 401 || e.status === 403) {
      S.conn = "auth";
      S.D = null;
    } else {
      S.conn = "error";
      S.loadError = String(e.message || e);
    }
  } finally {
    S.refreshing = false;
    render();
  }
}

function scopeTenant(id) {
  if (!id) return;
  S.tenantPref = id;
  store.set(TENANT_KEY, id);
  if (S.D && S.D.tenant === id) { flash("already scoped to " + id); return; }
  S.sel = { app: -1, con: 0, evt: 0, mem: -1, tnt: S.sel.tnt, pred: 0, pat: 0 };
  S.detail2 = null;
  S.clusterFilter = ""; S.nsFilter = "";
  flash("scoping to " + id + "…");
  refresh();
}

// ── rendering: chrome ──────────────────────────────────────────────────────
function connView() {
  switch (S.conn) {
    case "live": return { t: "Connected", c: "fg-ok" };
    case "connecting": return { t: "Connecting…", c: "fg-warn" };
    case "auth": return { t: "Sign-in required", c: "fg-crit" };
    default: return { t: S.D ? "Error — showing last data" : "Error", c: "fg-crit" };
  }
}

// The bundle's own build version, shipped as version.txt at the bundle root
// (the mobile app reads the same file).
let uiVersion = "";
fetch(new URL("../version.txt", import.meta.url), { cache: "no-store" })
  .then((r) => (r.ok ? r.text() : ""))
  .then((t) => { uiVersion = String(t).trim().split(/\s+/)[0] || ""; if (uiVersion && $("tabbar")) { renderTabBar(); if (S.D && S.panel === "cfg") render(); } })
  .catch(() => {});

function renderTabBar() {
  const ver = S.D && S.D.coreVersion ? S.D.coreVersion : null;
  $("tabbar").innerHTML =
    `<svg class="ti" viewBox="0 0 200 200" width="20" height="20" style="transform:rotate(-90deg)" aria-hidden="true"><circle cx="100" cy="100" r="84" fill="none" stroke="#8b8bf0" stroke-width="16" stroke-linecap="round" stroke-dasharray="422 528"/><circle cx="100" cy="100" r="56" fill="none" stroke="#22d3ee" stroke-width="16" stroke-linecap="round" stroke-dasharray="264 352"/><circle cx="100" cy="100" r="28" fill="none" stroke="#e879f9" stroke-width="16" stroke-linecap="round" stroke-dasharray="123 176"/></svg>` +
    `<span class="tname">Triage</span>` +
    `<span class="fill"></span>` +
    `<span class="ver">${[uiVersion ? "tui " + esc(uiVersion) : "", ver ? "core " + esc(ver) : ""].filter(Boolean).join(" · ")}</span>` +
    (S.D && S.D.user ? `<span class="who fg-mag"><span class="dot"></span>${esc(S.D.user)}</span>` : `<span class="who fg-faint2">not logged in</span>`) +
    // Voice in place (voice.js, the mobile client): click to talk, click again to end.
    `<button type="button" class="iconbtn voicebtn ${VOICE.V.conn === "open" ? "v-" + VOICE.V.agent : VOICE.V.conn === "connecting" ? "v-connecting" : ""}" data-act="voice" ` +
      `title="${VOICE.active() ? "voice " + (VOICE.V.conn === "open" ? VOICE.V.agent : "connecting") + " — click to end" : "voice — click to talk"}" aria-pressed="${VOICE.active()}">` +
      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>` +
        `<path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>` +
      `</svg>` +
    `</button>`;
}

function renderCrumb() {
  const bits = [];
  const chip = (label, val, clear) => `<button type="button" class="fchip" data-act="clear" data-v="${clear}"><span>${esc(label)}</span><span class="fg-strong">${esc(val)}</span><span class="x">&#215;</span></button>`;
  if (S.filterText && !S.filterEditing) bits.push(chip("/", S.filterText, "text"));
  if (S.readyFilter && S.panel === "app") bits.push(chip("state", S.readyFilter, "ready"));
  if (S.sevFilter && S.panel === "con") bits.push(chip("sev", S.sevFilter, "sev"));
  if (S.clusterFilter) bits.push(chip("cluster", S.clusterFilter, "cluster"));
  if (S.nsFilter) bits.push(chip("ns", S.nsFilter, "ns"));
  if (VOICE.active()) bits.push(`<span class="vline"><span class="fg-violet">voice ${esc(VOICE.V.conn === "open" ? VOICE.V.agent : "connecting…")}</span>${VOICE.V.last ? " " + esc(VOICE.V.last) : ""}</span>`);
  else if (VOICE.V.error) bits.push(`<span class="fg-crit">voice: ${esc(VOICE.V.error)}</span>`);
  if (S.flash) bits.push(`<span class="flash">${esc(S.flash)}</span>`);
  $("crumb-info").innerHTML = bits.join("");
  const p = $("prompt");
  if (p.hidden === S.filterEditing) p.hidden = !S.filterEditing;
}

function renderLegend() {
  const P = S.panel;
  // Shifted keys (the capitals) are shown only while Shift is held — the
  // hardware key, or the latching ⇧ on the on-screen key row. '?' is always shown.
  const chip = (key, label, act, opts = {}) => (/^[A-Z]$/.test(key) && !S.shiftHeld) ? "" :
    `<button type="button" class="chip${opts.on ? " on" : ""}${opts.na ? " na" : ""}${opts.busy ? " busy" : ""}" data-act="key" data-k="${esc(act)}"><span class="kk">&lt;${esc(key)}&gt;</span><span class="kl${opts.val ? " val" : ""}">${esc(label)}</span></button>`;
  const panelChip = (key, label, id) => chip(key, label, key, { on: P === id });
  const extra = [];
  if (P === "chat") extra.push(...CHAT.legend(chip));
  if (P === "sig" && APV.approvalsShown()) {
    if (APV.confirming()) extra.push(chip("y", "yes", "y"), chip("n", "no", "n"));
    else extra.push(chip("enter", "approve/revoke", "Enter"));
  }
  if (P === "mem") extra.push(chip("/", "search", "/"));
  if (P === "app") {
    extra.push(chip("m", S.appView === "treemap" ? "graph" : "treemap", "m"));
    if (S.appView === "treemap") extra.push(chip("g", "by " + S.tmGroup, "g", { val: true }), chip("z", "by " + S.tmSize, "z", { val: true }));
  }
  if (P === "logic") extra.push(chip("p", "path " + S.procPath, "p", { val: true }));
  if (P === "use") extra.push(chip("w", S.useWin, "w", { val: true }), chip("g", "by " + S.useGroup, "g", { val: true }));
  $("legend").innerHTML = [
    panelChip("1", "goals", "goal"),
    panelChip("2", "app", "app"),
    panelChip("3", "evnt", "con"),
    panelChip("4", "frkst", "pred"),
    panelChip("5", "mem", "mem"),
    panelChip("6", "sources", "sig"),
    panelChip("7", "proc", "logic"),
    panelChip("8", "goals", "gset"),
    panelChip("9", "usage", "use"),
    panelChip("0", "tria", "chat"),
    chip("T", "tenant", "T", { on: S.tntOpen }),
    P === "mem" ? chip("?", S.memView === "map" ? "list" : "map", "?") : P === "con" ? chip("?", "cfg", "?", { on: S.showStats }) : P === "logic" ? chip("?", S.showLoop ? "proc" : "patterns", "?", { on: S.showLoop }) : panelChip("?", "cfg", "cfg"),
    ...extra,
    chip("D", document.documentElement.dataset.theme === "dim" ? "bright" : "dim", "D"),
    chip("q", S.logoutConfirm ? "sign out? y/n" : "quit", "q", { on: S.logoutConfirm }),
    `<button type="button" class="chip keys-toggle${S.keysShown ? " on" : ""}" data-act="keys" aria-pressed="${S.keysShown}" title="${S.keysShown ? "hide keys" : "show keys"}"><i class="ph-fill ph-keyboard" style="margin:0;font-size:16px;"></i></button>`,
  ].join("");
  $("keybar").classList.toggle("keys-hidden", !S.keysShown);
}

function renderChrome() {
  renderTabBar();
  renderCrumb();
  renderLegend();
}

// ── rendering: panels ──────────────────────────────────────────────────────
function renderPanel() {
  if (!S.D) return; // the splash covers the screen until the first snapshot
  const el = $("panel");
  // Keep list scroll positions across re-renders.
  const saved = {};
  el.querySelectorAll("[data-scroll]").forEach((n) => { saved[n.dataset.scroll] = n.scrollTop; });
  let html;
  if (S.panel === "chat") html = CHAT.chatPanel();
  else if (S.panel === "cfg") html = cfgPanel();
  else if (S.panel === "goal") html = goalsPanel(S.D, { ...S.raw, scopedHealth: scopedHealthNow() }, goalsInForce(), goalScope());
  else if (S.panel === "logic") html = S.showLoop ? loopPanel() : logicPanel(S.D, S.raw, S.procPath);
  else if (S.panel === "gset") html = goalsSetPanel(S.D, S.raw, goalsInForce(), S.goalEdit);
  else if (S.panel === "sig") html = signalsPanel(S.D, S.raw, S.D.tenants.length > 0, APV.approvalsSection());
  else if (S.panel === "use") html = USE.usageView(USE.usageSlot(S.useWin), { win: S.useWin, group: S.useGroup, scope: S.D.tenant || "", widthCh: panelCh(el), hasTenants: S.D.tenants.length > 0, status: (S.raw && S.raw.status) || null });
  else html = { app: appPanel, con: conPanel, pred: predPanel, mem: memPanel }[S.panel]();
  if (S.logoutConfirm) html = logoutBox() + html;
  // A live redraw must not take the caret out of a box being typed in.
  const fa = document.activeElement, fid = fa && fa.id && el.contains(fa) ? fa.id : "";
  const caret = fid && typeof fa.selectionStart === "number" ? fa.selectionStart : null;
  el.innerHTML = html;
  fitRows(el);
  if (fid && $(fid)) { const n = $(fid); n.focus({ preventScroll: true }); if (caret != null) try { n.setSelectionRange(caret, caret); } catch (e) { /* not a text box */ } }
  el.querySelectorAll("[data-scroll]").forEach((n) => { if (saved[n.dataset.scroll] != null) n.scrollTop = saved[n.dataset.scroll]; });
  // The modal owns the selection while it is open.
  if (S.scrollSel && !S.tntOpen) { S.scrollSel = false; revealSel(el); }
  if (S.panel === "chat") CHAT.afterRender(el);
  LIVE.pollMetrics(!!S.D && S.panel === "mem" && S.memView === "map");
  USE.pollUsage(!!S.D && S.panel === "use");
}
// A list marked data-fit gets a fixed height: the room left in the terminal
// body less the tallest box under the lists (.sbox), so the boxes start at the
// same place however many rows a list has and the panel fills the screen. On a
// narrow screen the columns stack and the lists keep their own cap.
function fitRows(el) {
  const term = $("term");
  const stacked = window.matchMedia("(max-width: 899px)").matches;
  const lists = el.querySelectorAll("[data-fit]");
  lists.forEach((n) => { n.style.height = ""; n.style.maxHeight = ""; });
  if (stacked) return;
  let below = 0;
  el.querySelectorAll(".sbox").forEach((b) => { below = Math.max(below, b.offsetHeight + 4); });
  lists.forEach((n) => {
    const top = n.getBoundingClientRect().top - term.getBoundingClientRect().top + term.scrollTop;
    const pad = parseFloat(getComputedStyle(term).paddingBottom) || 0;
    const h = Math.max(160, Math.floor(term.clientHeight - top - pad - below)) + "px";
    n.style.height = h; n.style.maxHeight = h;
  });
}
// The panel's width in monospace characters (panel 9 sizes its chart to it).
let chPx = 0;
function panelCh(el) {
  if (!chPx) {
    const s = document.createElement("span");
    s.textContent = "0".repeat(40);
    s.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    el.appendChild(s);
    chPx = s.getBoundingClientRect().width / 40;
    s.remove();
  }
  return chPx > 0 ? Math.floor(el.clientWidth / chPx) - 2 : 100;
}

function revealSel(el) {
  el.querySelectorAll(".tr.sel").forEach((n) => {
    const box = n.closest("[data-scroll]");
    if (!box) return;
    const top = n.offsetTop - box.offsetTop, bottom = top + n.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  });
}

function logoutBox() {
  const who = (S.D && S.D.user) || "this user";
  return `<div class="box confirm" style="margin-bottom:12px">
    <div class="fg-strong b">sign out?</div>
    <p class="para">This signs out <span class="fg-mag">every</span> session of <span class="fg-strong">${esc(who)}</span> on this core — the Triage UI and triagectl logins too — and clears everything this page keeps in the browser (the stored API token).</p>
    <div class="btnrow"><button type="button" class="btn primary" data-act="logout-yes">y — sign out</button><button type="button" class="btn" data-act="logout-no">n — cancel</button></div>
  </div>`;
}

// The splash covers the whole screen until the first snapshot: connecting,
// the login page (signed out; the core names the way in, its one SSO provider
// or its login page), or the core's error with a retry.
function splashPage() {
  if (S.conn === "auth") {
    const signIn = (S.landing && S.landing.signIn) || "/login";
    return splash(`<div class="btnrow">
      <a class="btn primary" href="${esc(signIn)}"><i class="ph ph-sign-in"></i>sign in</a>
    </div>`);
  }
  if (S.conn === "error") {
    return splash(`<div><span class="fg-crit">✗ </span><span class="fg-dim">${esc(S.loadError || "no response from core")}</span></div>
    <div class="btnrow">
      <button type="button" class="btn primary" data-act="retry"><i class="ph ph-arrow-clockwise"></i>retry</button>
    </div>`);
  }
  return splash();
}
// The boot wordmark (the CLI splash, reading TRIAGE).
const SPLASH_ART = [
  "████████╗██████╗ ██╗ █████╗  ██████╗ ███████╗",
  "╚══██╔══╝██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝",
  "   ██║   ██████╔╝██║███████║██║  ███╗█████╗  ",
  "   ██║   ██╔══██╗██║██╔══██║██║   ██║██╔══╝  ",
  "   ██║   ██║  ██║██║██║  ██║╚██████╔╝███████╗",
  "   ╚═╝   ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
].join("\n");
function splash(body) {
  const ver = S.landing && S.landing.version;
  return `<div class="splash">
    <pre class="splash-art">${SPLASH_ART}</pre>
    ${ver ? `<div class="fg-dim">${esc(ver)}</div>` : ""}
    ${body || `<div><span class="fg-dim">◌ connecting to </span>${esc(location.origin)}<span class="fg-dim"> …</span></div>`}
  </div>`;
}

// <2> applications
function appPanel() {
  const D = S.D, rows = appRows(), C = D.apps.counts;
  clamp("app");
  const selRow = S.sel.app >= 0 ? rows[S.sel.app] || null : null;
  const filt = (label, n, state, dot, ring) => `<button type="button" class="filt${S.readyFilter === state ? " on" : ""}" data-act="readyf" data-v="${state}"><span class="dot" style="${ring ? "background:transparent;box-shadow:inset 0 0 0 1.5px var(--faint)" : "background:" + dot}"></span>${label} ${n}</button>`;
  const blastFg = (b) => b == null ? "fg-faint2" : D.graph.issueThreshold != null && b >= D.graph.issueThreshold ? "fg-warn" : b > 0 ? "fg-text" : "fg-faint2";
  const list = rows.map((r, i) => {
    const on = i === S.sel.app;
    const dot = r.drift ? `<span class="rdot dash"></span>` : !r.readyKnown ? `<span class="rdot ring"></span>` : `<span class="rdot" style="background:${r.ready ? "var(--ok)" : "var(--crit)"}"></span>`;
    const ready = r.drift ? { t: "drift", c: "fg-faint" } : !r.readyKnown ? { t: DASH, c: "fg-faint2" } : r.ready ? { t: "healthy", c: "fg-ok" } : { t: "unhlth", c: "fg-warn" };
    return `<div class="tr${on ? " sel" : ""}" data-act="sel" data-list="app" data-i="${i}">
      <span class="mark">${on ? "&#9654;" : ""}</span>${dot}
      <span class="c flex">${esc(r.name)}${r.virtual ? ` <span class="fg-faint">v</span>` : ""}</span>
      ${cellW(64, "fg-violet", r.cluster || DASH)}
      ${cellW(72, "fg-label opt", r.ns || DASH)}
      ${cellW(52, "r " + blastFg(r.blast), r.blast == null ? DASH : r.blast.toFixed(2) + (r.weight && r.weight !== 1 ? " ×" + r.weight : ""))}
      ${cellW(70, "r fg-dim opt", r.cs)}
      ${cellW(64, "r " + ready.c, ready.t)}
    </div>`;
  }).join("");
  return `<div class="grid fill">
    <div class="col g6">
      <div class="tbar">${panelTitle(`applications(${esc(C.all)})`, D.tenant)}<span class="fill"></span><span class="hint">tap a row · <b>s</b> cycles state</span></div>
      <div class="filters">
        ${filt("All", C.all, "", "var(--dim)")}
        ${filt("healthy", C.ready, "ready", "var(--ok)")}
        ${filt("unhlth", C.notReady, "not-ready", "var(--crit)")}
        ${C.unknown ? filt("unknown", C.unknown, "unknown", "", true) : ""}
        ${C.drift ? filt("drift", C.drift, "drift", "var(--faint2)") : ""}
        ${C.virtual ? filt("virtual", C.virtual, "virtual", "var(--accent)") : ""}
      </div>
      <div class="th"><span class="mark"></span><span style="width:0.69em;flex-shrink:0"></span><span class="c flex">SERVICE</span>${cellW(64, "", "CLUSTER")}${cellW(72, "opt", "NS")}${cellW(52, "r", "BLAST")}${cellW(70, "r opt", "CS/CBY/T")}${cellW(64, "r", "READY")}</div>
      <div class="rows-fill"><div class="rows tall" data-scroll="app">${list || `<div class="empty">${D.apps.loaded ? "no service matches these filters" : "applications and graph unavailable"}</div>`}</div></div>
    </div>
    <div class="col g6">${selRow ? appDetail(selRow) : graphPane()}</div>
  </div>`;
}
// The right side before an application is picked (and after esc): the service graph.
// While the list is filtered, the graph shows the listed apps and their
// direct dependencies (what they call and what calls them) only.
function graphPane() {
  const g = S.raw && S.raw.graph, all = g && Array.isArray(g.nodes) ? g.nodes : [];
  const filtered = !!(S.filterText || S.readyFilter || S.clusterFilter || S.nsFilter);
  const toggle = `<span class="tmopts"><span class="hint"><b>m</b></span>${[["graph", "graph"], ["treemap", "treemap"]].map(([v, l]) => `<button type="button" class="filt${S.appView === v ? " on" : ""}" data-act="appview" data-v="${v}">${l}</button>`).join("")}</span>`;
  if (S.appView === "treemap") return treemapPane(toggle);
  if (!filtered) {
    return `<div class="tbar"><span class="t">service graph(${all.length})</span><span class="fill"></span>${toggle}</div>${graphSvg(g)}`;
  }
  const focus = new Set(appRows().map((r) => r.name));
  const keep = new Set(focus);
  all.forEach((n) => (Array.isArray(n.calls) ? n.calls : []).forEach((c) => {
    if (focus.has(n.name)) keep.add(c);
    if (focus.has(c)) keep.add(n.name);
  }));
  const nodes = all.filter((n) => keep.has(n.name));
  return `<div class="tbar"><span class="t">service graph(${nodes.length} of ${all.length})</span><span class="fill"></span>${toggle}</div>${graphSvg({ ...g, nodes }, focus)}`;
}
// cycleTm steps a treemap option (S.tmGroup / S.tmSize) through its list.
function cycleTm(key, list) {
  const ids = list.map((x) => x[0]);
  S[key] = ids[(ids.indexOf(S[key]) + 1) % ids.length];
  render();
}
// The treemap view of the listed apps (filters apply): grouped and sized as
// picked, coloured by readiness, a warning border on a service with an
// open issue; a tap opens the app's detail like a list row.
function treemapPane(toggle) {
  const rows = appRows();
  const open = new Set(S.D.concerns.filter((c) => c.status.toLowerCase() !== "resolved").map((c) => c.source.split("/").pop()));
  const opt = (act, cur, list) => list.map(([v, l]) => `<button type="button" class="filt${cur === v ? " on" : ""}" data-act="${act}" data-v="${v}">${l}</button>`).join("");
  return `<div class="tbar"><span class="t">service treemap(${rows.length})</span><span class="fill"></span>${toggle}</div>
    <div class="filters tmbar"><span class="fg-dim"><b class="fg-violet">g</b> group</span>${opt("tmgroup", S.tmGroup, GROUPS)}<span class="fill"></span><span class="fg-dim"><b class="fg-violet">z</b> size</span>${opt("tmsize", S.tmSize, SIZES)}</div>
    ${treemapHtml(rows, { by: S.tmGroup, size: S.tmSize, issueSvcs: open })}`;
}
// Golden-signal rows for one app — red / use / golden, the same text the
// CLI (goldenSignalLines in core mcp agent_tools.go) prints. A family whose
// own as-of marker is 0 renders no row and no zero.
const psiPct = (v) => (v === 0 ? "0%" : v < 0.1 ? v.toFixed(2) + "%" : v < 10 ? v.toFixed(1) + "%" : v.toFixed(0) + "%");
const fmtB = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + "Gi" : b >= 1048576 ? (b / 1048576).toFixed(0) + "Mi" : b >= 1024 ? (b / 1024).toFixed(0) + "Ki" : b.toFixed(0) + "B";
const trimF = (v) => v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
const agoUnix = (u) => { const s = Math.max(0, Math.floor(nowMs() / 1000 - u)); return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : Math.floor(s / 86400) + "d"; };
function goldenRows(g) {
  if (!g) return "";
  const n = (x) => (typeof x === "number" ? x : 0);
  const rate = n(g.rateAsOfUnix) > 0, sat = n(g.saturationAsOfUnix) > 0, util = n(g.utilizationAsOfUnix) > 0;
  const rows = [];
  if (rate) rows.push(["red", "fg-crit", `${n(g.reqPerSec).toFixed(1)} rps · ${n(g.errPct).toFixed(1)}% err${n(g.p99Ms) > 0 ? " · p99 " + Math.round(g.p99Ms) + "ms" : ""} · ${agoUnix(g.rateAsOfUnix)} ago`]);
  if (sat || util) {
    const cl = [];
    if (util) {
      const pm = [];
      let mem;
      if (n(g.memBytes) > 0 && n(g.memLimitBytes) > 0) { mem = `mem ${fmtB(g.memBytes)}/${fmtB(g.memLimitBytes)}`; if (n(g.memPct) > 0) pm.push(psiPct(g.memPct) + " lim"); }
      else if (n(g.memBytes) > 0) mem = `mem ${fmtB(g.memBytes)}`;
      else mem = n(g.memPct) > 0 ? `mem ${psiPct(g.memPct)} of limit` : "mem";
      if (n(g.memNodePct) > 0) pm.push(psiPct(g.memNodePct) + " node");
      if (n(g.memReqPct) > 0) pm.push(psiPct(g.memReqPct) + " req");
      cl.push(mem + (pm.length ? ` (${pm.join(", ")})` : ""));
      if (n(g.cpuLimitCores) > 0 || n(g.cpuNodePct) > 0 || n(g.cpuReqPct) > 0) {
        const pc = [];
        let cpu = "cpu";
        if (n(g.cpuLimitCores) > 0) { cpu = `cpu ${trimF(g.cpuLimitCores * n(g.cpuPct) / 100)}/${trimF(g.cpuLimitCores)} cores`; pc.push(psiPct(n(g.cpuPct)) + " lim"); }
        if (n(g.cpuNodePct) > 0) pc.push(psiPct(g.cpuNodePct) + " node");
        if (n(g.cpuReqPct) > 0) pc.push(psiPct(g.cpuReqPct) + " req");
        cl.push(cpu + (pc.length ? ` (${pc.join(", ")})` : ""));
      }
    }
    if (sat) { cl.push(`psi cpu ${psiPct(n(g.cpuPsiPct))} mem ${psiPct(n(g.memPsiPct))} io ${psiPct(n(g.ioPsiPct))}`); cl.push(`oom ${n(g.oomKills)}`); }
    const worst = Math.max(util ? levelOf("mem", n(g.memPct)) : 0, util ? levelOf("cpu", n(g.cpuLimitCores) > 0 ? n(g.cpuPct) : n(g.cpuNodePct)) : 0,
      sat ? levelOf("psi", Math.max(n(g.cpuPsiPct), n(g.memPsiPct), n(g.ioPsiPct))) : 0, sat && n(g.oomKills) > 0 ? 2 : 0);
    rows.push(["use", ["fg-ok", "fg-warn", "fg-crit"][worst], `${cl.join(" · ")} · ${agoUnix(Math.max(n(g.saturationAsOfUnix), n(g.utilizationAsOfUnix)))} ago`]);
  }
  // The last log window that crossed the agent's gate; its own marker, so a
  // service that never logged an anomaly shows no row and no zero.
  if (n(g.logAsOfUnix) > 0) rows.push(["log", n(g.logErrors) > 0 || n(g.logWarns) > 0 ? "fg-warn" : "fg-ok", `${n(g.logErrors)} errors · ${n(g.logWarns)} warns · ${n(g.logTotal)} lines · ${agoUnix(g.logAsOfUnix)} ago`]);
  if (rate || sat || util) {
    const p = [];
    if (rate) { if (n(g.p99Ms) > 0) p.push(`lat ${Math.round(g.p99Ms)}ms`); p.push(`net ${n(g.reqPerSec).toFixed(1)} rps`, `err ${n(g.errPct).toFixed(1)}%`); }
    if (sat) p.push("sat " + psiPct(Math.max(n(g.cpuPsiPct), n(g.memPsiPct), n(g.ioPsiPct))));
    if (util) { p.push("util mem " + psiPct(n(g.memPct))); if (n(g.cpuLimitCores) > 0) p.push("cpu " + psiPct(n(g.cpuPct))); }
    rows.push(["golden", "fg-golden", p.join(" · ")]);
  }
  if (!rows.length) return "";
  return `<div class="grows">${rows.map(([l, c, t]) => `<div class="grow"><span class="gl ${c}">${l}</span><span class="gt">${esc(t)}</span></div>`).join("")}</div>`;
}
// Per-app golden-signal history, recorded in the browser: the core keeps
// signal history per tenant only, so these sparklines start empty on page
// load and gain a point each time an app's golden as-of time moves.
const APP_RING_CAP = 60;
const appRings = new Map();
const appKey = (r) => r.cluster + "/" + r.ns + "/" + r.name;
function sampleApps(D) {
  if (!D || !D.apps) return;
  const n = (x) => (typeof x === "number" ? x : 0);
  D.apps.rows.forEach((r) => {
    const g = r.golden;
    if (!g) return;
    const at = Math.max(n(g.rateAsOfUnix), n(g.saturationAsOfUnix), n(g.utilizationAsOfUnix));
    if (!at) return;
    const k = appKey(r), ring = appRings.get(k) || [];
    if (ring.length && ring[ring.length - 1].at === at) return;
    ring.push({
      at,
      rps: n(g.reqPerSec), err: n(g.errPct), p99: n(g.p99Ms),
      mem: n(g.memPct), cpu: n(g.cpuLimitCores) > 0 ? n(g.cpuPct) : n(g.cpuNodePct),
      psi: Math.max(n(g.cpuPsiPct), n(g.memPsiPct), n(g.ioPsiPct)),
    });
    if (ring.length > APP_RING_CAP) ring.splice(0, ring.length - APP_RING_CAP);
    appRings.set(k, ring);
  });
}
// The signals panel's sparkline rows (label · value · bars), one per golden
// series the app reports; the text rows stay underneath for the detail.
// Percent series are drawn against 100% (92% reads tall, 0.1% sits on the
// floor) and coloured by pressure level, so a service near its limit shows
// red rather than the family's usual green. Thresholds follow the agent and
// core: memory pressure at the agent's default 85% of limit, a PSI stall
// from 1% (usePsiDominanceThreshold).
const APP_SPARK_W = 30;
const LEVELS = {
  mem: [70, 85], cpu: [70, 85], psi: [1, 10], err: [1, 5],
};
const levelOf = (key, v) => { const t = LEVELS[key]; return !t ? 0 : v >= t[1] ? 2 : v >= t[0] ? 1 : 0; };
const LEVEL_C = ["var(--ok)", "var(--warn)", "var(--crit)"];
const LEVEL_CLS = ["fg-strong", "fg-warn", "fg-crit"];
function pctSpark(vals) {
  const G = "▁▂▃▄▅▆▇█";
  return vals.map((v) => (v <= 0 ? G[0] : G[Math.max(1, Math.min(7, Math.ceil((v / 100) * 7)))])).join("");
}
function goldenSparks(r) {
  const g = r.golden, ring = appRings.get(appKey(r));
  if (!g || !ring || !ring.length) return "";
  const n = (x) => (typeof x === "number" ? x : 0);
  const rate = n(g.rateAsOfUnix) > 0, sat = n(g.saturationAsOfUnix) > 0, util = n(g.utilizationAsOfUnix) > 0;
  const tail = ring.slice(-APP_SPARK_W), last = tail[tail.length - 1];
  const pad = `<span class="fg-faint2">${"▁".repeat(APP_SPARK_W - tail.length)}</span>`;
  // pct: drawn against 100% and coloured by the latest value's level;
  // otherwise scaled to the row's own peak in the family colour.
  const row = (label, val, key, color, pct, note = "") => {
    const vals = tail.map((x) => x[key]);
    let bars, c = color, cls = "fg-strong";
    if (pct) {
      const lv = levelOf(key, last[key]);
      bars = pctSpark(vals); c = vals.some((x) => x > 0) ? (LEVELS[key] ? LEVEL_C[lv] : color) : "var(--faint2)"; cls = LEVEL_CLS[lv];
    } else {
      const sp = sparkline(vals, APP_SPARK_W);
      bars = sp.glyphs; if (!(sp.max > 0)) c = "var(--faint2)";
    }
    return `<div class="sigrow"><span class="sl">${label}</span><span class="sn wide ${cls}">${esc(val)}</span>${pad}<span class="spark" style="color:${c}">${bars}</span>${note ? `<span class="${cls}" style="white-space:nowrap">  ${esc(note)}</span>` : ""}</div>`;
  };
  let html = "";
  if (rate) {
    html += row("net", last.rps.toFixed(1) + "rps", "rps", "var(--info)", false);
    html += row("err", last.err.toFixed(1) + "%", "err", "var(--crit)", true);
    if (n(g.p99Ms) > 0) html += row("p99", Math.round(last.p99) + "ms", "p99", "#fb8a7e", false);
  }
  if (util) {
    const ml = levelOf("mem", last.mem);
    html += row("mem", psiPct(last.mem), "mem", "var(--ok)", true, ml === 2 ? "near limit" : ml === 1 ? "high" : "");
    if (n(g.cpuLimitCores) > 0 || n(g.cpuNodePct) > 0) html += row("cpu", psiPct(last.cpu), "cpu", "var(--ok)", true, levelOf("cpu", last.cpu) === 2 ? "cpu pressure" : "");
  }
  if (sat) html += row("psi", psiPct(last.psi), "psi", "var(--warn)", true, levelOf("psi", last.psi) ? "stalling" : "");
  if (sat && n(g.oomKills) > 0) html += `<div class="sigrow"><span class="sl">oom</span><span class="sn wide fg-crit">${n(g.oomKills)}</span><span class="fg-crit">OOM kills</span></div>`;
  if (!html) return "";
  const span = ring.length > 1 ? humanizeLeadMs((ring[ring.length - 1].at - ring[0].at) * 1000) : "";
  return sub("signals · " + ring.length + (ring.length === 1 ? " sample" : " samples") + (span ? " · last ~" + span : "") + " · since page load") + html;
}
function appDetail(r) {
  if (!r) return `<span class="fg-faint">nothing selected</span>`;
  const D = S.D, node = r.node;
  const ready = r.readyKnown ? (r.ready ? { t: "yes", c: "fg-ok" } : { t: "no", c: "fg-crit" }) : { t: "unknown", c: "fg-faint" };
  const readyAge = r.observedAt && agoS(r.observedAt) ? "reported " + agoS(r.observedAt) : "";
  let html = `<span class="fg-mag">${esc(r.name)}</span><div class="kvs">`;
  html += kv("Service:", r.name, "fg-strong b");
  html += kv("Cluster:", r.cluster, "fg-violet");
  html += kv("Namespace:", r.ns, "fg-label");
  html += kv("Ready:", ready.t, ready.c, readyAge);
  if (r.drift) html += `<div class="note">undeclared — observed on ${esc(r.cluster)}, ~${esc(r.driftCalls)} calls in window; not in the ${esc(r.driftTenant)} graph.</div>`;
  else if (r.virtual) html += `<div class="note">virtual app — synthesized from workload labels by the cluster agent; no Application CR.</div>`;
  else if (!r.readyKnown) html += `<div class="note">no Application CR reports for this service</div>`;
  html += kv("Components:", r.comps, "fg-strong");
  if (r.replicas) html += kv("Replicas:", r.replicas, r.partial ? "fg-warn" : "fg-strong");
  if (r.version) html += kv("Version:", r.version, "fg-violet");
  html += `</div>`;
  html += goldenSparks(r) + goldenRows(r.golden);
  if (node) {
    const b = typeof node.blastRadius === "number" ? node.blastRadius : 0;
    const warn = D.graph.issueThreshold != null && b >= D.graph.issueThreshold;
    html += `<div class="blast"><span class="k">Blast radius:</span><span class="bar"><span style="width:${Math.max(1, Math.min(100, Math.round(b * 100)))}%;background:${warn ? "var(--warn)" : "#5d5294"}"></span></span><span class="v">${b.toFixed(2)}${node.weight && node.weight !== 1 ? " ×" + esc(node.weight) : ""}</span></div>`;
    // Blast radius sets an issue's severity, never whether it opens (core ADR-061).
    const band = node.tier >= 4 ? "info" : API.severityBand(b, D.graph.noiseThreshold, D.graph.issueThreshold);
    if (band) html += `<div class="kvs">${kv("Severity band:", band, sevClass(band) + " b", "issues on it open as " + band)}</div>`;
    const down = D.graph.downstream(node.name), up = D.graph.upstream(node.name);
    html += sub("Transitive dependencies");
    html += `<div class="kvs">${kv("downstream (" + down.length + "):", down.length ? down.join(", ") : "none", down.length ? "fg-text" : "fg-faint", "", "w126")}${kv("upstream (" + up.length + "):", up.length ? up.join(", ") : "none", up.length ? "fg-text" : "fg-faint", "", "w126")}</div>`;
    if (node.description) html += sub("Description") + `<p class="para">${esc(node.description)}</p>`;
    const meta = [node.domain && "domain " + node.domain, node.team && "team " + node.team, node.tier != null && "tier " + node.tier].filter(Boolean).join(" · ");
    if (meta) html += `<span class="note">${esc(meta)}</span>`;
  }
  html += ledgerSection(r);
  if (r.components.length) {
    html += sub("Components");
    html += r.components.map((c) => `<div class="kv"><span class="fg-faint">&#8226;</span><span class="v fg-text" style="flex:1">${esc((c.kind || "") + "/" + (c.name || ""))}</span><span class="${/ready|running|healthy/i.test(c.status || "") ? "fg-ok" : "fg-warn"}">${esc(c.status || DASH)}</span></div>`).join("");
  }
  if (node) {
    const calls = node.calls || [], calledBy = node.calledBy || [];
    const declared = new Set(node.declared_calls || []), declaredBy = new Set(node.declared_called_by || []);
    html += sub("Service map neighbors");
    html += `<span class="fg-text">Calls (${calls.length}) &#183; Called by (${calledBy.length})</span>`;
    const nb = (n, arrow, color, role, isDeclared) => {
      const peer = D.graph.byName.get(n);
      const score = peer && typeof peer.blastRadius === "number" ? " (" + peer.blastRadius.toFixed(2) + ")" : "";
      return `<button type="button" class="nb" data-act="jump" data-v="${esc(n)}"><span class="arrow" style="color:${color}">${arrow}</span><span class="c flex">${esc(n)}<span class="fg-faint">${esc(score)}</span></span><span class="fg-faint">${esc(role)}${isDeclared ? "" : " · observed"}</span></button>`;
    };
    if (!calls.length && !calledBy.length) html += `<span class="note">no direct neighbors in the service graph</span>`;
    html += calls.map((n) => nb(n, "&#8595;", "var(--faint)", "calls", declared.has(n))).join("");
    html += calledBy.map((n) => nb(n, "&#8593;", "var(--violet)", "called by", declaredBy.has(n))).join("");
  }
  return html;
}

// Events the core counted against this service instance in the last 24h,
// by family (core ADR-061 service ledger), so "nothing arrived" never reads
// the same as "everything was dropped". Falls back to all of the service's
// rows when no row matches the instance.
const LEDGER_FAMILIES = ["level", "request", "log", "resource", "pod", "provider", "other"];
function ledgerSection(r) {
  const L = S.D.ledger;
  if (!L || !L.loaded) return "";
  const cluster = r.cluster && r.cluster !== "default" ? r.cluster : "";
  const own = L.byKey.get(r.name + "|" + cluster + "/" + (r.ns || ""));
  const rows = own ? [own] : (L.byService.get(r.name) || []);
  let html = sub("Events (24h)");
  if (!rows.length) return html + `<span class="note">none counted on this core since it started</span>`;
  const now = nowMs();
  rows.forEach((row) => {
    if (rows.length > 1 || !own) html += `<span class="fg-faint">${esc(row.instance || "no instance")} · last ${esc(agoS(row.lastSeen))}</span>`;
    const fams = LEDGER_FAMILIES.filter((f) => row.families && row.families[f]);
    html += `<div class="kvs">` + fams.map((f) => {
      const c = row.families[f];
      const firing = c.runSince ? "firing for " + ago(c.runSince, now) : "";
      return kv(f + ":", "10m " + c.last10m + " · 1h " + c.last1h + " · 24h " + c.last24h, c.last10m ? "fg-warn" : "fg-text", firing);
    }).join("") + `</div>`;
  });
  return html;
}

// <3> concerns / events
function conPanel() {
  const D = S.D, cons = conRows(), groups = evtGroups();
  const statusBlob = (S.raw && S.raw.status) || {};
  const det = S.detail2;
  // Rows arrive on top while a detail is open, which slides every index down
  // one: follow the row the detail was opened on by its key, and keep the
  // highlight on it. If it has gone, the detail keeps showing what was opened.
  const keyOf = { con: (c) => c && c.id, evt: (g) => g && eventGroupKey(g.e) };
  if (det && keyOf[det.kind]) {
    const rows = det.kind === "con" ? cons : groups, key = keyOf[det.kind];
    if (det.key === undefined) { det.key = key(rows[det.i]); det.row = rows[det.i]; }
    else {
      const at = rows.findIndex((r) => key(r) === det.key);
      if (at >= 0) { if (S.sel[det.kind] === det.i) S.sel[det.kind] = at; det.i = at; det.row = rows[at]; }
    }
  }
  clamp("con"); clamp("evt");
  const openCount = D.concerns.filter((c) => c.status.toLowerCase() !== "resolved").length;
  const conList = () => {
    const focus = S.focus2 === "con";
    const rows = cons.map((c, i) => {
      const on = i === S.sel.con, isOpen = c.status.toLowerCase() !== "resolved", sw = statusWord(c.status);
      return `<div class="tr${on ? " sel" : ""}${on && !focus ? " blur" : ""}${isOpen ? " open" : ""}" data-act="sel" data-list="con" data-i="${i}">
        <span class="mark">${on ? "&#9654;" : ""}</span>
        ${cellW(124, "fg-violet", c.id)}
        ${cellW(40, sevClass(c.severity) + " b", sevBadge(c.severity))}
        ${cellW(36, "fg-dim", c.age)}
        <span class="c flex${isOpen ? " fg-strong" : ""}">${esc(c.summary)}</span>
        ${cellW(76, sw.c + " opt", sw.t)}
        ${cellW(56, "fg-ok opt", c.cluster || DASH)}
        ${cellW(84, "fg-label opt", c.ns || DASH)}
      </div>`;
    }).join("");
    return `<div class="col">
      <div class="tbar${focus ? "" : " off"}">${panelTitle(`issues(${cons.length})`, D.tenant, ` &#183; ${openCount} open`)}<span class="fill"></span><span class="hint">double-tap for detail</span></div>
      <div class="th"><span class="mark"></span>${cellW(124, "", "ID")}${cellW(40, "", "SEV")}${cellW(36, "", "AGE")}<span class="c flex">SUMMARY</span>${cellW(76, "opt", "STATUS")}${cellW(56, "opt", "CLUSTER")}${cellW(84, "opt", "NS")}</div>
      <div class="rows" data-scroll="con" data-fit>${rows || `<div class="empty">${S.raw && S.raw.issues ? "no issues in history" : "issues unavailable"}</div>`}</div>
      ${S.showStats ? decisionBox({ status: statusBlob, tenant: D.tenant, cats: USE.usageCats("24h", D.tenant || ""), issues: D.concerns }) : ""}
    </div>`;
  };
  const evtList = () => {
    const focus = S.focus2 === "evt";
    const rows = groups.map((g, i) => {
      const on = i === S.sel.evt, e = g.e, sk = parseSourceKind(e.source);
      return `<div class="tr${on ? " sel" : ""}${on && !focus ? " blur" : ""}" data-act="sel" data-list="evt" data-i="${i}">
        <span class="mark">${on ? "&#9654;" : ""}</span>
        ${cellW(40, sevClass(e.severity) + " b", sevBadge(e.severity))}
        ${cellW(36, "fg-dim", ago(e.timestamp, nowMs()))}
        <span class="c flex">${esc(oneLine(e.message) || e.source)}</span>
        ${cellW(44, "fg-violet", sk.kind || DASH)}
        ${cellW(56, "fg-ok opt", sk.cluster || DASH)}
        ${cellW(64, "fg-label opt", sk.ns || DASH)}
        ${cellW(40, "r fg-strong b", g.count > 1 ? "×" + g.count : "")}
      </div>`;
    }).join("");
    return `<div class="col">
      <div class="tbar${focus ? "" : " off"}">${panelTitle(`events(${groups.length} groups of ${D.events.list.length})`, D.tenant)}<span class="fill"></span><span class="hint">${focus ? "double-tap for detail" : "&lt;tab&gt; to focus"}</span></div>
      <div class="th"><span class="mark"></span>${cellW(40, "", "SEV")}${cellW(36, "", "AGE")}<span class="c flex">MESSAGE</span>${cellW(44, "", "KIND")}${cellW(56, "opt", "CLUSTER")}${cellW(64, "opt", "NS")}${cellW(40, "r", "CNT")}</div>
      <div class="rows" data-scroll="evt" data-fit>${rows || `<div class="empty">no recent events</div>`}</div>
      ${S.showStats ? classifierBox({ status: statusBlob, tenant: D.tenant, events: D.events.list, now: Date.now() }) : ""}
    </div>`;
  };
  // Events left, concerns right — the CLI's order. Detail opens on the
  // OTHER side of the split, so the list you are reading stays where your
  // eye already is.
  let left = evtList(), right = conList();
  if (det && det.kind === "con" && det.row) left = conDetail(det.row);
  if (det && det.kind === "evt" && det.row) right = evtDetail(det.row);
  return `<div class="grid">${left}${right}</div>`;
}
// ── panel 7, ?: issues left, patterns right ─────────────────────────────────
// Events become issues, issues become patterns: the loop view lists the
// issues (left, as panel 3 does) and the patterns in memory (right). The
// selected row marks the rows it is linked to on the other side, and a
// double-tap opens the detail on the other side of the split, as on panel 3.
// Issue ↔ pattern links, both ways: an issue's related patterns (ADR-075)
// and a pattern's own links and backlinks that name an issue.
function loopLinks(cons, pats) {
  const conIds = new Set(cons.map((c) => c.id));
  const i2p = new Map(), p2i = new Map();
  const add = (m, k, x) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(x); };
  cons.forEach((c) => c.patterns.forEach((p) => { if (p.id) { add(i2p, c.id, p.id); add(p2i, p.id, c.id); } }));
  pats.forEach((p) => [...(p.links || []).map((l) => l.toId), ...(p.backlinks || []).map((b) => b.id)].forEach((id) => { if (conIds.has(id)) { add(p2i, p.id, id); add(i2p, id, p.id); } }));
  return { i2p, p2i };
}
function loopPanel() {
  const D = S.D, cons = loopConRows(), pats = patRows();
  const det = S.detail7;
  // Rows arrive on top while a detail is open: follow the opened row by key.
  const keyOf = { con: (c) => c && c.id, pat: (p) => p && p.id };
  if (det && keyOf[det.kind]) {
    const rows = det.kind === "con" ? cons : pats, key = keyOf[det.kind];
    if (det.key === undefined) { det.key = key(rows[det.i]); det.row = rows[det.i]; }
    else {
      const at = rows.findIndex((r) => key(r) === det.key);
      if (at >= 0) { if (S.sel[det.kind] === det.i) S.sel[det.kind] = at; det.i = at; det.row = rows[at]; }
    }
  }
  clamp("con"); clamp("pat");
  const L = loopLinks(cons, pats);
  const selCon = cons[S.sel.con] || null, selPat = pats[S.sel.pat] || null;
  const conLinked = S.focus7 === "pat" && selPat ? L.p2i.get(selPat.id) || new Set() : new Set();
  const patLinked = S.focus7 === "con" && selCon ? L.i2p.get(selCon.id) || new Set() : new Set();
  const openCount = D.concerns.filter((c) => c.status.toLowerCase() !== "resolved").length;
  const byLoop = pats.filter((p) => tagVal(p, AUTHOR_TAG) === "rsi").length;
  const hintFor = (focus, linked, from) => focus ? "double-tap for detail" : linked.size ? `${linked.size} linked to ${esc(from)}` : "&lt;tab&gt; to focus";
  const conList = () => {
    const focus = S.focus7 === "con";
    const rows = cons.map((c, i) => {
      const on = i === S.sel.con, isOpen = c.status.toLowerCase() !== "resolved", sw = statusWord(c.status), np = (L.i2p.get(c.id) || new Set()).size;
      return `<div class="tr${on ? " sel" : ""}${on && !focus ? " blur" : ""}${isOpen ? " open" : ""}" data-act="sel" data-list="con" data-i="${i}">
        <span class="mark${!on && conLinked.has(c.id) ? " fg-ok" : ""}">${on ? "&#9654;" : conLinked.has(c.id) ? "&#9670;" : ""}</span>
        ${cellW(124, "fg-violet", c.id)}
        ${cellW(40, sevClass(c.severity) + " b", sevBadge(c.severity))}
        ${cellW(36, "fg-dim", c.age)}
        <span class="c flex${isOpen ? " fg-strong" : ""}">${esc(c.summary)}</span>
        ${cellW(36, "r " + (c.reopenCount > 0 ? "fg-warn" : "fg-faint"), c.reopenCount > 0 ? "×" + c.reopenCount : "")}
        ${cellW(36, "r " + (np ? "fg-strong b" : "fg-faint"), np ? String(np) : "")}
        ${cellW(76, sw.c + " opt", sw.t)}
      </div>`;
    }).join("");
    return `<div class="col">
      <div class="tbar${focus ? "" : " off"}">${panelTitle(`issues(${cons.length})`, D.tenant, ` &#183; ${openCount} open`)}<span class="fill"></span><span class="hint">${hintFor(focus, conLinked, selPat ? selPat.id : "")}</span></div>
      <div class="th"><span class="mark"></span>${cellW(124, "", "ID")}${cellW(40, "", "SEV")}${cellW(36, "", "AGE")}<span class="c flex">SUMMARY</span>${cellW(36, "r", "RE")}${cellW(36, "r", "PAT")}${cellW(76, "opt", "STATUS")}</div>
      <div class="rows" data-scroll="con" data-fit>${rows || `<div class="empty">${S.raw && S.raw.issues ? "no issues in history" : "issues unavailable"}</div>`}</div>
    </div>`;
  };
  const patList = () => {
    const focus = S.focus7 === "pat";
    const rows = pats.map((p, i) => {
      const on = i === S.sel.pat, conf = p.confidence || "", author = tagVal(p, AUTHOR_TAG), ni = (L.p2i.get(p.id) || new Set()).size;
      const cc = conf === "high" ? "fg-ok" : conf === "medium" ? "fg-warn" : conf ? "fg-crit" : "fg-faint2";
      return `<div class="tr${on ? " sel" : ""}${on && !focus ? " blur" : ""}" data-act="sel" data-list="pat" data-i="${i}">
        <span class="mark${!on && patLinked.has(p.id) ? " fg-ok" : ""}">${on ? "&#9654;" : patLinked.has(p.id) ? "&#9670;" : ""}</span>
        ${cellW(56, author === "rsi" ? "fg-ok" : author ? "fg-violet" : "fg-faint", author || DASH)}
        ${cellW(36, "fg-dim", ago(p.updatedAt, nowMs()))}
        <span class="c flex">${p.shared ? `<span class="fg-faint">&#183; </span>` : ""}${esc(p.title || "(untitled)")}</span>
        ${cellW(96, "fg-label opt", tagVal(p, SERVICE_TAG) || DASH)}
        ${cellW(48, "r " + cc, conf || DASH)}
        ${cellW(36, "r " + (ni ? "fg-strong b" : "fg-faint"), ni ? String(ni) : "")}
      </div>`;
    }).join("");
    return `<div class="col">
      <div class="tbar${focus ? "" : " off"}">${panelTitle(`patterns(${pats.length})`, D.tenant, ` &#183; by the loop ${byLoop}`)}<span class="fill"></span><span class="hint">${hintFor(focus, patLinked, selCon ? selCon.id : "")}</span></div>
      <div class="th"><span class="mark"></span>${cellW(56, "", "AUTHOR")}${cellW(36, "", "AGE")}<span class="c flex">PATTERN</span>${cellW(96, "opt", "SERVICE")}${cellW(48, "r", "CONF")}${cellW(36, "r", "ISS")}</div>
      <div class="rows" data-scroll="pat" data-fit>${rows || `<div class="empty">${S.filterText ? "no patterns match " + esc(S.filterText) : D.mem.loaded ? "no patterns in memory" : "memory unavailable"}</div>`}</div>
    </div>`;
  };
  // Issues left, patterns right; the detail opens on the other side.
  let left = conList(), right = patList();
  if (det && det.kind === "con" && det.row) right = conDetail(det.row);
  if (det && det.kind === "pat" && det.row) left = patDetail(det.row, cons, L);
  return `<div class="grid">${left}${right}</div>`;
}
function patDetail(p, cons, L) {
  const { body } = memImage(p);
  const author = tagVal(p, AUTHOR_TAG), svc = tagVal(p, SERVICE_TAG), conf = p.confidence || "";
  const linked = [...(L.p2i.get(p.id) || [])];
  const other = (p.links || []).filter((l) => l.toId && !linked.includes(l.toId));
  return `<div class="col g6">
    <div class="tbar"><span class="t">pattern &#183; ${esc(p.id)}</span><span class="fill"></span><button type="button" class="close" data-act="key" data-k="Escape">[esc] close</button></div>
    <p class="para fg-strong">${esc(p.title || "(untitled)")}</p>
    <div class="kvs">
      ${kv("ID:", p.id, "fg-violet")}
      ${kv("Kind:", String(p.kind || "").replace(/_/g, " "), "")}
      ${author ? kv("Author:", author, author === "rsi" ? "fg-ok" : "fg-text") : ""}
      ${svc ? kv("Service:", svc, "fg-label") : ""}
      ${kv("Tenant:", p.tenantTag || "instance-wide", p.tenantTag ? "fg-label" : "fg-faint")}
      ${kv("Confidence:", conf, conf === "high" ? "fg-ok" : conf === "medium" ? "fg-warn" : "fg-text")}
      ${kv("Status:", p.status, p.status === "active" ? "fg-ok" : "fg-dim")}
      ${kv("Updated:", fullTime(p.updatedAt), "fg-strong", agoS(p.updatedAt))}
      ${kv("Hits:", p.hitCount != null ? String(p.hitCount) : null, "fg-strong")}
    </div>
    ${sub("Content") + (body ? `<p class="para" style="white-space:pre-wrap">${linkify(body)}</p>` : `<span class="note">empty cell</span>`)}
    ${linked.length ? sub("Issues (" + linked.length + ")") + linked.map((id) => {
      const i = cons.findIndex((c) => c.id === id), c = cons[i];
      return `<div class="two"${i >= 0 ? ` data-act="loopjump" data-list="con" data-i="${i}" style="cursor:pointer"` : ""}><span class="${i >= 0 ? "fg-violet" : "fg-faint"}">${esc(id)}</span>${c ? `<span class="fg-dim">${esc(c.summary)}</span>` : ""}</div>`;
    }).join("") : ""}
    ${other.length ? sub("Links") + other.map((l) => `<div class="two"><span class="fg-dim">${esc(l.relation || "link")}</span> <span class="fg-faint">${esc(l.toId)}</span></div>`).join("") : ""}
  </div>`;
}
function conDetail(c) {
  const sw = statusWord(c.status);
  let html = `<div class="col g6">
    <div class="tbar"><span class="t">issue detail &#183; ${esc(c.id)}</span><span class="fill"></span><button type="button" class="close" data-act="key" data-k="Escape">[esc] close</button></div>
    <p class="para fg-strong">${esc(c.headline || c.summary)}</p>
    <div class="kvs">
      ${kv("ID:", c.id, "fg-violet")}
      ${kv("Severity:", sevBadge(c.severity), sevClass(c.severity))}
      ${kv("Status:", sw.t, sw.c)}
      ${kv("Source:", c.source, "fg-text")}
      ${kv("Cluster:", c.cluster, "fg-ok")}
      ${kv("Namespace:", c.ns, "fg-label")}
      ${kv("First seen:", fullTime(c.firstSeen), "fg-strong", agoS(c.firstSeen))}
      ${kv("Last seen:", fullTime(c.lastSeen), "fg-strong", agoS(c.lastSeen))}
      ${c.reopenCount > 0 ? kv("Reopens:", String(c.reopenCount), "fg-warn") : ""}
      ${c.resolvedBy ? kv("Resolved by:", c.resolvedBy, "fg-ok", c.resolvedAt ? fullTime(c.resolvedAt) : "") : ""}
      ${c.verdict ? kv("Verdict:", c.verdict, c.verdict === "fixed" ? "fg-ok" : "fg-warn", c.verdictUntil ? "holds until " + fullTime(c.verdictUntil) : "") : ""}
    </div>`;
  html += sub("Summary") + `<p class="para">${esc(c.summaryFull || "(no summary)")}</p>`;
  if (c.hypothesis) html += sub("Hypothesis") + `<p class="para">${esc(c.hypothesis)}</p>`;
  if (c.rootCause || c.fix) html += sub("Resolution") + `<div class="kvs">${c.rootCause ? kv("Root cause:", c.rootCause, "fg-text") : ""}${c.fix ? kv("Fix:", c.fix, "fg-text") : ""}</div>`;
  // Comments: what people, chat and voice wrote on the issue (an RCA saved
  // with comment_on_issue lands here), oldest first, above the
  // related events, which can run long.
  if (c.comments.length) {
    html += sub("Comments (" + c.comments.length + ")");
    html += c.comments.map((m) => `<div class="kv"><span class="fg-violet" style="flex-shrink:0">${esc(m.author || "—")}</span><span class="fg-dim" style="flex-shrink:0">&nbsp;${esc(ago(m.timestamp, nowMs()))}</span></div><p class="para">${esc(m.text || "")}</p>`).join("");
  }
  if (c.actions.length) html += sub("Actions") + c.actions.map((a) => `<div class="para">&#8226; ${esc(a)}</div>`).join("");
  // Known patterns (ADR-075): the memory cells that bear on the issue. One
  // a person or the reflection pass said explains it comes first.
  if (c.patterns.length) {
    const ps = [...c.patterns].sort((a, b) => (a.relation === "explains" ? 0 : 1) - (b.relation === "explains" ? 0 : 1));
    html += sub("Known patterns (" + ps.length + ")");
    html += ps.map((p) => `<div class="kv"><span class="${p.relation === "explains" ? "fg-ok" : "fg-dim"} b" style="width:4.6em;flex-shrink:0">${esc(p.relation || "")}</span><span class="fg-violet" style="flex-shrink:0">${esc(p.kind === "operational_pattern" ? "pattern" : p.kind === "stable_fact" ? "fact" : p.kind === "watch_item" ? "watch" : p.kind || "")}&nbsp;</span><span class="v fg-text">${esc(oneLine(p.title || p.id || ""))}${p.relation === "explains" && p.linkedBy ? ` <span class="fg-faint">per ${esc(p.linkedBy)}</span>` : ""}</span></div>`).join("");
  }
  // Related events can run to dozens: the RELATED_MAX most severe, newest first.
  if (c.related.length) {
    const top = [...c.related].sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3) || new Date(b.lastSeenAt || b.timestamp) - new Date(a.lastSeenAt || a.timestamp)).slice(0, RELATED_MAX);
    const total = c.relatedTotal || c.related.length;
    html += sub("Related events (" + (top.length < total ? top.length + " of " : "") + total + ")");
    html += top.map((e) => `<div class="kv"><span class="${sevClass(e.severity)} b" style="width:3.08em;flex-shrink:0">${esc(sevBadge(e.severity))}</span><span class="fg-dim" style="width:2.77em;flex-shrink:0">${esc(ago(e.lastSeenAt || e.timestamp, nowMs()))}</span><span class="v fg-text">${esc(e.type || "")}${e.count > 1 ? " ×" + esc(e.count) : ""} <span class="fg-faint">${esc(oneLine(e.message))}</span></span></div>`).join("");
  } else if (c.relatedIds.length) {
    html += sub("Related events") + c.relatedIds.slice(0, RELATED_MAX).map((id) => `<div class="fg-faint">&#8226; ${esc(id)}</div>`).join("");
  }
  html += `</div>`;
  return html;
}
function evtDetail(g) {
  const e = g.e;
  const sample = e.raw && typeof e.raw.sample === "string" ? e.raw.sample : "";
  let msg = e.message || "(no message)";
  if (sample) msg = msg.replace(/;?\s*samples?:\s*[\s\S]*$/, "");
  const gctx = e.raw && typeof e.raw._graph_context === "string" ? e.raw._graph_context : "";
  let html = `<div class="col g6">
    <div class="tbar"><span class="t">event detail &#183; ${esc(e.type || "event")}</span><span class="fill"></span><button type="button" class="close" data-act="key" data-k="Escape">[esc] close</button></div>
    <p class="para fg-strong">${esc(oneLine(e.message ? msg : "") || e.source)}</p>
    <div class="kvs">
      ${kv("ID:", e.id, "fg-violet")}
      ${kv("Type:", e.type, "fg-strong")}
      ${kv("Severity:", sevBadge(e.severity), sevClass(e.severity))}
      ${kv("Source:", e.source, "fg-text")}
      ${e.service ? kv("Service:", e.service, "fg-strong") : ""}
      ${e.classification ? kv("Class:", e.classification === "issue" ? "issue" : e.classification, e.classification === "signal" ? "fg-warn" : e.classification === "issue" ? "fg-crit" : "fg-dim") : ""}
      ${e.state_signal ? kv("State signal:", e.state_signal, "fg-text") : ""}
      ${e.relation ? kv("Relation:", e.relation, "fg-text", typeof e.mark_confidence === "number" ? "confidence " + e.mark_confidence : "") : ""}
      ${kv("Timestamp:", fullTime(e.timestamp), "fg-strong", agoS(e.timestamp))}
      ${kv("Grouped:", "×" + g.count, "fg-strong", g.count > 1 ? "same source kind + type in the recent window" : "")}
    </div>`;
  if (sample) html += sub("Error sample") + `<p class="para">${esc(sample)}</p>`;
  // The headline already carries the message; the section stays for one with line breaks (the headline runs them together) or none.
  if (!e.message || /\n/.test(msg.trim())) html += sub("Message") + `<p class="para">${esc(msg)}</p>`;
  if (gctx) html += sub("Graph context") + `<p class="para fg-dim">${esc(gctx.trim())}</p>`;
  return html + `</div>`;
}

// <4> activity / prediction
// Heat colour of one week's issue count: the scale floors at 20 so a quiet
// fleet stays green instead of painting its busiest week red.
function heatCls(x, max) {
  const f = x / Math.max(max, 20);
  return f >= 0.75 ? "h4" : f >= 0.5 ? "h3" : f >= 0.25 ? "h2" : "h1";
}
function predPanel() {
  const D = S.D, A = D.activity, rows = actRows(), preds = predRows();
  clamp("pred");
  const max = Math.max(1, ...rows.map((r) => Math.max(...r.v)));
  const cols = `grid-template-columns:minmax(6em,13em) repeat(${A.weeks.length},minmax(1.6em,1fr)) 3em`;
  const heat = `<div class="heat" style="${cols}">
      <span></span>${A.weeks.map((w) => `<span class="hw">${esc(w)}</span>`).join("")}<span class="hw">Σ</span>
      ${rows.map((r) => `<span class="hn" title="${esc(r.n + (r.cluster ? " · " + r.cluster : ""))}">${esc(r.n)}</span>` +
        r.v.map((x, i) => x === 0 ? "<span></span>" : `<span class="hc ${heatCls(x, max)}" title="${esc(r.n + " · " + A.weeks[i] + " · " + x)}">${x}</span>`).join("") +
        `<span class="hs">${r.v.reduce((a, b) => a + b, 0)}</span>`).join("")}
    </div>`;
  const bubs = preds.map((p, i) => {
    const pc = p.p == null ? 0 : p.p, r = 22 + pc * 0.2, d = r * 2 + 4, tone = bubbleTone(pc), on = S.predOpen && i === S.sel.pred;
    return `<span class="pbub${on ? " on" : ""}" data-act="pbub" data-i="${i}"><svg width="${d}" height="${d}" viewBox="0 0 ${d} ${d}"><title>${esc(p.svc)}${p.cluster ? " · " + esc(p.cluster) : ""}</title>
      <circle cx="${d / 2}" cy="${d / 2}" r="${r}" fill="${tone[0]}" stroke="${on ? "#ffffff" : tone[1]}" stroke-width="${on ? 2.5 : 1.5}"/>
      <text x="${d / 2}" y="${d / 2 - 1}" text-anchor="middle" class="gbub" fill="#ffffff">${p.p == null ? DASH : p.p + "%"}</text>
      <text x="${d / 2}" y="${d / 2 + 12}" text-anchor="middle" class="glabel" style="fill:#ffffff;font-size:9px">${esc(p.svc.length > 9 ? p.svc.slice(0, 8) + "…" : p.svc)}</text></svg></span>`;
  }).join("");
  const top = S.predOpen ? preds[S.sel.pred] : null;
  // Prognosis: the knowledge pass's per-service verdicts — active mindmap
  // cells tagged to a tenant (an untagged cell is nobody's verdict), newest
  // first; the web UI's Prognosis card and the CLI's "Mindmap: prognosis".
  const prog = D.mem.items.filter((it) => it.kind === "mindmap" && it.tenantTag && matches((it.title || "") + " " + (it.subject || "")));
  const progCf = (c) => c === "high" ? "fg-ok" : c === "medium" ? "fg-warn" : c ? "fg-crit" : "fg-faint2";
  const progHtml = prog.length ? prog.map((it) => `<div class="prog${it.id === S.progOpen ? " on" : ""}" data-act="prog" data-id="${esc(it.id)}">
      <span class="${progCf(it.confidence)}">&#9679;</span><span class="pt fg-strong">${esc(it.title || it.id)}</span><span class="pc fg-dim">${esc(it.content || "")}</span><span class="s">${D.tenants.length > 1 ? esc(it.tenantTag) + " · " : ""}<span class="${progCf(it.confidence)}">${esc(it.confidence || DASH)}</span> · ${esc(ago(it.updatedAt, nowMs()))}</span>
    </div>`).join("")
    : `<span class="fg-faint">${D.mem.loaded ? "no active prognosis yet" : "memory unavailable"}</span>`;
  const openProg = prog.find((it) => it.id === S.progOpen);
  return `<div class="tbar">${panelTitle("forecast", D.tenant)}</div><div class="grid">
    <div class="col">
      ${openProg || top ? "" : `<span class="fg-dim">activity &#8212; last ${A.weeks.length || 0} week${A.weeks.length === 1 ? "" : "s"} (issues per service)</span>`}
      ${openProg ? progDetail(openProg, progCf) : top ? predDetail(top, rows, max) : `<div class="rows" data-scroll="act">${rows.length ? heat : `<div class="empty">${A.loaded ? "no issue activity in the analytics window" : "analytics unavailable"}</div>`}</div>`}
    </div>
    <div class="col g6">
      <section class="gbox"><div class="ghead"><span class="gt">what is about to break</span><span class="fill"></span><span class="gr fg-dim">${preds.length ? preds.length + " ranked" : "no matches"}${D.analyticsAt && agoS(D.analyticsAt) ? " · " + esc(agoS(D.analyticsAt)) : ""}</span></div>
        ${preds.length ? `<div class="gbubs" data-scroll="pred">${bubs}</div>` : `<p class="para fg-dim">no precursor matches</p>`}
      </section>
      <section class="gbox"><div class="ghead"><span class="gt">prognosis</span><span class="fill"></span><span class="gr fg-dim">${prog.length}</span></div>${progHtml}</section>
    </div>
  </div>`;
}

// The clicked bubble in full, in place of the heatmap: the match, the
// pattern it matched and the service's own weeks. Esc or a second click
// brings the heatmap back.
function predDetail(p, rows, max) {
  const A = S.D.activity;
  const pat = S.D.patterns.find((x) => p.patternId && (x.id || x.patternId) === p.patternId) ||
    S.D.patterns.find((x) => x.service === p.svc && (!p.cluster || !x.cluster || x.cluster === p.cluster));
  const row = rows.find((r) => r.n === p.svc && (!p.cluster || !r.cluster || r.cluster === p.cluster));
  const cf = p.p == null ? "fg-dim" : p.p >= 50 ? "fg-crit" : p.p >= 15 ? "fg-warn" : "fg-dim";
  return `<div class="tbar"><span class="t">about to break &#183; ${esc(p.svc)}</span><span class="fill"></span><button type="button" class="close" data-act="key" data-k="Escape">[esc] close</button></div>
    <div class="kvs">
      ${kv("confidence", p.p == null ? DASH : p.p + "%", cf)}
      ${kv("service", p.svc)}
      ${p.cluster ? kv("cluster", p.cluster) : ""}
      ${p.tenant ? kv("tenant", p.tenant) : ""}
      ${kv("steps", p.steps === DASH ? DASH : p.steps + " precursor steps matched")}
      ${kv("live signals", p.signals.length ? p.signals.join(", ") : DASH)}
      ${kv("rate / week", p.rate === DASH ? DASH : p.rate + " issues")}
      ${p.occurrences != null ? kv("seen", p.occurrences + " times") : ""}
      ${kv("open issue", p.activeIssue ? "yes" : "no", p.activeIssue ? "fg-warn" : "fg-dim")}
    </div>
    ${pat ? sub("pattern") + `<p class="para">${esc((pat.sequence || []).join(" → ") || DASH)}</p>` +
      `<div class="kvs">${pat.issueCount != null ? kv("issues", String(pat.issueCount)) : ""}${typeof pat.avgMttr === "number" ? kv("avg mttr", API.formatDuration(pat.avgMttr)) : ""}${p.patternId ? kv("id", p.patternId, "fg-dim") : ""}</div>` : ""}
    ${row ? sub("weekly issues") + `<div class="heat" style="grid-template-columns:repeat(${A.weeks.length},minmax(1.6em,1fr)) 3em">
      ${A.weeks.map((w) => `<span class="hw">${esc(w)}</span>`).join("")}<span class="hw">Σ</span>
      ${row.v.map((x) => x === 0 ? "<span></span>" : `<span class="hc ${heatCls(x, max)}">${x}</span>`).join("")}<span class="hs">${row.v.reduce((a, b) => a + b, 0)}</span>
    </div>` : ""}`;
}

// The clicked prognosis verdict in full, in place of the heatmap; Esc or a
// second click brings the heatmap back.
function progDetail(it, progCf) {
  if (!it) return "";
  return `<div class="tbar"><span class="t">prognosis &#183; ${esc(it.title || it.id)}</span><span class="fill"></span><button type="button" class="close" data-act="key" data-k="Escape">[esc] close</button></div>
    <div class="kvs">
      ${it.subject ? kv("service", it.subject) : ""}
      ${kv("tenant", it.tenantTag)}
      ${kv("confidence", it.confidence || DASH, progCf(it.confidence))}
      ${kv("updated", fullTime(it.updatedAt), "", ago(it.updatedAt, nowMs()))}
      ${kv("id", it.id, "fg-dim")}
    </div>
    ${it.content ? `<p class="para">${esc(it.content)}</p>` : ""}`;
}

// <5> memory — the Voronoi map is the main view; ? swaps to the list + detail.
function memPanel() {
  LIVE.searchFor(S.filterText);
  const D = S.D, M = D.mem, rows = memRows();
  clamp("mem");
  if (S.memView === "map") return memMapPanel(rows);
  const shared = M.items.filter((i) => i.shared).length;
  const kinds = Object.entries(M.byKind).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const legend = kinds.slice(0, 8).map(([k, n]) => `<span class="lg" style="color:${kindColor(k)}"><span class="dot"></span>${esc(k.replace(/_/g, " "))} ${esc(n)}</span>`).join("") + (kinds.length > 8 ? `<span class="fg-faint">+${kinds.length - 8} kinds</span>` : "");
  const list = rows.map((it, i) => {
    const on = i === S.sel.mem;
    const conf = it.confidence || "";
    const cc = conf === "high" ? "fg-ok" : conf === "medium" ? "fg-warn" : conf ? "fg-crit" : "fg-faint2";
    return `<div class="tr${on ? " sel" : ""}" data-act="sel" data-list="mem" data-i="${i}">
      <span class="mark">${on ? "&#9654;" : ""}</span>
      <span class="c" style="width:10.15em;color:${kindColor(it.kind)}">${esc(String(it.kind || "").replace(/_/g, " "))}</span>
      <span class="c flex">${it.shared ? `<span class="fg-faint">&#183; </span>` : ""}${esc(it.title || "(untitled)")}</span>
      ${cellW(48, "r " + cc, conf || DASH)}
      ${cellW(40, "r fg-dim", ago(it.updatedAt, nowMs()))}
    </div>`;
  }).join("");
  const sel = S.sel.mem >= 0 ? rows[S.sel.mem] : null;
  return `<div class="grid fill">
    <div class="col">
      <div class="tbar">${panelTitle(`memory(${esc(M.total)})`, D.tenant)}<span class="fill"></span><span class="hint">/ search · id: kind: title: content: subject: tag:</span></div>
      <div class="two" style="padding:2px 8px"><span class="fg-strong">${esc(D.tenant || "all")} ${M.items.length - shared}</span>${shared ? `<span class="fg-faint">+${shared} shared (&#183; instance-wide)</span>` : ""}</div>
      <div class="legendrow">${legend}</div>
      <div class="th"><span class="mark"></span><span class="c" style="width:10.15em">KIND</span><span class="c flex">TITLE</span>${cellW(48, "r", "CONF")}${cellW(40, "r", "AGE")}</div>
      <div class="rows-fill"><div class="rows tall" data-scroll="mem">${list || `<div class="empty">${S.filterText ? "no cells match " + esc(S.filterText) : M.loaded ? "no memory items — memory builds after the reflection loop runs" : "memory unavailable"}</div>`}</div></div>
    </div>
    <div class="col g6">${sel ? memDetail(sel) : memAnalytics()}</div>
  </div>`;
}
// The map fills the panel's width and the terminal height left below the
// panel's top, less the caption line (kept free so selecting a cell does not
// redraw the map at another size).
function memMapSize() {
  const p = $("panel"), t = $("term");
  const h = t.getBoundingClientRect().bottom - p.getBoundingClientRect().top - 66;   // the caption line and the title bar
  return [p.clientWidth, h];
}
function memMapPanel(rows) {
  const M = S.D.mem, sel = S.sel.mem >= 0 ? rows[S.sel.mem] : null;
  const hud = LIVE.hudRows().map(([k, v2]) => `<div><span class="k">${esc(k)}</span> ${esc(v2)}</div>`).join("");
  return `<div class="col g6 memmap-wrap">
    <div class="tbar">${panelTitle(`memory(${esc(M.total)})`, S.D.tenant)}</div>
    <div class="mm-stage">
    ${rows.length
      ? memMapSvg(rows, S.sel.mem, M.byKind, !!S.filterText.trim(), ...memMapSize())
      : `<div class="empty">${S.filterText ? "no cells match " + esc(S.filterText) : M.loaded ? "no memory items — memory builds after the reflection loop runs" : "memory unavailable"}</div>`}
    ${hud ? `<div class="mm-hud">${hud}</div>` : ""}
    </div>
    <div class="two mm-cap" id="mmcap">${memCap(sel, true)}</div>
  </div>`;
}
// Panel 5's one caption line: the hovered cell, else the selected one (only
// that one offers [enter] detail), else nothing.
function memCap(it, selected) {
  if (!it) return "";
  const tags = (it.tags || []).filter((x) => !String(x).startsWith("tenant/") && !["high", "medium", "low"].includes(x)).slice(0, 3);
  return `<span style="color:${kindColor(it.kind)}">${esc(kindLabel(it.kind))}</span>
    <span class="fg-strong mm-title">${esc(it.title || "(untitled)")}</span>
    <span class="fg-dim">${esc(it.confidence || DASH)} &#183; ${esc(ago(it.updatedAt, nowMs()))}</span>
    ${tags.map((x) => `<span class="fg-faint">${esc(x)}</span>`).join("")}
    ${selected ? `<span class="fill"></span><button type="button" class="close" data-act="key" data-k="Enter">[enter] detail</button>` : ""}`;
}
// X-Ray stores a thumbnail as a leading data: image in the content.
function memImage(it) {
  if (it.imageUrl && /^data:image\//.test(it.imageUrl)) return { img: it.imageUrl, body: it.content || "" };
  const m = String(it.content || "").match(/^!\[thumbnail\]\((data:image\/[^)]+)\)\n\n/);
  return m ? { img: m[1], body: it.content.slice(m[0].length) } : { img: "", body: it.content || "" };
}
// Content as text with its URLs made into links (X-Ray's autolink).
function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<>"')\]]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer" class="fg-violet">${u}</a>`);
}
function memDetail(it) {
  const { img, body } = memImage(it);
  return `<div class="tbar"><span class="t">cell &#183; ${esc(it.id)}</span><span class="fill"></span><button type="button" class="close" data-act="memkind" data-kind="${esc(it.kind)}">all ${esc(kindLabel(it.kind))}</button><button type="button" class="close" data-act="key" data-k="Escape">[esc] ${S.memBack ? "map" : "analytics"}</button></div>
    ${img ? `<img class="mm-thumb" src="${esc(img)}" alt="">` : ""}
    <p class="para fg-strong">${esc(it.title || "(untitled)")}</p>
    <div class="kvs">
      ${kv("ID:", it.id, "fg-violet")}
      ${kv("Kind:", String(it.kind || "").replace(/_/g, " "), "")}
      ${kv("Scope:", it.scope, "fg-text")}
      ${kv("Status:", it.status, it.status === "active" ? "fg-ok" : "fg-dim")}
      ${kv("Tenant:", it.tenantTag || "instance-wide", it.tenantTag ? "fg-label" : "fg-faint")}
      ${it.subject ? kv("Subject:", it.subject, "fg-text") : ""}
      ${kv("Confidence:", it.confidence, "fg-text")}
      ${it.eventDate ? kv("Event date:", fullTime(it.eventDate), "fg-strong", agoS(it.eventDate)) : ""}
      ${kv("Updated:", fullTime(it.updatedAt), "fg-strong", agoS(it.updatedAt))}
      ${kv("Hits:", it.hitCount != null ? String(it.hitCount) : null, "fg-strong")}
    </div>
    ${it.tags && it.tags.length ? sub("Tags") + `<div class="two">${it.tags.map((t) => `<span class="fg-label">${esc(t)}</span>`).join("")}</div>` : ""}
    ${sub("Content") + (body ? `<p class="para" style="white-space:pre-wrap">${linkify(body)}</p>` : `<span class="note">empty cell</span>`)}
    ${memLinks("Links", (it.links || []).map((l) => ({ id: l.toId, relation: l.relation })))}
    ${memLinks("Referenced by", it.backlinks || [])}`;
}
// g: jump to the selected cell's first outgoing link that is in the list.
function memNextLink() {
  const rows = memRows(), it = rows[S.sel.mem];
  if (!it) { flash("select a cell first"); return; }
  const i = (it.links || []).map((l) => rows.findIndex((r) => r.id === l.toId)).find((x) => x >= 0);
  if (i == null) { flash("no outgoing link in this view"); return; }
  S.sel.mem = i; S.scrollSel = true; render();
}
// Outgoing links and backlinks (memory.go memoryBacklinks); a cell present
// in the current list is tappable and selects it.
function memLinks(title, links) {
  if (!links.length) return "";
  const rows = memRows();
  return sub(title) + links.map((l) => {
    const i = rows.findIndex((r) => r.id === l.id);
    const label = `<span class="fg-dim">${esc(l.relation || "link")}</span> <span class="${i >= 0 ? "fg-violet" : "fg-faint"}">${esc(l.title || l.id)}</span>`;
    return i >= 0
      ? `<div class="two" data-act="memjump" data-i="${i}" style="cursor:pointer">${label}</div>`
      : `<div class="two">${label}</div>`;
  }).join("");
}
function memAnalytics() {
  const D = S.D, m = D.mem.metrics;
  if (!m) return `<span class="fg-faint">memory analytics unavailable — GET /v2/memory/metrics failed or not yet loaded</span>`;
  const byKind = Object.entries(m.byKind).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const tot = byKind.reduce((a, [, n]) => a + n, 0) || 0;
  const maps = Object.entries(m.mentalMaps).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + " " + n).join(", ") || "none loaded";
  const s = m.search;
  const row3 = (label, n, pct, color) => `<div class="tr" style="cursor:default;padding:1px 8px"><span class="c flex" style="color:${color || "var(--text)"}">${esc(label)}</span>${cellW(56, "r fg-strong", String(n))}${cellW(52, "r fg-dim", pct)}</div>`;
  return `<span class="fg-violet">analytics</span>
    <div class="two"><span><span class="k">Composition</span> <span class="fg-strong">${esc(D.tenant || "all tenants")}</span></span></div>
    <div class="two"><span><span class="k">Store</span> <span class="fg-strong">${esc(v(m.items))}</span> cells</span><span><span class="k">Working set</span> <span class="fg-strong">${esc(v(m.workingSet))}</span> <span class="fg-faint">/ ${esc(v(m.items))}</span></span></div>
    <div class="two"><span><span class="k">HNSW</span> <span class="fg-faint">cells</span> <span class="fg-strong">${esc(v(m.hnswCells))}</span></span><span><span class="fg-faint">issues</span> <span class="fg-strong">${esc(v(m.hnswConcerns))}</span></span></div>
    <div class="two"><span><span class="k">Mental maps</span> <span class="fg-dim">${esc(maps)}</span></span></div>
    ${sub("By kind")}
    ${byKind.length ? byKind.map(([k, n]) => row3(k.replace(/_/g, " "), n, tot ? Math.round((n / tot) * 100) + "%" : DASH, kindColor(k))).join("") : `<span class="note">no cells</span>`}
    ${sub("By status")}
    ${Object.entries(m.byStatus).map(([k, n]) => row3(k, n, "", k === "active" ? "var(--ok)" : "var(--dim)")).join("") || `<span class="note">${DASH}</span>`}
    ${Object.keys(m.byTenant).length ? sub("By tenant") + Object.entries(m.byTenant).sort((a, b) => b[1] - a[1]).map(([k, n]) => row3(k, n, "")).join("") : ""}
    ${s ? sub("Retrieval (instance-wide)") + `<div class="kvs">
      ${kv("Searches:", String(s.total != null ? s.total : DASH), "fg-strong", "keyword hits " + (s.keywordHits != null ? s.keywordHits : DASH))}
      ${kv("Semantic:", String(s.semanticCalls != null ? s.semanticCalls : DASH), "fg-strong", "fallbacks " + (s.semanticFallbacks != null ? s.semanticFallbacks : DASH))}
      ${s.kwTrigramHits != null ? kv("Trigram hits:", String(s.kwTrigramHits), "fg-strong") : ""}
    </div>` : ""}`;
}

// <T> tenant picker — a modal over whichever panel is showing, laid out like
// the CLI's (tenant.go renderTenantPicker): the tenant table in a box, and
// beside it the HIGHLIGHTED tenant's detail, so tenants compare before a
// switch. The pane is dropped on a narrow screen, as the CLI drops it.
const tpCovC = (p) => p >= 90 ? "fg-ok" : p >= 50 ? "fg-warn" : "fg-crit";
const tpNarrow = () => window.matchMedia("(max-width: 899px)").matches;
function renderModal() {
  const el = $("modal");
  if (!S.tntOpen || !S.D) { if (!el.hidden) { el.hidden = true; el.innerHTML = ""; } return; }
  const saved = {};
  el.querySelectorAll("[data-scroll]").forEach((n) => { saved[n.dataset.scroll] = n.scrollTop; });
  const D = S.D, rows = tntRows();
  clamp("tnt");
  const cells = rows.map((t) => ({
    t,
    evt: formatCount(t.events),
    inc: formatCount(t.opened),
    app: t.apps == null ? DASH : formatCount(t.apps),
    cov: t.coverage == null ? DASH : API.coveragePctLabel(t.coverage),
  }));
  // Natural column widths with the CLI's two-space gap before each number.
  // On a phone the numbers drop and the list is names only — the CLI's
  // fallback when the table does not fit.
  const w = (h, k, gap) => Math.max(h.length, ...cells.map((c) => String(k(c)).length)) + gap + "ch";
  const W = { name: w("TENANT", (c) => c.t.id, 0), evt: w("EVENTS", (c) => c.evt, 2), inc: w("INC", (c) => c.inc, 2), app: w("APP", (c) => c.app, 2), cov: w("COVERAGE", (c) => c.cov, 2) };
  const cell = (wd, cls, text) => `<span class="c ${cls}${/\br\b/.test(cls) ? " opt" : ""}" style="width:${wd}">${esc(text)}</span>`;
  const list = cells.map((c, i) => {
    const on = i === S.sel.tnt, cur = c.t.id === D.tenant;
    return `<div class="tr${on ? " sel" : ""}" data-act="sel" data-list="tnt" data-i="${i}">
      <span class="mark fg-mag">${on ? "&gt;" : ""}</span>
      ${cell(W.name, cur ? "b fg-label" : "", c.t.id)}
      ${cell(W.evt, "r fg-strong", c.evt)}
      ${cell(W.inc, "r fg-strong", c.inc)}
      ${cell(W.app, "r " + (c.t.apps == null ? "fg-faint2" : "fg-strong"), c.app)}
      ${cell(W.cov, "r " + (c.t.coverage == null ? "fg-faint2" : tpCovC(c.t.coverage)), c.cov)}
    </div>`;
  }).join("");
  const sel = rows[S.sel.tnt];
  el.innerHTML = `<div class="modal-back" data-act="tnt-close"></div>
    <div class="tp" role="dialog" aria-modal="true" aria-label="tenant picker">
      <div class="modal tp-box">
        <div class="tbar"><span class="t">tenants(${D.tenants.length})${D.tenant ? " &#183; scoped to " + esc(D.tenant) : ""}</span></div>
        <div class="th"><span class="mark"></span>${cell(W.name, "", "TENANT")}${cell(W.evt, "r", "EVENTS")}${cell(W.inc, "r", "INC")}${cell(W.app, "r", "APP")}${cell(W.cov, "r", "COVERAGE")}</div>
        <div class="rows" data-scroll="tnt">${list || `<div class="empty">no tenants</div>`}</div>
      </div>
      ${sel ? tenantPane(sel.id) : ""}
    </div>`;
  el.hidden = false;
  el.querySelectorAll("[data-scroll]").forEach((n) => { if (saved[n.dataset.scroll] != null) n.scrollTop = saved[n.dataset.scroll]; });
  if (S.scrollSel) { S.scrollSel = false; revealSel(el); }
}

// tenantPickerScorecard: the detail block and the value scorecard; key hints
// last. The mindmap cells stay on the '?' panel — here they made the pane run
// far past the table.
function tenantPane(id) {
  const D = S.D, st = (S.raw && S.raw.status) || {};
  const scoped = id === D.tenant;
  let html = sub("Tenant: " + id);
  if (!st.tenantStats) html += `<span class="note">no tenant statistics yet</span>`;
  else {
    const T = API.tenantDetail(st, id);
    html += `<div class="kvs">${T.rows.map((r) => kv(r.k, r.v, r.tone, r.note, "w126")).join("")}</div>`;
    html += `<div class="tp-score">${scorecardRows(T.entry || {}, scoped && D.apps && D.apps.counts ? D.apps.counts.drift : 0)}</div>`;
  }
  html += `<span class="fg-faint tp-hint">&#8593;&#8595; move &#183; ${scoped ? "current scope" : "enter scope"} &#183; esc close</span>`;
  return `<div class="tp-pane"><div class="tp-in">${html}</div></div>`;
}

function openTenants() {
  if (!S.D) return;
  S.tntOpen = true;
  S.sel.tnt = Math.max(0, S.D.tenants.findIndex((t) => t.id === S.D.tenant));
  S.scrollSel = true;
  render();
}
function closeTenants() { S.tntOpen = false; render(); }

// The picker's keys: ↑↓ move, enter scopes, esc / T closes. Any other key
// closes the picker and goes on to its normal binding.
function tenantsHandleKey(k) {
  switch (k) {
    case "j": case "ArrowDown": move(1); return true;
    case "k": case "ArrowUp": move(-1); return true;
    case "PageDown": move(10); return true;
    case "PageUp": move(-10); return true;
    case "Enter": openRow("tnt", S.sel.tnt); return true;
    case "Escape": case "T": case "N": closeTenants(); return true;
    default: S.tntOpen = false; render(); return false;
  }
}

// <?> config
function cfgPanel() {
  const D = S.D, C = D.config || {}, St = D.stats || {}, T = D.tenantCard;
  const cv = connView();
  const rv = (k, val, cls = "fg-strong", s = "") => kv(k, val, cls, s, "w118");
  const rv2 = (k, val, cls = "fg-strong", s = "") => kv(k, val, cls, s, "w126");
  const en = (x) => (x === "Enabled" || x === "enabled" ? "fg-ok" : x == null ? "fg-faint2" : "fg-dim");
  const sec = (t, rows) => `<div class="col" style="gap:1px">${sub(t).replace('class="sub"', 'class="sub tight"')}${rows}</div>`;
  const ver = S.raw && S.raw.version ? S.raw.version : {};
  const st = tenantSum((S.raw && S.raw.status) || {}, D.tenant);
  const srcLine = `heartbeats ${formatCount(st.ok)} · machine ${formatCount(st.machine)} · connectors ${formatCount(st.connector)} · human ${formatCount(st.human)}`;
  const loops = ((S.raw && S.raw.status) || {}).loops || {};
  const loopEvery = (v) => (v && dur(v) !== "off" ? "every " + dur(v) : "");
  const fails = S.failed.concat(USE.usageFailures());
  const failed = fails.map((f) => kv(f.key + ":", f.path, "fg-crit", (f.status ? "HTTP " + f.status : oneLine(f.error).slice(0, 60)) + (f.stale ? " · showing previous data" : ""), "w118")).join("");
  const left = [
    sec("Connection", [
      rv("Origin:", location.origin),
      rv("Auth:", "SSO session cookie", "fg-strong", "shared with the mobile app on this host"),
      rv("Tenant:", D.tenant, "fg-strong", "(" + D.tenants.length + " total: " + D.tenants.map((t) => t.id).join(", ") + ")"),
      rv("Core version:", D.coreVersion, "fg-violet", [ver.commit && !String(D.coreVersion || "").includes(ver.commit) ? ver.commit : "", ver.buildDate].filter(Boolean).join(" · ")),
      rv("TUI version:", uiVersion || null, "fg-violet"),
      rv("Last refresh:", S.lastRefresh ? new Date(S.lastRefresh).toLocaleTimeString() : null, "fg-strong", S.lastRefresh ? ago(new Date(S.lastRefresh).toISOString(), Date.now()) + " ago" : ""),
      rv("Live feed:", S.wsOpen ? "connected" : "reconnecting", S.wsOpen ? "fg-ok" : "fg-warn", "/v2/agent/ws pushes status + issues; the rest re-reads every " + RESYNC_MS / 60000 + "m"),
      rv("Status:", cv.t, cv.c),
    ].join("")),
    fails.length ? sec("Failed endpoints", failed) : "",
    sec("Access", [
      rv("Username:", D.user),
      rv("Role:", D.role),
      rv("Grants:", D.grants, "fg-text"),
    ].join("")),
    sec("Core Configuration", [
      rv("Model:", C.model),
      rv("Guardrail:", C.guardrail, en(C.guardrail), C.guardrailModel || ""),
      rv("RCA Model:", C.rcaModel || C.model, "fg-strong", C.rcaModel ? "" : "no dedicated override — same as Model"),
      rv("Decision:", C.decisionModel || "off", C.decisionModel ? "fg-strong" : "fg-faint2", C.decisionModel ? "" : "no decision model wired"),
      rv("Embeddings:", C.embeddings),
      rv("Voice:", C.voice, en(C.voice), C.voiceModel || ""),
      rv("Reflection:", C.reflection, en(C.reflection), [C.rcaModel || C.model, loopEvery(loops.reflection)].filter(Boolean).join(" · ")),
      rv("Reasoning:", loops.knowledgeOn == null ? null : loops.knowledgeOn ? "Enabled" : "Disabled", en(loops.knowledgeOn == null ? null : loops.knowledgeOn ? "Enabled" : "Disabled"), [C.model, loopEvery(loops.knowledge)].filter(Boolean).join(" · ")),
      rv("Chat:", C.chatModel, "fg-strong"),
      rv("Retention:", C.retention),
      rv("A2A:", C.a2a, en(C.a2a === "Disabled" ? "Disabled" : C.a2a ? "Enabled" : null)),
      rv("OTel Tracing:", C.otel, "fg-strong", C.otelNote || ""),
      rv("LLM breaker:", C.breaker, en(C.breaker), C.breakerNote || ""),
      rv("Base URL:", C.baseURL),
      D.policy ? rv("Policy:", (D.policy.name || DASH) + (D.policy.version != null ? " v" + D.policy.version : ""), "fg-strong", D.policy.source ? "from " + D.policy.source : "") : "",
    ].join("")),
    sec("Token Limits", [
      rv("LLM Daily:", C.llmDaily, "fg-strong", C.llmDaily ? "machine-side, resets 00:00 UTC" : ""),
      rv("Voice per user:", C.voiceDaily),
      rv("Kind Caps:", C.kindCaps, "fg-strong", C.kindCaps ? "per reasoning call kind, each tenant its own allowance" : ""),
    ].join("")),
    sec("Event Sources", [
      rv("By source:", srcLine, "fg-strong", srcLine ? "lifetime, this tenant" : ""),
      rv("Queue Buffer:", C.queueBuffer),
      rv("Recent Max:", C.recentMax),
    ].join("")),
    sec("A2A / MCP Tools", (C.tools && C.tools.length) ? C.tools.map((t) => `<div class="fg-text">${esc(t)}</div>`).join("") : `<span class="fg-faint">No remote agents or MCP servers configured.</span>`),
    C.notify ? sec("Notify", rv("Config:", C.notify.name) + C.notify.channels.map((c) => rv("", c, "fg-text")).join("")) : "",
  ].join("");
  const right = [
    sec("Statistics", [
      (() => {
        // Panel 9's numbers (the usage ring: every call incl. failed and
        // embeddings), with the lifetime success counter beside them.
        const u = USE.usageTotals("24h");
        const life = St.llmCalls ? "lifetime " + St.llmCalls + " · " + St.llmSplit : "";
        return u ? rv2("LLM Calls:", String(u.calls), "fg-strong", "24h, as panel 9" + (u.errors ? " · " + u.errors + " failed" : "") + (life ? " · " + life : ""))
          : rv2("LLM Calls:", St.llmCalls, "fg-strong", St.llmSplit);
      })(),
      rv2("Voice:", St.voice, "fg-strong", St.voiceSplit),
      rv2("Voice Quota:", St.voiceQuota, "fg-strong", St.voiceQuotaNote),
      rv2("Classifier:", St.classifier, en(St.classifier), St.classifierSplit),
      rv2("Fast-path:", St.fastPath, "fg-strong", St.fastPath ? "events settled without an LLM call" : ""),
      rv2("Ingested:", St.ingested, "fg-strong", St.ingested ? "all events received, deduplicated included" : ""),
      rv2("Processed:", St.processed),
      rv2("Skipped:", St.skipped, "fg-strong", St.skipped ? "deduplicated" : ""),
      rv2("Guardrail:", St.guardrail, en(St.guardrail), St.guardrailSplit),
      rv2("Guard Cache:", St.guardCache),
      rv2("Semantic Cache:", St.semCache),
      rv2("HNSW:", St.hnsw, "fg-strong", St.hnswNote),
      rv2("Embedded:", St.embedded),
      rv2("Cluster Agents:", St.agents, "fg-strong", St.agentsNote),
      rv2("Agent Homes:", St.agentHomes, "fg-text"),
      rv2("Gossip Self:", St.gossipSelf, "fg-text"),
      rv2("Gossip Peers:", St.gossipPeers, "fg-text"),
      rv2("Gossip Stats:", St.gossipStats),
      rv2("Reflex rules:", St.reflex, en(St.reflex), St.reflexNote),
      rv2("RSI:", St.rsi, en(St.rsi), St.rsiNote),
      rv2("Retention:", St.retentionLeader, "fg-strong", St.retentionNote),
    ].join("")),
    sec("Tenant: " + (D.tenant || DASH), T ? [
      rv2("Events:", T.events),
      rv2("Total Events:", T.totalEvents, "fg-strong", T.totalEventsNote),
      rv2("Issues:", T.concerns),
      rv2("LLM Tokens:", T.llmTokens, "fg-strong", T.llmRatio ? "ratio " + T.llmRatio : ""),
      rv2("LLM Today:", T.llmToday, "fg-strong", T.llmToday ? "tenant cap, resets 00:00 UTC" : ""),
      rv2("Coverage:", T.coverage, "fg-ok", T.coverageNote),
      rv2("SNR / MTTD:", (T.snr || DASH) + " / " + (T.mttd || DASH)),
      D.apps.counts.drift > 0 ? rv2("Ungraphed:", String(D.apps.counts.drift), "fg-crit", "running, not in the service graph") : "",
    ].join("") : `<span class="note">no tenant stats</span>`),
    sec("Cluster Agents", D.agents.length ? D.agents.map((a) => a.v ? rv2(a.k, a.v, a.dim ? "fg-faint" : "fg-ok") : `<span class="note">${esc(a.k)}</span>`).join("") : `<span class="note">cluster agents disabled</span>`),
    sec("Mindmap: scorecard", D.scorecard.map((r) => rv2(r.k, r.v, "fg-strong", r.note)).join("") || `<span class="note">${DASH}</span>`),
  ].join("");
  return `<div class="col g6">
    <div class="tbar"><span class="t">config</span><span class="fill"></span><span class="${cv.c}">${esc(cv.t)}</span></div>
    <div class="grid"><div class="col" style="gap:9px">${left}</div><div class="col" style="gap:9px">${right}</div></div>
  </div>`;
}

function render() {
  const gate = !S.D;
  $("app").hidden = gate;
  $("splash").hidden = !gate;
  if (gate) { $("splash").innerHTML = splashPage(); return; }
  renderChrome();
  renderPanel();
  renderModal();
}

// ── actions ─────────────────────────────────────────────────────────────────
function setPanel(p) {
  if (!PANELS.includes(p)) return;
  if (S.panel !== p) {
    if (p === "cfg") S.beforeCfg = S.panel; // "?" / esc return here
    S.panel = p;
    S.detail2 = null;
    S.detail7 = null;
    S.goalEdit = null;
    if (p === "sig" && S.D) APV.loadAgents(); // no refresh key: re-read on every visit
  }
  render();
}

// ── goals editor (<1>, e) ───────────────────────────────────────────────────
// The goals in force for the tenant in view: the viewer's own (this browser),
// else the core's for the tenant, else the built-ins (rings.js resolveGoals).
const goalsInForce = () => readGoals(S.D.user, S.D.tenant, S.raw && S.raw.goals);
// Set goal k as the viewer's own; null gives it back to the tenant's.
function setOwnGoal(k, v) {
  const own = loadOwnGoals(S.D.user, S.D.tenant);
  if (v == null) delete own[k]; else own[k] = v;
  saveOwnGoals(S.D.tenant, own);
  render();
}
const stepOwnGoal = (i, d) => { const k = GOAL_KEYS[i]; setOwnGoal(k, stepGoal(k, goalsInForce().goals[k], d)); };
function goalEditKey(k) {
  const e = S.goalEdit;
  switch (k) {
    case "j": case "ArrowDown": e.i = Math.min(GOAL_KEYS.length - 1, e.i + 1); render(); return true;
    case "k": case "ArrowUp": e.i = Math.max(0, e.i - 1); render(); return true;
    case "h": case "ArrowLeft": case "-": stepOwnGoal(e.i, -1); return true;
    case "l": case "ArrowRight": case "+": case "=": stepOwnGoal(e.i, 1); return true;
    case "r": setOwnGoal(GOAL_KEYS[e.i], null); return true;
    case "R": saveOwnGoals(S.D.tenant, {}); flash("goals follow the tenant's"); render(); return true;
    case "a": {
      const g = adoptableGoals(S.D, S.raw, goalsInForce().goals);
      if (!g) { flash("no infra health reported yet"); return true; }
      saveOwnGoals(S.D.tenant, { ...loadOwnGoals(S.D.user, S.D.tenant), ...g }); flash("goals set from today's numbers"); render(); return true;
    }
    case "Escape": setPanel("goal"); return true;
  }
  return false;
}

function activeList() {
  switch (S.panel) {
    case "app": return "app";
    case "con": return S.focus2;
    case "logic": return S.showLoop ? S.focus7 : null;
    case "mem": return "mem";
    case "pred": return "pred";
    default: return null;
  }
}

function move(delta) {
  if (S.tntOpen) {
    const n = tntRows().length;
    if (!n) return;
    S.sel.tnt = Math.max(0, Math.min(n - 1, S.sel.tnt + delta));
    S.scrollSel = true;
    render();
    return;
  }
  if (S.panel === "cfg" || S.panel === "sig" || S.panel === "goal") { $("term").scrollBy(0, delta * 20); return; }
  if (S.panel === "chat") { CHAT.handleKey(delta > 0 ? "j" : "k"); return; }
  const name = activeList();
  if (!name) return;
  const n = listFor(name).length;
  if (!n) return;
  if ((name === "mem" || name === "app") && S.sel[name] < 0) S.sel[name] = 0;
  else S.sel[name] = Math.max(0, Math.min(n - 1, S.sel[name] + delta));
  if (S.panel === "con" && S.detail2) S.detail2 = { kind: S.focus2, i: S.sel[S.focus2] };
  if (S.panel === "logic" && S.detail7) S.detail7 = { kind: S.focus7, i: S.sel[S.focus7] };
  S.scrollSel = true;
  render();
}

function openRow(name, i) {
  if (S.panel === "logic" && (name === "con" || name === "pat")) {
    S.focus7 = name; S.sel[name] = i;
    S.detail7 = { kind: name, i };
    render();
  } else if (name === "con" || name === "evt") {
    S.focus2 = name; S.sel[name] = i;
    S.detail2 = { kind: name, i };
    render();
  } else if (name === "tnt") {
    const t = tntRows()[i];
    S.sel.tnt = i;
    S.tntOpen = false;
    if (t) scopeTenant(t.id);
    render();
  } else if (name === "mem") {
    S.memBack = S.memView === "map";
    S.sel.mem = i; S.memView = "list"; S.scrollSel = true; render();
  } else if (name === "app") {
    S.sel.app = i; render();
    if (window.matchMedia("(max-width: 899px)").matches) {
      const d = document.querySelector("#panel .grid > .col:nth-child(2)");
      if (d) d.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  } else { S.sel[name] = i; render(); }
}

function escape() {
  if (S.filterEditing) { closePrompt(true); return; }
  if (S.panel === "sig" && APV.approvalsEscape()) return;
  if (S.panel === "con" && S.detail2) { S.detail2 = null; render(); return; }
  if (S.panel === "logic" && S.detail7) { S.detail7 = null; render(); return; }
  if (S.panel === "mem" && S.memView === "list" && S.memBack) { S.memBack = false; S.memView = "map"; render(); return; }
  if (S.panel === "mem" && S.sel.mem >= 0) { S.sel.mem = -1; render(); return; }
  if (S.panel === "app" && S.sel.app >= 0) { S.sel.app = -1; render(); return; }
  if (S.panel === "pred" && S.predOpen) { S.predOpen = false; render(); return; }
  if (S.panel === "pred" && S.progOpen) { S.progOpen = ""; render(); return; }
  if (S.filterText || S.clusterFilter || S.nsFilter || S.sevFilter || S.readyFilter) {
    S.filterText = ""; S.clusterFilter = ""; S.nsFilter = ""; S.sevFilter = ""; S.readyFilter = "";
    $("filter").value = "";
    flash("filters cleared");
    render();
    return;
  }
  if (S.panel === "cfg") { setPanel(S.beforeCfg || "goal"); }
}

// q — sign out (the CLI's quit key). /v2/auth/logout ends every session of the cookie's user on
// the core and 302s to /login; the redirect is not followed (the page stays
// here and shows its own sign-in screen).
async function logout() {
  S.logoutConfirm = false;
  if (window.TriageDemo) { render(); return; }
  S.epoch++;
  try { await fetch("/v2/auth/logout", { method: "POST", credentials: "same-origin", redirect: "manual" }); }
  catch (e) { /* the opaque redirect or a network error — local state is cleared regardless */ }
  const wipe = (st) => { try { Object.keys(st).filter((k) => k.startsWith("triage-tui.")).forEach((k) => st.removeItem(k)); } catch (e) { /* storage blocked */ } };
  wipe(localStorage); wipe(sessionStorage);
  S.D = null; S.raw = null; S.failed = [];
  S.conn = "auth";
  S.lastRefresh = null; S.detail2 = null;
  closeWS();
  LIVE.closeMemWS();
  S.panel = "goal";
  render();
}

function valuesFor(kind) {
  const set = new Set();
  const D = S.D;
  if (!D) return [];
  if (S.panel === "app" || S.panel === "goal") D.apps.rows.forEach((r) => { const x = kind === "c" ? r.cluster : r.ns; if (x) set.add(x); });
  else if (S.panel === "con") {
    const src = S.focus2 === "con" ? D.concerns : D.events.list.map((e) => parseSourceKind(e.source));
    src.forEach((sk) => (kind === "c" ? sk.clusters || [sk.cluster] : sk.namespaces || [sk.ns]).forEach((x) => x && set.add(x)));
  } else if (S.panel === "pred" && kind === "c") {
    D.activity.rows.forEach((r) => r.cluster && set.add(r.cluster));
    D.predictions.forEach((p) => p.cluster && set.add(p.cluster));
  }
  return [...set].sort();
}
function cycleFilter(kind) {
  const ok = kind === "c" ? ["goal", "app", "con", "pred"].includes(S.panel) : ["goal", "app", "con"].includes(S.panel);
  if (!ok) { flash("no " + (kind === "c" ? "cluster" : "namespace") + " filter on this panel"); return; }
  const cycle = [""].concat(valuesFor(kind));
  const key = kind === "c" ? "clusterFilter" : "nsFilter";
  const i = cycle.indexOf(S[key]);
  S[key] = cycle[(i + 1) % cycle.length];
  resetSel();
  if (S.panel === "goal") loadScopedHealth();
  flash((kind === "c" ? "cluster: " : "namespace: ") + (S[key] || "all") + (cycle.length === 1 ? " (none to cycle)" : ""));
  render();
}
// Panel 0 follows the cluster / namespace filters: the issue and app figures
// narrow client-side, the infra rings come from the core scored over the same
// scope. The answer is kept with the scope it was fetched for, so a stale one
// is never drawn against another.
const goalScope = () => ({ cluster: S.clusterFilter, ns: S.nsFilter });
const scopedHealthNow = () => {
  const { cluster, ns } = goalScope();
  return S.scoped && S.D && S.scoped.key === [S.D.tenant, cluster, ns].join("|") ? S.scoped.body : null;
};
async function loadScopedHealth() {
  const { cluster, ns } = goalScope(), tenant = S.D && S.D.tenant;
  if (!tenant || (!cluster && !ns)) { S.scoped = null; render(); return; }
  const key = [tenant, cluster, ns].join("|");
  const body = await API.fetchScopedHealth(tenant, cluster, ns);
  if (key !== [S.D && S.D.tenant, S.clusterFilter, S.nsFilter].join("|")) return;
  S.scoped = { key, body };
  render();
}
function resetSel() {
  if (S.panel === "app") S.sel.app = -1;
  if (S.panel === "con") { S.sel.con = 0; S.sel.evt = 0; S.detail2 = null; }
  if (S.panel === "logic") { S.sel.con = 0; S.sel.pat = 0; S.detail7 = null; }
  if (S.panel === "pred") S.sel.pred = 0;
  if (S.panel === "mem") S.sel.mem = -1;
}
function setReady(state) {
  S.readyFilter = S.readyFilter === state ? "" : state;
  S.sel.app = -1;
  flash("state: " + (S.readyFilter || "all"));
  render();
}
function cycleS() {
  if (S.panel === "app") {
    const i = READY_CYCLE.indexOf(S.readyFilter);
    S.readyFilter = READY_CYCLE[(i + 1) % READY_CYCLE.length];
    S.sel.app = -1;
    flash("state: " + (S.readyFilter || "all"));
  } else if (S.panel === "con") {
    const i = SEV_CYCLE.indexOf(S.sevFilter);
    S.sevFilter = SEV_CYCLE[(i + 1) % SEV_CYCLE.length];
    S.sel.con = 0; S.sel.evt = 0; S.detail2 = null;
    flash("severity: " + (S.sevFilter || "all"));
  } else { flash("no severity/state filter on this panel"); return; }
  render();
}
function jumpTo(name) {
  let rows = appRows(), i = rows.findIndex((r) => r.name === name);
  if (i < 0) {
    S.filterText = ""; S.readyFilter = ""; S.clusterFilter = ""; S.nsFilter = ""; $("filter").value = "";
    rows = appRows(); i = rows.findIndex((r) => r.name === name);
    if (i >= 0) flash("filters cleared to show " + name);
  }
  if (i < 0) { flash(name + " has no row in the service graph"); return; }
  S.sel.app = i; S.scrollSel = true;
  render();
}
// openConcern opens one issue's detail on panel 3, clearing the filters
// when they hide it.
function openConcern(id) {
  let i = conRows().findIndex((c) => c.id === id);
  if (i < 0) {
    S.filterText = ""; S.sevFilter = ""; S.clusterFilter = ""; S.nsFilter = ""; $("filter").value = "";
    i = conRows().findIndex((c) => c.id === id);
  }
  setPanel("con");
  if (i < 0) { flash("issue " + id + " is no longer listed"); return; }
  S.scrollSel = true;
  openRow("con", i);
}
// openPrediction opens one forecast bubble on panel 4, clearing the filters
// when they hide it.
function openPrediction(svc, cluster) {
  const find = () => predRows().findIndex((p) => p.svc === svc && (!cluster || p.cluster === cluster));
  let i = find();
  if (i < 0) { S.filterText = ""; S.clusterFilter = ""; $("filter").value = ""; i = find(); }
  setPanel("pred");
  if (i < 0) { flash("no forecast for " + svc + " any more"); render(); return; }
  S.sel.pred = i; S.predOpen = true; S.progOpen = "";
  render();
}
async function copySelected() {
  const name = activeList();
  if (!name) return;
  const row = listFor(name)[name === "mem" || name === "app" ? Math.max(0, S.sel[name]) : S.sel[name]];
  if (!row) return;
  const id = name === "evt" ? row.e.id : name === "app" ? row.name : row.id || row.svc;
  try { await navigator.clipboard.writeText(String(id)); flash("copied " + id); }
  catch (e) { flash("clipboard unavailable — " + id); }
}

function openPrompt() {
  if (["cfg", "sig", "use"].includes(S.panel) || !S.D) { flash("nothing to filter here"); return; }
  S.filterEditing = true;
  renderCrumb();
  const inp = $("filter");
  inp.value = S.filterText;
  inp.placeholder = S.panel === "mem" ? "id: kind: title: subject: tag: or text" : "filter " + ({ app: "services", con: S.focus2 === "con" ? "issues" : "events", logic: S.showLoop ? (S.focus7 === "con" ? "issues" : "patterns") : "", pred: "services" }[S.panel] || "");
  inp.focus();
}
function closePrompt(clear) {
  S.filterEditing = false;
  const inp = $("filter");
  if (clear) { S.filterText = ""; inp.value = ""; resetSel(); }
  inp.blur();
  render();
}

// Single dispatcher for hardware keys, the on-screen key bar and the legend.
function handleKey(k) {
  if (S.logoutConfirm) {
    if (k === "y" || k === "Y") logout(); else { S.logoutConfirm = false; flash("sign-out cancelled"); render(); }
    return true;
  }
  if (!S.D) return;
  if (S.tntOpen && tenantsHandleKey(k)) return true;
  // Panel-specific keys first (chat, approvals confirm), so a
  // global binding never steals a key the panel gives its own meaning.
  if (S.D && S.panel === "chat" && !/^[0-9]$/.test(k) && !["T", "N", "D", "q", "?", "cfg"].includes(k) && CHAT.handleKey(k)) return true;
  if (S.D && S.panel === "sig" && APV.approvalsShown() && (APV.confirming() || !/^[0-9]$/.test(k) && !["T", "N", "D", "q", "?", "cfg"].includes(k)) && APV.approvalsHandleKey(k)) return true;
  if (S.panel === "gset" && S.goalEdit && goalEditKey(k)) return true;
  switch (k) {
    case "0": setPanel("chat"); break;
    case "1": setPanel("goal"); break;
    case "2": setPanel("app"); break;
    case "3": setPanel("con"); break;
    case "4": setPanel("pred"); break;
    case "5": setPanel("mem"); break;
    case "6": setPanel("sig"); break;
    case "8": setPanel("gset"); if (!S.goalEdit) { S.goalEdit = { i: 0 }; render(); } break;
    case "7": setPanel("logic"); break;
    case "9": setPanel("use"); break;
    case "q": if (S.D) { S.logoutConfirm = true; render(); } break;
    case "?": if (S.D && S.panel === "con") { S.showStats = !S.showStats; render(); break; }
    if (S.D && S.panel === "logic") { S.showLoop = !S.showLoop; S.detail7 = null; S.scrollSel = true; render(); break; }
    if (S.D && S.panel === "mem") { S.memBack = false; S.memView = S.memView === "map" ? "list" : "map"; S.scrollSel = true; render(); break; }
    // falls through
    case "cfg": if (S.D) setPanel(S.panel === "cfg" ? S.beforeCfg || "goal" : "cfg"); break;
    case "T": case "N": openTenants(); break;
    case "/": openPrompt(); break;
    case "D": {
      const dim = store.get(THEME_KEY) !== "dim";
      if (dim) store.set(THEME_KEY, "dim"); else store.del(THEME_KEY);
      applyTheme(dim); render(); break;
    }
    case "Escape": escape(); break;
    case "j": case "ArrowDown": move(1); break;
    case "k": case "ArrowUp": move(-1); break;
    case "PageDown": move(10); break;
    case "PageUp": move(-10); break;
    case "Enter": {
      const name = activeList();
      if (!name) break;
      if ((name === "mem" || name === "app") && S.sel[name] < 0) { S.sel[name] = 0; render(); break; }
      openRow(name, S.sel[name]);
      break;
    }
    case "BackTab":
      if (S.panel === "sig") jumpSec($("term"), -1);
      break;
    case "Tab":
    case "ArrowLeft":
    case "ArrowRight":
      if (S.panel === "sig") { if (k === "Tab") jumpSec($("term"), 1); }
      else if (S.panel === "con") {
        const next = k === "ArrowLeft" ? "evt" : k === "ArrowRight" ? "con" : S.focus2 === "con" ? "evt" : "con";
        if (next !== S.focus2) { S.focus2 = next; if (S.detail2) S.detail2 = null; render(); }
      } else if (S.panel === "logic" && S.showLoop) {
        const next = k === "ArrowLeft" ? "con" : k === "ArrowRight" ? "pat" : S.focus7 === "con" ? "pat" : "con";
        if (next !== S.focus7) { S.focus7 = next; if (S.detail7) S.detail7 = null; render(); }
      } else if (k === "Tab" && S.panel === "app") {
        const d = document.querySelector("#panel .sub:last-of-type");
        if (d) d.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
      break;
    case "s": cycleS(); break;
    case "c": cycleFilter("c"); break;
    case "n": cycleFilter("n"); break;
    case "y": copySelected(); break;
    case "g":
      if (S.panel === "mem") memNextLink();
      else if (S.panel === "app" && S.appView === "treemap") cycleTm("tmGroup", GROUPS);
      else if (S.panel === "use") { S.useGroup = USE.GROUPS[(USE.GROUPS.indexOf(S.useGroup) + 1) % USE.GROUPS.length]; render(); }
      break;
    case "w":
      if (S.panel === "use") {
        const W = USE.WINDOWS.map((x) => x.id);
        S.useWin = W[(W.indexOf(S.useWin) + 1) % W.length];
        render(); USE.loadUsage();
      } else if (S.panel === "goal") { cycleSignalWindow(); render(); }
      else return false;
      break;
    case "a": if (S.panel === "app") setReady("ready"); break;
    case "A": if (S.panel === "app") setReady("not-ready"); break;
    case "u": if (S.panel === "app") setReady("unknown"); break;
    case "d": if (S.panel === "app") setReady("drift"); break;
    case "v": if (S.panel === "app") setReady("virtual"); break;
    case "V": if (S.panel === "app") setReady("real"); break;
    case "m": if (S.panel === "app") { S.appView = S.appView === "treemap" ? "graph" : "treemap"; render(); } else return false; break;
    case "z": if (S.panel === "app" && S.appView === "treemap") cycleTm("tmSize", SIZES); else return false; break;
    case "p": if (S.panel === "logic") { S.procPath = PROC_PATHS[(PROC_PATHS.indexOf(S.procPath) + 1) % PROC_PATHS.length]; render(); } else return false; break;
    default: return false;
  }
  return true;
}

// ── events ──────────────────────────────────────────────────────────────────
let lastTap = { list: null, i: -1, t: 0 };
function onClick(ev) {
  const t = ev.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  if (!S.D && act !== "retry") return; // the splash's only action
  if (act === "key") { ev.preventDefault(); handleKey(t.dataset.k); return; }
  if (act === "voice") { if (S.D) VOICE.toggle(S.D.tenant); return; }
  if (act === "logout-yes") { logout(); return; }
  if (act === "logout-no") { S.logoutConfirm = false; render(); return; }
  if (act === "tnt-close") { closeTenants(); return; }
  if (CHAT.click(act, t)) return;
  if (APV.approvalsClick(act)) return;
  if (act === "sel") {
    const list = t.dataset.list, i = Number(t.dataset.i), now = Date.now();
    const dbl = lastTap.list === list && lastTap.i === i && now - lastTap.t < 450;
    lastTap = { list, i, t: dbl ? 0 : now };
    if (list === "agent") { APV.approvalsSelect(i, dbl); return; }
    // With the detail pane showing, a tap compares and a double-tap scopes;
    // without it there is nothing to compare, so a tap scopes.
    if (list === "tnt" && (dbl || tpNarrow())) { openRow("tnt", i); return; }
    if (dbl) { openRow(list, i); return; }
    if (S.panel === "logic" && (list === "con" || list === "pat")) {
      S.focus7 = list;
      if (S.detail7 && S.detail7.kind === list) S.detail7 = { kind: list, i };
    } else if (list === "con" || list === "evt") {
      S.focus2 = list;
      if (S.detail2 && S.detail2.kind === list) S.detail2 = { kind: list, i };
    }
    S.sel[list] = i;
    render();
    return;
  }
  if (act === "goalstep") { S.goalEdit = { i: Number(t.dataset.i) }; stepOwnGoal(S.goalEdit.i, Number(t.dataset.d)); return; }
  if (act === "gopanel") { setPanel(t.dataset.v); return; }
  if (act === "goalsel") { S.goalEdit = { i: Number(t.dataset.i) }; render(); return; }
  if (act === "readyf") { S.readyFilter = t.dataset.v; S.sel.app = -1; render(); return; }
  if (act === "jump") { jumpTo(t.dataset.v); return; }
  if (act === "conjump") { openConcern(t.dataset.id); return; }
  if (act === "sigwin") { setSignalWindow(t.dataset.v); render(); return; }
  if (act === "appview") { S.appView = t.dataset.v; render(); return; }
  if (act === "tmgroup") { S.tmGroup = t.dataset.v; render(); return; }
  if (act === "tmsize") { S.tmSize = t.dataset.v; render(); return; }
  if (act === "appfilt") { setPanel("app"); S.readyFilter = t.dataset.v; S.sel.app = -1; render(); return; }
  if (act === "predjump") { openPrediction(t.dataset.svc, t.dataset.cluster); return; }
  if (act === "clear") {
    const w = t.dataset.v;
    if (w === "text") { S.filterText = ""; $("filter").value = ""; }
    if (w === "ready") S.readyFilter = "";
    if (w === "sev") S.sevFilter = "";
    if (w === "cluster") S.clusterFilter = "";
    if (w === "ns") S.nsFilter = "";
    resetSel(); render(); return;
  }
  if (act === "memkind") {
    S.filterText = "kind:" + t.dataset.kind; $("filter").value = S.filterText;
    S.sel.mem = -1; S.memView = "list"; render(); return;
  }
  if (act === "memjump") { S.sel.mem = Number(t.dataset.i); S.scrollSel = true; render(); return; }
  if (act === "loopjump") { S.focus7 = t.dataset.list; S.sel[t.dataset.list] = Number(t.dataset.i); S.detail7 = null; S.scrollSel = true; render(); return; }
  if (act === "pbub") { const i = Number(t.dataset.i); S.predOpen = !(S.predOpen && S.sel.pred === i); S.sel.pred = i; S.progOpen = ""; render(); return; }
  if (act === "prog") { S.progOpen = S.progOpen === t.dataset.id ? "" : t.dataset.id; S.predOpen = false; render(); return; }
  if (act === "retry") { refresh(); return; }
  if (act === "shift") { setShift(!S.shiftHeld); return; }
  if (act === "keys") {
    S.keysShown = !S.keysShown;
    if (S.keysShown) { store.set(KEYS_KEY, "shown"); $("kbd").focus(); } else { store.del(KEYS_KEY); $("kbd").blur(); }
    renderLegend();
    return;
  }
  if (act === "kbd") {
    const k = $("kbd");
    if (document.activeElement === k) { k.blur(); t.classList.remove("on"); }
    else { k.focus(); t.classList.add("on"); }
  }
}

const NAMED = new Set(["Escape", "Enter", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"]);
function setShift(on) {
  if (S.shiftHeld === on) return;
  S.shiftHeld = on;
  const b = document.querySelector('[data-act="shift"]');
  if (b) b.classList.toggle("on", on);
  renderLegend();
}

function onKeyDown(ev) {
  const target = ev.target;
  if (ev.key === "Shift") { setShift(true); return; }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (target && target.id === "filter") {
    if (ev.key === "Escape") { ev.preventDefault(); closePrompt(true); }
    else if (ev.key === "Enter") { ev.preventDefault(); closePrompt(false); }
    else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); move(ev.key === "ArrowDown" ? 1 : -1); }
    return;
  }
  if (target && /^chatt?q$/.test(target.id)) { if (CHAT.inputKeyDown(ev)) renderLegend(); return; }
  if (target && target !== $("kbd") && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  const k = ev.key === "Tab" && ev.shiftKey ? "BackTab" : ev.key;
  if (k.length !== 1 && !NAMED.has(k) && k !== "BackTab") return;
  if (handleKey(k) !== false) ev.preventDefault();
}

function onFilterInput(ev) {
  S.filterText = ev.target.value;
  resetSel();
  renderPanel();
  renderLegend();
}

// The soft keyboard on iPad often reports key "Unidentified"; take the typed
// character from the input event instead.
function onKbdInput(ev) {
  const el = ev.target;
  const ch = (ev.data || el.value || "").slice(-1);
  el.value = "";
  if (ch) handleKey(ch);
}

// Hovering a map cell shows X-Ray's card: kind, title, subject and tags.
// Hovering a map cell previews it in the caption line; leaving it puts the
// selected cell back. The line is rewritten in place, the map is not redrawn.
function initMemHover() {
  let shown = null;
  const show = (i) => {
    if (i === shown) return;
    shown = i;
    const cap = $("mmcap");
    if (!cap) return;
    const rows = memRows();
    cap.innerHTML = i == null || i === S.sel.mem ? memCap(S.sel.mem >= 0 ? rows[S.sel.mem] : null, true) : memCap(rows[i], false);
  };
  const panel = $("panel");
  panel.addEventListener("mousemove", (ev) => {
    const cell = ev.target.closest && ev.target.closest(".mm-cell");
    show(cell ? Number(cell.dataset.i) : null);
  });
  panel.addEventListener("mouseleave", () => show(null));
  // A redraw writes the selected cell's caption; the next move starts over.
  new MutationObserver(() => { shown = null; }).observe(panel, { childList: true });
}
function boot() {
  APV.initApprovals({ S, render, flash });
  VOICE.initVoice(() => { renderTabBar(); renderCrumb(); });
  VOICE.onTranscript(CHAT.voiceEvent);
  LIVE.bindLive({
    tenant: () => (S.D ? S.D.tenant : S.tenantPref),
    user: () => (S.D && S.D.user) || "",
    onRaw: (fn) => { if (S.raw && S.D && fn(S.raw)) { S.D = API.mapAll(S.raw, S.D.tenant, nowMs()); if (S.panel === "mem") render(); } },
    onRedraw: memRedraw,
  });
  CHAT.initChat({ S, flash, redraw: () => { if (S.D && S.panel === "chat") { renderPanel(); renderLegend(); } } });
  USE.initUsage({ S, redraw: () => { if (S.D && S.panel === "use") renderPanel(); } });
  initMemHover();
  document.addEventListener("click", onClick);
  // The memory map is drawn to the panel's size; redraw it when that changes.
  let resizeT = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (S.D && (S.panel === "use" || S.panel === "chat" || S.panel === "mem" && S.memView === "map")) renderPanel(); }, 150);
  });
  // The lists that fit the body follow it when its height changes (window, key row).
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => fitRows($("panel"))).observe($("term"));
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", (ev) => { if (ev.key === "Shift") setShift(false); });
  window.addEventListener("blur", () => setShift(false));
  $("filter").addEventListener("input", onFilterInput);
  $("panel").addEventListener("input", (ev) => { CHAT.onInput(ev); });
  $("kbd").addEventListener("input", onKbdInput);
  $("kbd").addEventListener("blur", () => { const b = document.querySelector('[data-act="kbd"]'); if (b) b.classList.remove("on"); });
  render();
  refresh();
  setInterval(() => { if (S.conn !== "auth" && !document.hidden) refresh(); }, RESYNC_MS);
  // Panel 7 keeps its memory counts live: the memory feed alone, every 30 s.
  setInterval(async () => {
    if (S.panel !== "logic" || S.conn === "auth" || document.hidden || !S.raw || !S.D) return;
    const epoch = S.epoch, tenant = S.D.tenant, m = await API.fetchMemory(tenant);
    if (epoch !== S.epoch || !S.D || S.D.tenant !== tenant) return;
    Object.assign(S.raw, m);
    S.D = API.mapAll(S.raw, tenant, nowMs());
    if (S.panel === "logic") render();
  }, 30 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && S.lastAttempt && Date.now() - S.lastAttempt > RESYNC_MS) refresh();
  });
}

boot();
