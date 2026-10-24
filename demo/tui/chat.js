// Panel 0: chat with the core's agent over GET /v2/agent/chat (a WebSocket;
// same-origin, so the session cookie authenticates the upgrade). The core
// runs the model (fixed, named in its hello), the voice tool set, the
// tenant binding and the per-user daily chat cap (core ADR-066).
//
//   up:   {"text", "history"?, "files"?} · {"confirm": {"id", "ok"}} · {"stop": true}
//
// A socket is one conversation on the core. The transcript stays here, so
// the first message on a new socket (after a disconnect or a core restart)
// carries the earlier question and answer texts as "history" and the
// conversation goes on.
//   down: {"hello"} · {"delta"} · {"tool"} · {"note"} · {"usage"} · {"done"} · {"error"}
//
// Left: the conversation (tool calls fold open to their arguments and
// result; answers and results copy). Right: tokens (this chat, the last
// call, history against its budget, today against the cap), starter
// questions and the tools the model has (asks first for the write ones).
// While a voice session is open, what is typed here goes to the voice session
// instead, and its spoken conversation shows in the same log.
//
// The ask line (bottom of ask section below) is the same conversation from
// every other panel: a permanent one-line prompt with a drawer above it.
//
// The side's chats list (rooms.js, core ADR-092) switches the panel between
// this private chat, the workspaces' conversations and direct chats; r / R
// step through them, and rooms.js draws and drives an open one.
import { esc, panelTitle, sub, copyText } from "./ui.js";
import { tenantName } from "./api.js";
import * as VOICE from "./voice.js";
import * as ROOMS from "./rooms.js";
import { prepare, shown, wire } from "../mobile/api/chatfiles.js";

const STARTERS = [
  "What is open right now, and what matters most?",
  "What changed in the last hour?",
  "Which services are degraded, and why?",
  "What does memory say about the last incident on this tenant?",
  "Summarise today's events for a handover.",
];

const CH = {
  ws: null, conn: "idle", tenant: "", // conn: idle | connecting | open | closed
  hello: null, usage: null,
  items: [],          // { k: user|bot|tool|note|err|sys, ... }
  busy: false, draft: "", pending: null,
  files: [],          // prepared attachments waiting for the next question (core ADR-096)
  resume: false,      // the next message carries the transcript to a new socket
  // The stored conversation (core ADR-096): pastFor is the workspace whose
  // stored turns this page has asked for, pastOpen that the next past frame
  // is its first, older the token for the page before the oldest shown, and
  // fresh that the next socket starts without the stored turns.
  pastFor: null, pastOpen: false, older: "", fresh: false, loadingOlder: false, anchor: 0,
  toolQ: "", toolOpen: "",
  voiceQuota: null,   // { used, limit } pushed by a running voice session
  follow: true,
};

let C = null; // { S, redraw, flash }
export function initChat(ctx) {
  C = ctx;
  ROOMS.initRooms({ flash: (m) => C.flash(m), redraw, md });
}

let drawQueued = false;
function redraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; C.redraw(); askRender(); });
}

// ── socket ──────────────────────────────────────────────────────────────────
const tenantNow = () => (C.S.D && C.S.D.tenant) || "";

function connect() {
  if (CH.ws) return;
  CH.conn = "connecting"; CH.tenant = tenantNow();
  const params = new URLSearchParams(CH.tenant ? { tenant: CH.tenant } : {});
  if (CH.fresh) { params.set("fresh", "1"); CH.fresh = false; }
  const q = params.toString() ? "?" + params : "";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/v2/agent/chat${q}`);
  CH.ws = sock;
  let opened = false, refused = false;
  sock.onopen = () => { opened = true; };
  // A refusal (today's limit, no v grant) arrives as an error frame on a
  // socket the core opens only to say why, then closes.
  sock.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.refused) refused = true; onMessage(m); };
  sock.onclose = () => {
    if (CH.ws !== sock) return;
    CH.ws = null; CH.conn = "closed";
    if (CH.busy) CH.busy = false;
    closeOpenTools("stopped");
    if (opened && !refused && CH.items.some((x) => x.k === "user" && !x.voice)) CH.resume = true;
    // A socket that never opened is not always a refusal: a restarting core
    // looks the same from here. The unsent message goes back to the input,
    // with the earlier turns it carried, so enter tries again.
    const p = CH.pending;
    if ((!opened || refused) && p) {
      const i = CH.items.findLastIndex((x) => x.k === "user" && !x.voice);
      const it = i >= 0 && (CH.items[i].sent || CH.items[i].text) === p.text ? CH.items[i] : null;
      if (it) CH.items.splice(i, 1);
      // Back to the box it was typed in.
      const q = it && it.ask ? askInput() : null;
      if (q) { if (!q.value) q.value = it.text; } else if (!CH.draft) CH.draft = it ? it.text : p.text;
      if (p.history) CH.resume = true;
    }
    if (!refused) CH.items.push(opened
      ? { k: "sys", text: "disconnected — the next message reconnects and carries this conversation over" }
      : { k: "err", text: "could not reach the chat — enter sends again. If it keeps failing, the core may be restarting, voice or the v grant is off for this tenant, or today's chat limit is spent" });
    CH.pending = null;
    redraw();
  };
  redraw();
}

function send(obj) {
  if (CH.ws && CH.ws.readyState === WebSocket.OPEN) { CH.ws.send(JSON.stringify(obj)); return true; }
  return false;
}

// The core's refusal when a workspace has spent its day's tokens names the
// workspace by id and says it twice; say it once, by name.
const BUDGET_RE = /daily llm budget exhausted/;
function budgetText(t) {
  const m = /^tenant "([^"]+)" daily llm budget exhausted/.exec(t);
  return m ? `workspace ${tenantName(m[1])}: today's token budget is used up` : t;
}

function onMessage(m) {
  if (m.hello) {
    CH.hello = m.hello; CH.conn = "open";
    CH.pastOpen = CH.pastFor !== CH.tenant; CH.pastFor = CH.tenant;
    if (m.hello.usage) { CH.usage = m.hello.usage; CH.voiceQuota = null; }
    if (CH.pending) { const p = CH.pending; CH.pending = null; send(p); }
  }
  if (m.delta) {
    const last = CH.items[CH.items.length - 1];
    if (last && last.k === "bot" && !last.done && !last.voice) last.text += m.delta;
    else { CH.items.push({ k: "bot", text: m.delta }); askOpen(true); }
  }
  if (m.past) onPast(m.past);
  if (m.tool) onTool(m.tool);
  if (m.note) CH.items.push({ k: "note", text: m.note });
  if (m.usage) { CH.usage = m.usage; CH.voiceQuota = null; CH.budgetOut = false; }
  if (m.error) {
    if (BUDGET_RE.test(m.error)) CH.budgetOut = true;
    CH.items.push({ k: "err", text: budgetText(m.error) });
  }
  if (m.done) {
    CH.busy = false;
    CH.items.forEach((it) => { if (it.k === "bot") it.done = true; });
  }
  redraw();
}

// The stored conversation of this workspace arrives once per page, right
// after the first hello; a reconnect already has it in the log.
const pastItems = (turns) => turns.map((t) => (t.role === "user" ? { k: "user", text: t.text, files: t.files, past: true } : { k: "bot", text: t.text, done: true, past: true }));
function onPast(p) {
  if (!CH.pastOpen) return;
  CH.pastOpen = false;
  CH.items.unshift(...pastItems(p.turns || []));
  CH.older = p.next || "";
  CH.follow = true;
}

// One page of older stored turns above the log.
async function loadOlder() {
  if (!CH.older || CH.loadingOlder) return;
  CH.loadingOlder = true; redraw();
  try {
    const q = new URLSearchParams({ before: CH.older });
    if (CH.tenant) q.set("tenant", CH.tenant);
    const res = await fetch("/v2/messenger/tria/history?" + q, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const page = await res.json();
    const box = document.querySelector('[data-scroll="chat"]');
    CH.anchor = box ? box.scrollHeight - box.scrollTop : 0;
    CH.items.unshift(...pastItems(page.turns || []));
    CH.older = page.next || "";
    CH.follow = false;
  } catch (e) {
    C.flash("could not load older messages — " + e.message);
  }
  CH.loadingOlder = false; redraw();
}

function onTool(t) {
  // A tool call ends the text before it: the next delta starts a new answer.
  CH.items.forEach((it) => { if (it.k === "bot") it.done = true; });
  let it = CH.items.find((x) => x.k === "tool" && x.id === t.id);
  if (!it) { it = { k: "tool", id: t.id, name: t.name, args: t.args || {}, state: t.state, open: t.state === "ask" }; CH.items.push(it); }
  it.state = t.state;
  if (t.args) it.args = t.args;
  if (t.result != null) it.result = t.result;
  if (t.ms != null) it.ms = t.ms;
  if (t.state === "ok" || t.state === "denied") it.open = false;
  if (t.state === "error") it.open = true;
}

// ── voice ───────────────────────────────────────────────────────────────────
// A voice session (voice.js) writes its transcript into this log. The pieces
// arrive in fragments: they join the open "you" or "tria" line until the
// other side speaks. The text chat's model does not see these lines; the voice
// session keeps its own context.
let voiceTool = 0;
const openVoice = (k) => { const last = CH.items[CH.items.length - 1]; return last && last.k === k && last.voice && !last.done ? last : null; };
const endVoiceText = () => CH.items.forEach((it) => { if (it.voice && (it.k === "user" || it.k === "bot")) it.done = true; });
export function voiceEvent(e) {
  if (e.t === "quota") { CH.voiceQuota = { used: Number(e.used) || 0, limit: Number(e.limit) || 0 }; redraw(); return; }
  if (e.t === "start") CH.items.push({ k: "sys", text: "voice session — the conversation shows here" });
  if (e.t === "you" || e.t === "bot") {
    const k = e.t === "you" ? "user" : "bot";
    const it = openVoice(k);
    if (it) it.text += e.text;
    else if (e.text.trim()) { endVoiceText(); CH.items.push({ k, voice: true, text: e.text.trimStart() }); }
  }
  if (e.t === "tool") { endVoiceText(); CH.items.push({ k: "tool", voice: true, id: "voice-" + ++voiceTool, name: e.text, args: {}, state: "run" }); }
  if (e.t === "result") {
    const it = [...CH.items].reverse().find((x) => x.k === "tool" && x.voice && x.state === "run");
    if (it) { it.state = "ok"; it.result = e.text; }
  }
  if (e.t === "end") {
    endVoiceText();
    CH.items.forEach((it) => { if (it.k === "tool" && it.voice && it.state === "run") it.state = "stopped"; });
    CH.items.push({ k: "sys", text: "voice session ended" });
  }
  CH.follow = true;
  redraw();
}

function closeOpenTools(state) {
  CH.items.forEach((it) => { if (it.k === "tool" && (it.state === "ask" || it.state === "run")) it.state = state; });
}

// ── actions ─────────────────────────────────────────────────────────────────
function submit() {
  const text = CH.draft.trim();
  if ((text || CH.files.length) && post(text, text, false, CH.files)) { CH.draft = ""; CH.files = []; }
}

// Attach picked, pasted or dropped files to the next question.
async function attach(picked) {
  if (!picked.length) return;
  try { CH.files = [...CH.files, ...await prepare(picked, CH.files)]; } catch (e) { C.flash(e.message); }
  redraw();
}

// Send one question: text is what the transcript shows, sent what goes to
// the model (the ask line adds a context line). False when it did not go.
function post(text, sent, ask, files = []) {
  if (VOICE.active()) {
    if (!VOICE.sendText(sent)) { C.flash("voice is connecting — try again in a moment"); return false; }
    endVoiceText();
    CH.items.push({ k: "user", voice: true, done: true, text });
    CH.follow = true;
    redraw();
    return true;
  }
  if (CH.busy) return false;
  if (CH.tenant && CH.tenant !== tenantNow() && CH.items.length) {
    if (CH.ws) { const old = CH.ws; CH.ws = null; old.close(); }
    CH.resume = false;
    // The new workspace has its own stored conversation, shown when it connects.
    CH.items = []; CH.older = ""; CH.pastFor = null;
  }
  const msg = { text: sent };
  if (files.length) msg.files = wire(files);
  if (CH.resume) { msg.history = transcript(); CH.resume = false; }
  CH.items.push({ k: "user", text, ...(sent === text ? {} : { sent }), ask, ...(files.length ? { files: shown(files) } : {}) });
  CH.busy = true; CH.follow = true;
  if (!send(msg)) { CH.pending = msg; connect(); }
  redraw();
  return true;
}

// The questions and answers so far, without tool calls, for a new socket.
function transcript() {
  return CH.items.filter((x) => (x.k === "user" || x.k === "bot") && x.text && !x.voice).map((x) => ({ role: x.k === "user" ? "user" : "model", text: x.sent || x.text }));
}

function stop() {
  if (!CH.busy) return false;
  send({ stop: true });
  return true;
}

function confirmTool(id, ok) {
  const it = CH.items.find((x) => x.k === "tool" && x.id === id);
  if (!it || it.state !== "ask") return;
  send({ confirm: { id, ok } });
  it.state = ok ? "run" : "denied";
  redraw();
}
const pendingAsk = () => CH.items.find((x) => x.k === "tool" && x.state === "ask");

function newChat() {
  if (CH.busy) { C.flash("stop the answer first (esc)"); return; }
  const had = CH.items.some((x) => x.k === "bot" && !x.voice);
  if (!had && !CH.ws && !CH.items.length) { C.flash("already a new conversation"); return; }
  if (CH.ws) { const old = CH.ws; CH.ws = null; old.close(); }
  CH.items = []; CH.conn = "idle"; CH.usage = null; CH.budgetOut = false; CH.hello = null; CH.resume = false;
  // The stored conversation stays; this one starts without it.
  CH.fresh = true; CH.older = "";
  C.flash(had ? "new conversation — the last one is kept as a session note" : "new conversation");
  redraw();
}

function setDraft(v, focus) {
  CH.draft = v;
  redraw();
  if (focus) requestAnimationFrame(() => { const q = document.getElementById("chatq"); if (q) { q.focus(); const n = q.value.length; q.setSelectionRange(n, n); } });
}

async function copyLast() {
  const it = [...CH.items].reverse().find((x) => x.k === "bot");
  if (!it) { C.flash("no answer to copy yet"); return; }
  C.flash((await copyText(it.text)) ? "copied the last answer" : "clipboard unavailable");
}

// ── rendering ───────────────────────────────────────────────────────────────
const k = (n) => (n == null ? "–" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : esc(String(n)));

// Inline Markdown on escaped text: `code` and **bold**.
const inline = (s) => esc(s)
  .replace(/`([^`\n]+)`/g, '<code class="chc">$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");

// The subset of Markdown an answer uses: fenced code, tables (kept as
// monospace lines), headings, lists and paragraphs. Everything is escaped
// before any tag is added.
export function md(src) {
  const out = [];
  String(src || "").split(/^```[^\n]*\n?/m).forEach((part, i) => {
    if (i % 2) { out.push(`<pre class="chpre">${esc(part.replace(/\n$/, ""))}</pre>`); return; }
    let para = [], table = [];
    const flushP = () => { if (para.length) out.push(`<p class="para">${para.map(inline).join("\n")}</p>`); para = []; };
    const flushT = () => { if (table.length) out.push(`<pre class="chpre tbl">${esc(table.join("\n"))}</pre>`); table = []; };
    part.split("\n").forEach((line) => {
      const t = line.trim();
      if (/^\|.*\|$/.test(t)) { flushP(); if (!/^\|[\s:|-]+\|$/.test(t)) table.push(t); return; }
      flushT();
      let m;
      if (!t) { flushP(); return; }
      if ((m = t.match(/^#{1,6}\s+(.*)$/))) { flushP(); out.push(`<div class="chh">${inline(m[1])}</div>`); return; }
      if ((m = line.match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/))) {
        flushP();
        const lvl = Math.min(3, Math.floor(m[1].length / 2));
        const mark = /\d/.test(m[2]) ? esc(m[2]) : "•";
        out.push(`<div class="chli" style="padding-left:${1.3 + lvl * 1.2}em"><span class="chm" style="left:${lvl * 1.2}em">${mark}</span>${inline(m[3])}</div>`);
        return;
      }
      para.push(line);
    });
    flushP(); flushT();
  });
  return out.join("");
}

const pretty = (s) => {
  const t = String(s || "").trim();
  if (!/^[[{]/.test(t)) return s;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { return s; }
};
const argLine = (a, max = 90) => {
  const s = Object.entries(a || {}).map(([x, v]) => x + "=" + (typeof v === "string" ? v : JSON.stringify(v))).join(" ").replace(/\s+/g, " ");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};
const STATE = { ask: ["fg-warn", "asks"], run: ["fg-violet", "running…"], ok: ["fg-ok", "ok"], error: ["fg-crit", "error"], denied: ["fg-faint", "declined"], stopped: ["fg-faint", "stopped"] };

// The drawer shows the arguments in its confirm line (panel 0 has them in the tool row above), so a y is never given blind.
const askButtons = (it, withArgs) => `<div class="btnrow chask"><span class="fg-warn">run ${esc(it.name)}?</span>${withArgs ? `<span class="fg-dim" style="min-width:0;flex:1 1 12em;overflow-wrap:anywhere" title="${esc(argLine(it.args, 2000))}">${esc(argLine(it.args, 240))}</span>` : ""}<button type="button" class="btn primary" data-act="chat-yes" data-id="${esc(it.id)}">y — run</button><button type="button" class="btn" data-act="chat-no" data-id="${esc(it.id)}">n — decline</button></div>`;

// The files of a question: a photo shows small and opens whole, anything else is its name.
// Urls are the core's own paths or this page's blob previews.
function filesHTML(files) {
  if (!files || !files.length) return "";
  return `<div class="chfiles">` + files.map((f) => {
    const name = esc(f.name);
    if (f.thumb && String(f.mime).startsWith("image/")) return `<a href="${esc(f.url)}" target="_blank" rel="noopener"><img class="chimg" src="${esc(f.thumb)}" alt="${name}"></a>`;
    return f.url ? `<a class="chfile" href="${esc(f.url)}" target="_blank" rel="noopener" download="${name}"><i class="ph ph-file"></i>${name}</a>` : `<span class="chfile"><i class="ph ph-file"></i>${name}</span>`;
  }).join("") + `</div>`;
}

function itemHTML(it, i) {
  if (it.k === "user") return `<div class="chu"><span class="chwho fg-mag">you</span><div class="chtext">${filesHTML(it.files)}${it.text ? `<p class="para fg-strong">${esc(it.text)}</p>` : ""}</div></div>`;
  if (it.k === "bot") return `<div class="chb"><span class="chwho fg-accent">tria</span><div class="chtext">${md(it.text)}${it.done ? `<button type="button" class="chcopy" data-act="chat-copy" data-i="${i}">copy</button>` : ""}</div></div>`;
  if (it.k === "note") return `<div class="chn"><span class="chwho fg-info">report</span><p class="para fg-dim">${esc(it.text)}</p></div>`;
  if (it.k === "err") return `<div class="chn"><span class="chwho fg-crit">error</span><p class="para fg-crit">${esc(it.text)}</p></div>`;
  if (it.k === "sys") return `<div class="chn"><span class="chwho"></span><p class="para fg-faint">${esc(it.text)}</p></div>`;
  const [cls, word] = STATE[it.state] || ["fg-dim", esc(String(it.state))];
  let html = `<div class="cht"><div class="chtl" data-act="chat-tool" data-i="${i}"><span class="fg-faint">${it.open ? "▾" : "▸"}</span><span class="fg-label">${esc(it.name)}</span><span class="cha fg-dim">${esc(argLine(it.args))}</span><span class="${cls}">${word}${it.ms != null && it.state !== "ask" ? " " + (Number(it.ms) || 0) + "ms" : ""}</span></div>`;
  if (it.state === "ask") html += askButtons(it);
  if (it.open) {
    html += `<div class="chtd"><div class="fg-faint">arguments</div><pre class="chpre">${esc(JSON.stringify(it.args || {}, null, 2))}</pre>`;
    if (it.result != null) html += `<div class="fg-faint">result <button type="button" class="chcopy" data-act="chat-copyres" data-i="${i}">copy</button></div><pre class="chpre">${esc(pretty(it.result))}</pre>`;
    html += `</div>`;
  }
  return html + `</div>`;
}

function meter(label, used, cap, note) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const col = pct >= 85 ? "var(--crit)" : pct >= 60 ? "var(--warn)" : "var(--ok)";
  return `<div class="blast"><span class="k">${esc(label)}</span><span class="bar"><span style="width:${pct.toFixed(1)}%;background:${col}"></span></span><span class="v chv">${esc(note)}</span></div>`;
}

function tokensBox() {
  const H = CH.hello, U = CH.usage;
  const row = (kk, vv) => `<div class="kv"><span class="k">${esc(kk)}</span><span class="v">${vv}</span></div>`;
  let html = sub("tokens", ' data-sec="1"');
  html += row("model", H ? `<span class="fg-strong">${esc(H.model)}</span>` : `<span class="fg-faint">${CH.conn === "connecting" ? "connecting…" : "–"}</span>`);
  if (H) html += row("scope", H.bound ? esc(tenantName(H.tenant)) : `<span class="fg-dim">all your tenants</span>`);
  if (U) {
    html += row("this chat", `in ${k(U.sessionInput)} · out ${k(U.sessionOutput)}`);
    if (U.input || U.output) html += row("last call", `in ${k(U.input)} · out ${k(U.output)} · think ${k(U.thoughts)}${U.cached ? " · cached " + k(U.cached) : ""}`);
    html += meter("history", U.context, U.contextLimit, k(U.context) + " / " + k(U.contextLimit));
    html += U.limit > 0 ? meter("chat today", U.used, U.limit, k(U.used) + " / " + k(U.limit)) : row("chat today", `<span class="fg-dim">no daily cap</span>`);
  }
  // Voice's own cap: live from a running voice session, else as of the chat's last push.
  const V = CH.voiceQuota || (U && U.voiceLimit != null ? { used: U.voiceUsed, limit: U.voiceLimit } : null);
  if (V) html += V.limit > 0 ? meter("voice today", V.used, V.limit, k(V.used) + " / " + k(V.limit)) : row("voice today", `${k(V.used)} <span class="fg-dim">· no daily cap</span>`);
  if (H) html += row("limits", `<span class="fg-dim">${k(H.maxOutputTokens)} out per call · ${esc(String(H.toolsPerAnswer))} tools per answer · older turns drop past ${k(H.contextTokens)}</span>`);
  return html;
}

function toolsSide() {
  const H = CH.hello;
  let html = sub("ask", ' data-sec="1"') + STARTERS.map((s, i) => `<div class="tr chst" data-act="chat-starter" data-i="${i}"><span class="fg-violet">›</span><span class="c flex">${esc(s)}</span></div>`).join("");
  html += sub("tools" + (H ? " (" + H.tools.length + ")" : ""), ' data-sec="1"');
  if (!H) return html + `<span class="fg-faint">listed when the chat connects — send a message, or </span><button type="button" class="chcopy" data-act="chat-connect">connect now</button>`;
  html += `<label class="dsearch"><i class="ph ph-magnifying-glass"></i><input id="chattq" type="text" autocomplete="off" spellcheck="false" placeholder="filter tools" value="${esc(CH.toolQ)}"></label>`;
  const q = CH.toolQ.toLowerCase();
  const list = H.tools.filter((t) => !q || t.name.includes(q) || (t.description || "").toLowerCase().includes(q));
  html += list.map((t) => {
    const open = CH.toolOpen === t.name;
    return `<div class="tr chtool${open ? " sel" : ""}" data-act="chat-toolinfo" data-n="${esc(t.name)}"><span class="c flex">${esc(t.name)}</span>${t.confirm ? `<span class="fg-warn">asks</span>` : ""}</div>` +
      (open ? `<div class="chtinfo"><p class="para fg-dim">${esc(t.description || "")}</p><div class="btnrow"><button type="button" class="chcopy" data-act="chat-usetool" data-n="${esc(t.name)}">ask with it</button><button type="button" class="chcopy" data-act="chat-copyname" data-n="${esc(t.name)}">copy name</button></div></div>` : "");
  }).join("") || `<span class="fg-faint">no tool matches ${esc(CH.toolQ)}</span>`;
  return html;
}

export function chatPanel() {
  ROOMS.ensure();
  if (ROOMS.active()) return ROOMS.panelHTML();
  // Connect on sight so the model, the caps and today's spend show before the first question.
  if (CH.conn === "idle" && !CH.ws) connect();
  const status = CH.conn === "open" ? (CH.busy ? `<span class="fg-violet">answering… esc stops</span>` : `<span class="fg-ok">connected</span>`)
    : CH.conn === "connecting" ? `<span class="fg-violet">connecting…</span>`
    : CH.conn === "closed" ? `<span class="fg-faint">disconnected</span>` : `<span class="fg-faint">not connected</span>`;
  const older = CH.older ? `<div class="chn"><span class="chwho"></span><p class="para"><button type="button" class="chcopy" data-act="chat-older">${CH.loadingOlder ? "loading…" : "older messages"}</button></p></div>` : "";
  const log = CH.items.length ? older + CH.items.map(itemHTML).join("")
    : `<div class="empty">Ask about issues, services, events or memory. Tria calls the core's tools and shows each call; it asks before any change. Enter sends, shift+enter adds a line.</div>`;
  const ask = pendingAsk();
  return `<div class="grid chatgrid${ROOMS.sideFolded() ? " fold" : ""}">
    <div class="col chatmain">
      <div class="tbar">${panelTitle("tria", tenantNow())}<span class="fill"></span><span class="hint">${status}</span>${ROOMS.sideButton()}</div>
      <div class="chatlog" data-scroll="chat">${log}</div>
      ${ROOMS.pickerHTML()}
      <div class="chatin">
        ${CH.files.length ? `<div class="chfiles chpend">${CH.files.map((f, i) => `<span class="chfile">${esc(f.name)}<button type="button" class="chcopy" data-act="chat-unattach" data-i="${i}" title="remove">×</button></span>`).join("")}</div>` : ""}
        <textarea id="chatq" rows="3" spellcheck="false" placeholder="${ask ? "answer the confirm above (y / n), or type on" : VOICE.active() ? "type to the voice session…  enter sends · esc leaves" : "ask tria…  enter sends · shift+enter newline · esc leaves"}">${esc(CH.draft)}</textarea>
        <div class="chatbtns">
          ${CH.busy ? `<button type="button" class="btn" data-act="chat-stop"><i class="ph ph-stop"></i>stop</button>` : `<button type="button" class="btn primary" data-act="chat-send"${CH.draft.trim() || CH.files.length ? "" : " disabled"}><i class="ph ph-play"></i>send</button>`}
          ${CH.hello && CH.hello.files && !VOICE.active() ? `<button type="button" class="btn" data-act="chat-attach" title="attach images, PDFs or text files: up to 4, 2 MB each; photos are shrunk to fit"><i class="ph ph-paperclip"></i>attach</button><input id="chatfile" type="file" multiple hidden accept="image/*,application/pdf,text/*,.json,.yaml,.yml,.csv,.log,.md">` : ""}
          <button type="button" class="btn" data-act="chat-new" title="new conversation (x)"><i class="ph ph-plus"></i>new</button>
        </div>
      </div>
    </div>
    <div class="col chatside" data-scroll="chatside">
      ${ROOMS.sideHTML()}
      ${tokensBox()}
      ${toolsSide()}
    </div>
  </div>`;
}

// Size the log so the input row ends at the bottom of the terminal body
// (no page scroll under the key bar), and the side column to the same
// height. Stacked layouts (narrow screens) keep the CSS heights.
function fit(el, box) {
  const term = document.getElementById("term"), main = el.querySelector(".chatmain"), side = el.querySelector(".chatside");
  if (!term || !main || window.matchMedia("(max-width: 899px)").matches) return;
  const pad = parseFloat(getComputedStyle(term).paddingBottom) || 0;
  const avail = term.getBoundingClientRect().bottom - pad - main.getBoundingClientRect().top;
  const rest = main.offsetHeight - box.offsetHeight;
  box.style.height = Math.max(160, Math.floor(avail - rest)) + "px";
  if (side) side.style.maxHeight = Math.max(160, Math.floor(avail)) + "px";
}

// After each render: keep the log pinned to the newest line while the user
// has not scrolled up.
export function afterRender(el) {
  if (ROOMS.active()) { ROOMS.afterRender(el); return; }
  const box = el.querySelector('[data-scroll="chat"]');
  if (!box) return;
  fit(el, box);
  if (CH.anchor) { box.scrollTop = box.scrollHeight - CH.anchor; CH.anchor = 0; }
  else if (CH.follow) box.scrollTop = box.scrollHeight;
  box.onscroll = () => { CH.follow = box.scrollHeight - box.scrollTop - box.clientHeight < 40; };
  const q = el.querySelector("#chatq");
  if (q && !q.dataset.wired) {
    q.dataset.wired = "1";
    const files = (ev) => (CH.hello && CH.hello.files ? [...(ev.clipboardData?.files ?? ev.dataTransfer?.files ?? [])] : []);
    q.addEventListener("paste", (ev) => { const f = files(ev); if (f.length) { ev.preventDefault(); attach(f); } });
    q.addEventListener("dragover", (ev) => ev.preventDefault());
    q.addEventListener("drop", (ev) => { const f = files(ev); if (f.length) { ev.preventDefault(); attach(f); } });
  }
}

// ── input ───────────────────────────────────────────────────────────────────
export function onInput(ev) {
  if (ROOMS.onInput(ev)) return true;
  const t = ev.target;
  if (t.id === "chatq") {
    const had = !!CH.draft.trim();
    CH.draft = t.value;
    if (had !== !!CH.draft.trim()) redraw(); // the send button's state
    return true;
  }
  if (t.id === "chatfile") { const picked = [...(t.files ?? [])]; t.value = ""; attach(picked); return true; }
  if (t.id === "chattq") { CH.toolQ = t.value; CH.toolOpen = ""; redraw(); return true; }
  return false;
}

// Keys pressed inside the chat's own text boxes.
export function inputKeyDown(ev) {
  if (ROOMS.inputKeyDown(ev)) return true;
  const t = ev.target;
  if (t.id === "chatq") {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); return true; }
    if (ev.key === "Escape") { ev.preventDefault(); if (!stop()) t.blur(); return true; }
    return false;
  }
  if (t.id === "chattq") {
    if (ev.key === "Escape") { ev.preventDefault(); if (t.value) { t.value = ""; onInput(ev); } else t.blur(); return true; }
    if (ev.key === "Enter") { ev.preventDefault(); t.blur(); return true; }
  }
  return false;
}

// Keys from the dispatcher (keyboard outside a text box, the key bar).
export function handleKey(key) {
  if (key === "r" || key === "R") { CH.follow = true; ROOMS.next(key === "r" ? 1 : -1); return true; }
  if (ROOMS.active() || ROOMS.picking()) return ROOMS.handleKey(key);
  const ask = pendingAsk();
  if (ask && (key === "y" || key === "n")) { confirmTool(ask.id, key === "y"); return true; }
  if (key === "n") { ROOMS.click("room-new", { dataset: {} }); return true; }
  switch (key) {
    case "Enter": case "i": case "/": { const q = document.getElementById("chatq"); if (q) q.focus(); return true; }
    case "Escape": stop(); return true;
    case "y": copyLast(); return true;
    case "x": newChat(); return true;
    case "[": ROOMS.toggleSide(); return true;
    case "j": case "ArrowDown": case "k": case "ArrowUp": case "PageDown": case "PageUp": {
      const box = document.querySelector('[data-scroll="chat"]');
      if (box) box.scrollBy(0, { j: 40, ArrowDown: 40, k: -40, ArrowUp: -40, PageDown: 400, PageUp: -400 }[key]);
      return true;
    }
    default: return false;
  }
}

export function legend(chip) {
  if (ROOMS.active() || ROOMS.picking()) return ROOMS.legend(chip);
  const ask = pendingAsk();
  if (ask) return [chip("y", "run " + ask.name, "y"), chip("n", "decline", "n")];
  return [...(CH.busy ? [chip("esc", "stop", "Escape")] : []), chip("x", "new chat", "x"), chip("r", "chats", "r"), chip("[", ROOMS.sideFolded() ? "show chats" : "hide chats", "[")];
}

export function click(act, el) {
  if (ROOMS.click(act, el)) { CH.follow = true; return true; }
  if (!act.startsWith("chat-")) return false;
  const i = Number(el.dataset.i), n = el.dataset.n;
  switch (act) {
    case "chat-send": submit(); break;
    case "chat-stop": stop(); break;
    case "chat-new": newChat(); break;
    case "chat-older": loadOlder(); break;
    case "chat-attach": document.getElementById("chatfile")?.click(); break;
    case "chat-unattach": CH.files.splice(i, 1); redraw(); break;
    case "chat-connect": connect(); break;
    case "chat-yes": confirmTool(el.dataset.id, true); break;
    case "chat-no": confirmTool(el.dataset.id, false); break;
    case "chat-tool": { const it = CH.items[i]; if (it) { it.open = !it.open; CH.follow = false; redraw(); } break; }
    case "chat-copy": { const it = CH.items[i]; if (it) copyText(it.text).then((ok) => C.flash(ok ? "copied the answer" : "clipboard unavailable")); break; }
    case "chat-copyres": { const it = CH.items[i]; if (it) copyText(pretty(it.result)).then((ok) => C.flash(ok ? "copied the " + it.name + " result" : "clipboard unavailable")); break; }
    case "chat-starter": setDraft(STARTERS[i], true); break;
    case "chat-toolinfo": CH.toolOpen = CH.toolOpen === n ? "" : n; redraw(); break;
    case "chat-usetool": setDraft((CH.draft ? CH.draft.trimEnd() + " " : "") + "Use `" + n + "` to ", true); break;
    case "chat-copyname": copyText(n).then((ok) => C.flash(ok ? "copied " + n : "clipboard unavailable")); break;
    default: return false;
  }
  return true;
}

// ── the ask line ────────────────────────────────────────────────────────────
// One conversation, two views: panel 0 above, and from every other panel this
// permanent line at the foot of the screen (#askq) with a drawer over the
// bottom third (#askbox). A question goes out with a context line (the panel
// in view and what is selected, from C.context()) that the log does not show.
// The drawer keeps to the answers: no tool calls or results, tokens, history
// budget, starters or tool list; a write tool's confirm is one line, the
// daily cap one quiet line, and a running voice session's transcript shows.
const A = { open: false, follow: true, shown: false, escAt: 0 }; // escAt: when Esc last left the line
const $id = (id) => document.getElementById(id);
const askInput = () => $id("askq");

export function initAsk() {
  const q = askInput();
  if (!q) return;
  // Focusing the line with a conversation behind it brings the drawer back.
  q.addEventListener("focus", () => { if (CH.items.length) askOpen(true); fitView(); });
  q.addEventListener("blur", fitView);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", fitView);
  initGrip();
}

// The drawer's top edge is a grip: drag it up for a taller drawer. The foot
// stays on the ask line; the height is kept between visits (a per-viewer
// convenience) and never passes the top of the screen or shrinks below a few rows.
const ASK_H_KEY = "triage.askH", ASK_H_MIN = 80, ASK_GRIP = 8;
const askHMax = () => Math.max(ASK_H_MIN, ($id("ask").getBoundingClientRect().top || window.innerHeight) - 48);
function setAskHeight(h) {
  const box = $id("askbox");
  if (!box) return;
  if (h == null) { box.style.height = box.style.maxHeight = ""; return; }
  h = Math.round(Math.min(askHMax(), Math.max(ASK_H_MIN, h)));
  box.style.height = box.style.maxHeight = h + "px";
}
function initGrip() {
  const box = $id("askbox");
  if (!box) return;
  let saved = null;
  try { saved = parseInt(localStorage.getItem(ASK_H_KEY), 10); } catch (e) { /* private mode */ }
  const apply = () => { if (saved > 0 && !box.hidden) setAskHeight(saved); };
  window.addEventListener("resize", apply);
  box.__applyHeight = apply;
  const onGrip = (ev) => ev.clientY - box.getBoundingClientRect().top <= ASK_GRIP;
  box.addEventListener("pointermove", (ev) => { if (!box.__drag) box.style.cursor = onGrip(ev) ? "ns-resize" : ""; });
  box.addEventListener("pointerdown", (ev) => {
    if (!onGrip(ev)) return;
    ev.preventDefault();
    const startY = ev.clientY, startH = box.getBoundingClientRect().height;
    box.__drag = true;
    box.setPointerCapture(ev.pointerId);
    box.style.cursor = "ns-resize"; box.style.borderTopColor = "var(--magenta)";
    const move = (e) => { setAskHeight(startH + (startY - e.clientY)); A.follow = box.scrollHeight - box.scrollTop - box.clientHeight < 40; };
    const up = () => {
      box.removeEventListener("pointermove", move); box.removeEventListener("pointerup", up); box.removeEventListener("pointercancel", up);
      box.__drag = false; box.style.cursor = ""; box.style.borderTopColor = "";
      saved = Math.round(box.getBoundingClientRect().height);
      try { localStorage.setItem(ASK_H_KEY, String(saved)); } catch (e) { /* private mode */ }
    };
    box.addEventListener("pointermove", move); box.addEventListener("pointerup", up); box.addEventListener("pointercancel", up);
  });
  // Double-click the grip: back to the default third.
  box.addEventListener("dblclick", (ev) => {
    if (!onGrip(ev)) return;
    saved = null; setAskHeight(null);
    try { localStorage.removeItem(ASK_H_KEY); } catch (e) { /* private mode */ }
  });
}

// Keep the line above a soft keyboard: the app takes the visual viewport's height while it has focus.
function fitView() {
  const app = $id("app"), vv = window.visualViewport;
  if (!app || !vv) return;
  const on = document.activeElement === askInput();
  app.style.height = on ? vv.height + "px" : "";
  if (on) window.scrollTo(0, 0);
}

// show: any panel but 0; off: no workspace yet, so the line is there but dead.
export function askSync(show, off) {
  const box = $id("ask"), q = askInput();
  if (!box || !q) return;
  A.shown = show;
  box.hidden = !show;
  q.disabled = !!off;
  q.placeholder = off ? "available once a workspace exists" : "";
  if (!show || off) { if (document.activeElement === q) q.blur(); if (off) A.open = false; }
  askRender();
}
export const askDrawerOpen = () => A.open && A.shown;
// The pending confirm the drawer is showing: the drawer is open and the tool is not a voice one (those are not listed there).
const drawerAsk = () => (askDrawerOpen() && CH.items.find((x) => x.k === "tool" && x.state === "ask" && !x.voice)) || null;
export function askOpen(on) {
  A.open = on; if (on) A.follow = true;
  askRender();
}
export function askFocus() {
  const q = askInput();
  if (!q || q.disabled || !A.shown) return false;
  q.focus();
  return true;
}

// Today's chat tokens left as five cells, like a battery; hidden with no daily cap.
function askCap() {
  const el = $id("askcap"), U = CH.usage;
  if (!el) return;
  el.hidden = !(U && U.limit > 0) && !CH.budgetOut;
  if (el.hidden) return;
  if (CH.budgetOut) { // the workspace's budget refused the last question: empty, whatever the user's own cap says
    el.title = "the workspace's token budget for today is used up";
    el.innerHTML = [0, 1, 2, 3, 4].map(() => "<span></span>").join("");
    return;
  }
  const left = Math.max(0, 1 - U.used / U.limit), on = Math.ceil(left * 5);
  const col = left <= .15 ? "var(--crit)" : left <= .4 ? "var(--warn)" : "var(--ok)";
  el.title = `chat today ${k(U.used)} / ${k(U.limit)}`;
  el.innerHTML = [0, 1, 2, 3, 4].map((i) => `<span${i < on ? ` style="background:${col}"` : ""}></span>`).join("");
}

function askRender() {
  askCap();
  const box = $id("askbox");
  if (!box) return;
  box.hidden = !(A.open && A.shown);
  if (box.hidden) { A.html = ""; return; }
  if (box.__applyHeight) box.__applyHeight();
  const U = CH.usage;
  const quiet = (t) => `<div class="chn"><span class="chwho"></span><p class="para fg-faint">${esc(t)}</p></div>`;
  const rows = CH.items.map((it, i) => {
    if (it.k === "tool") return it.state === "ask" && !it.voice ? `<div class="chn"><span class="chwho"></span>${askButtons(it, true)}</div>` : "";
    if (it.k === "err" && /limit|cap\b|budget/i.test(it.text)) return quiet(it.text);
    return itemHTML(it, i);
  });
  const capped = U && U.limit > 0 && U.used >= U.limit && !CH.items.some((x) => x.k === "err" && /limit|cap\b|budget/i.test(x.text));
  if (capped) rows.push(quiet("today's chat limit is reached"));
  const last = CH.items[CH.items.length - 1];
  if (CH.busy && !(last && last.k === "bot" && !last.done)) rows.push(quiet("…"));
  if (drawerAsk()) A.follow = true; // the confirm sits at the foot, so keep it in view
  const html = rows.join(""), top = box.scrollTop;
  if (html !== A.html) { A.html = html; box.innerHTML = html; box.scrollTop = top; }
  if (A.follow) box.scrollTop = box.scrollHeight;
  box.onscroll = () => { A.follow = box.scrollHeight - box.scrollTop - box.clientHeight < 40; };
}

function askSubmit() {
  const q = askInput(), text = q ? q.value.trim() : "";
  if (!text) return;
  if (CH.busy && !VOICE.active()) { C.flash("tria is still answering"); return; }
  const ctx = C.context ? C.context() : "";
  if (post(text, ctx ? ctx + "\n" + text : text, true)) { q.value = ""; askOpen(true); }
}

// Keys pressed inside the ask line.
export function askKeyDown(ev) {
  const t = ev.target;
  if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); askSubmit(); return true; }
  if (ev.key === "Escape") { ev.preventDefault(); A.open = false; A.escAt = Date.now(); askRender(); t.blur(); return true; }
  const ask = drawerAsk();
  if (ask && !t.value && (ev.key === "y" || ev.key === "n")) { ev.preventDefault(); confirmTool(ask.id, ev.key === "y"); return true; }
  return false;
}

// A second Esc soon after the one that left the line clears what was typed in it.
export function askEscape() {
  const q = askInput();
  if (!q || !q.value || Date.now() - A.escAt > 600) return false;
  q.value = ""; A.escAt = 0;
  return true;
}

// y and n answer a write tool's confirm in the open drawer when the line is not being typed in.
export function askConfirmKey(key) {
  const ask = drawerAsk();
  if (!ask || (key !== "y" && key !== "n")) return false;
  confirmTool(ask.id, key === "y");
  return true;
}
