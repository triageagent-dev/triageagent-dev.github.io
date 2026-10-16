// Panel 0: chat with the core's agent over GET /v2/agent/chat (a WebSocket;
// same-origin, so the session cookie authenticates the upgrade). The core
// runs the model (fixed, named in its hello), the voice tool set, the
// tenant binding and the per-user daily chat cap (core ADR-066).
//
//   up:   {"text", "history"?} · {"confirm": {"id", "ok"}} · {"stop": true}
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
import { esc, panelTitle, sub, copyText } from "./ui.js";
import * as VOICE from "./voice.js";

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
  resume: false,      // the next message carries the transcript to a new socket
  toolQ: "", toolOpen: "",
  voiceQuota: null,   // { used, limit } pushed by a running voice session
  follow: true,
};

let C = null; // { S, redraw, flash }
export function initChat(ctx) {
  C = ctx;
}

let drawQueued = false;
function redraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; C.redraw(); });
}

// ── socket ──────────────────────────────────────────────────────────────────
const tenantNow = () => (C.S.D && C.S.D.tenant) || "";

function connect() {
  if (CH.ws) return;
  CH.conn = "connecting"; CH.tenant = tenantNow();
  const q = CH.tenant ? "?" + new URLSearchParams({ tenant: CH.tenant }) : "";
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
      if (i >= 0 && CH.items[i].text === p.text) CH.items.splice(i, 1);
      if (!CH.draft) CH.draft = p.text;
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

function onMessage(m) {
  if (m.hello) {
    CH.hello = m.hello; CH.conn = "open";
    if (m.hello.usage) { CH.usage = m.hello.usage; CH.voiceQuota = null; }
    if (CH.pending) { const p = CH.pending; CH.pending = null; send(p); }
  }
  if (m.delta) {
    const last = CH.items[CH.items.length - 1];
    if (last && last.k === "bot" && !last.done && !last.voice) last.text += m.delta;
    else CH.items.push({ k: "bot", text: m.delta });
  }
  if (m.tool) onTool(m.tool);
  if (m.note) CH.items.push({ k: "note", text: m.note });
  if (m.usage) { CH.usage = m.usage; CH.voiceQuota = null; }
  if (m.error) CH.items.push({ k: "err", text: m.error });
  if (m.done) {
    CH.busy = false;
    CH.items.forEach((it) => { if (it.k === "bot") it.done = true; });
  }
  redraw();
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
  if (!text) return;
  if (VOICE.active()) {
    if (!VOICE.sendText(text)) { C.flash("voice is connecting — try again in a moment"); return; }
    endVoiceText();
    CH.items.push({ k: "user", voice: true, done: true, text });
    CH.draft = ""; CH.follow = true;
    redraw();
    return;
  }
  if (CH.busy) return;
  if (CH.tenant && CH.tenant !== tenantNow() && CH.items.length) {
    if (CH.ws) { const old = CH.ws; CH.ws = null; old.close(); }
    CH.resume = false;
    CH.items.push({ k: "sys", text: "tenant changed — new conversation" });
  }
  const msg = { text };
  if (CH.resume) { msg.history = transcript(); CH.resume = false; }
  CH.items.push({ k: "user", text });
  CH.draft = ""; CH.busy = true; CH.follow = true;
  if (!send(msg)) { CH.pending = msg; connect(); }
  redraw();
}

// The questions and answers so far, without tool calls, for a new socket.
function transcript() {
  return CH.items.filter((x) => (x.k === "user" || x.k === "bot") && x.text && !x.voice).map((x) => ({ role: x.k === "user" ? "user" : "model", text: x.text }));
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
  CH.items = []; CH.conn = "idle"; CH.usage = null; CH.hello = null; CH.resume = false;
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
const k = (n) => (n == null ? "–" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n));

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
const argLine = (a) => {
  const s = Object.entries(a || {}).map(([x, v]) => x + "=" + (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
  return s.length > 90 ? s.slice(0, 89) + "…" : s;
};
const STATE = { ask: ["fg-warn", "asks"], run: ["fg-violet", "running…"], ok: ["fg-ok", "ok"], error: ["fg-crit", "error"], denied: ["fg-faint", "declined"], stopped: ["fg-faint", "stopped"] };

function itemHTML(it, i) {
  if (it.k === "user") return `<div class="chu"><span class="chwho fg-mag">you</span><div class="chtext"><p class="para fg-strong">${esc(it.text)}</p></div></div>`;
  if (it.k === "bot") return `<div class="chb"><span class="chwho fg-accent">tria</span><div class="chtext">${md(it.text)}${it.done ? `<button type="button" class="chcopy" data-act="chat-copy" data-i="${i}">copy</button>` : ""}</div></div>`;
  if (it.k === "note") return `<div class="chn"><span class="chwho fg-info">report</span><p class="para fg-dim">${esc(it.text)}</p></div>`;
  if (it.k === "err") return `<div class="chn"><span class="chwho fg-crit">error</span><p class="para fg-crit">${esc(it.text)}</p></div>`;
  if (it.k === "sys") return `<div class="chn"><span class="chwho"></span><p class="para fg-faint">${esc(it.text)}</p></div>`;
  const [cls, word] = STATE[it.state] || ["fg-dim", it.state];
  let html = `<div class="cht"><div class="chtl" data-act="chat-tool" data-i="${i}"><span class="fg-faint">${it.open ? "▾" : "▸"}</span><span class="fg-label">${esc(it.name)}</span><span class="cha fg-dim">${esc(argLine(it.args))}</span><span class="${cls}">${word}${it.ms != null && it.state !== "ask" ? " " + it.ms + "ms" : ""}</span></div>`;
  if (it.state === "ask") html += `<div class="btnrow chask"><span class="fg-warn">run ${esc(it.name)}?</span><button type="button" class="btn primary" data-act="chat-yes" data-id="${esc(it.id)}">y — run</button><button type="button" class="btn" data-act="chat-no" data-id="${esc(it.id)}">n — decline</button></div>`;
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
  if (H) html += row("scope", H.bound ? esc(H.tenant) : `<span class="fg-dim">all your tenants</span>`);
  if (U) {
    html += row("this chat", `in ${k(U.sessionInput)} · out ${k(U.sessionOutput)}`);
    if (U.input || U.output) html += row("last call", `in ${k(U.input)} · out ${k(U.output)} · think ${k(U.thoughts)}${U.cached ? " · cached " + k(U.cached) : ""}`);
    html += meter("history", U.context, U.contextLimit, k(U.context) + " / " + k(U.contextLimit));
    html += U.limit > 0 ? meter("chat today", U.used, U.limit, k(U.used) + " / " + k(U.limit)) : row("chat today", `<span class="fg-dim">no daily cap</span>`);
  }
  // Voice's own cap: live from a running voice session, else as of the chat's last push.
  const V = CH.voiceQuota || (U && U.voiceLimit != null ? { used: U.voiceUsed, limit: U.voiceLimit } : null);
  if (V) html += V.limit > 0 ? meter("voice today", V.used, V.limit, k(V.used) + " / " + k(V.limit)) : row("voice today", `${k(V.used)} <span class="fg-dim">· no daily cap</span>`);
  if (H) html += row("limits", `<span class="fg-dim">${k(H.maxOutputTokens)} out per call · ${H.toolsPerAnswer} tools per answer · older turns drop past ${k(H.contextTokens)}</span>`);
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
  // Connect on sight so the model, the caps and today's spend show before the first question.
  if (CH.conn === "idle" && !CH.ws) connect();
  const status = CH.conn === "open" ? (CH.busy ? `<span class="fg-violet">answering… esc stops</span>` : `<span class="fg-ok">connected</span>`)
    : CH.conn === "connecting" ? `<span class="fg-violet">connecting…</span>`
    : CH.conn === "closed" ? `<span class="fg-faint">disconnected</span>` : `<span class="fg-faint">not connected</span>`;
  const log = CH.items.length ? CH.items.map(itemHTML).join("")
    : `<div class="empty">Ask about issues, services, events or memory. Tria calls the core's tools and shows each call; it asks before any change. Enter sends, shift+enter adds a line.</div>`;
  const ask = pendingAsk();
  return `<div class="grid chatgrid">
    <div class="col chatmain">
      <div class="tbar">${panelTitle("tria", tenantNow())}<span class="fill"></span><span class="hint">${status}</span></div>
      <div class="chatlog" data-scroll="chat">${log}</div>
      <div class="chatin">
        <textarea id="chatq" rows="3" spellcheck="false" placeholder="${ask ? "answer the confirm above (y / n), or type on" : VOICE.active() ? "type to the voice session…  enter sends · esc leaves" : "ask tria…  enter sends · shift+enter newline · esc leaves"}">${esc(CH.draft)}</textarea>
        <div class="chatbtns">
          ${CH.busy ? `<button type="button" class="btn" data-act="chat-stop"><i class="ph ph-stop"></i>stop</button>` : `<button type="button" class="btn primary" data-act="chat-send"${CH.draft.trim() ? "" : " disabled"}><i class="ph ph-play"></i>send</button>`}
          <button type="button" class="btn" data-act="chat-new" title="new conversation (x)"><i class="ph ph-plus"></i>new</button>
        </div>
      </div>
    </div>
    <div class="col chatside" data-scroll="chatside">
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
  const box = el.querySelector('[data-scroll="chat"]');
  if (!box) return;
  fit(el, box);
  if (CH.follow) box.scrollTop = box.scrollHeight;
  box.onscroll = () => { CH.follow = box.scrollHeight - box.scrollTop - box.clientHeight < 40; };
}

// ── input ───────────────────────────────────────────────────────────────────
export function onInput(ev) {
  const t = ev.target;
  if (t.id === "chatq") {
    const had = !!CH.draft.trim();
    CH.draft = t.value;
    if (had !== !!CH.draft.trim()) redraw(); // the send button's state
    return true;
  }
  if (t.id === "chattq") { CH.toolQ = t.value; CH.toolOpen = ""; redraw(); return true; }
  return false;
}

// Keys pressed inside the chat's own text boxes.
export function inputKeyDown(ev) {
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
  const ask = pendingAsk();
  if (ask && (key === "y" || key === "n")) { confirmTool(ask.id, key === "y"); return true; }
  switch (key) {
    case "Enter": case "i": case "/": { const q = document.getElementById("chatq"); if (q) q.focus(); return true; }
    case "Escape": stop(); return true;
    case "y": copyLast(); return true;
    case "x": newChat(); return true;
    case "j": case "ArrowDown": case "k": case "ArrowUp": case "PageDown": case "PageUp": {
      const box = document.querySelector('[data-scroll="chat"]');
      if (box) box.scrollBy(0, { j: 40, ArrowDown: 40, k: -40, ArrowUp: -40, PageDown: 400, PageUp: -400 }[key]);
      return true;
    }
    default: return false;
  }
}

export function legend(chip) {
  const ask = pendingAsk();
  if (ask) return [chip("y", "run " + ask.name, "y"), chip("n", "decline", "n")];
  return [...(CH.busy ? [chip("esc", "stop", "Escape")] : []), chip("x", "new chat", "x")];
}

export function click(act, el) {
  if (!act.startsWith("chat-")) return false;
  const i = Number(el.dataset.i), n = el.dataset.n;
  switch (act) {
    case "chat-send": submit(); break;
    case "chat-stop": stop(); break;
    case "chat-new": newChat(); break;
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
