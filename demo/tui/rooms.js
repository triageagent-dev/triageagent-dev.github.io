// Panel 0's conversations (core ADR-092): the private chat with Tria (chat.js)
// first, then one conversation per readable workspace and the direct chats
// with people who share a workspace. The state, the live stream and the
// message rules are mobile's (mobile/state/messenger.js, mobile/model/chat.js),
// so both clients behave alike; this file only draws them as a terminal and
// maps keys.
//
// A message's ⋯ (or j/k) picks it and shows its actions: a reply, e edit, + react,
// > forward, p pin, c copy, x delete, o open its image or file, T ask Tria
// about it (a reply that mentions @tria), t resend a failed one. / searches, u attaches, n starts a direct chat, r / R step
// through the conversations. In the box: enter sends, shift+enter a new line,
// tab completes an @mention, up on an empty box edits your last message,
// a pasted or dropped image is sent.
//
// Direct chats are end-to-end encrypted (core ADR-093). An encrypted chat
// shows what it still needs on a line under its title: V verifies this
// device (from another of yours) or the other person, A accepts their
// changed identity, S starts over with a new identity (y confirms). An
// emoji verification shows in panel 0, from either side: y accepts or says
// the emoji match, n declines or says they differ.
import { esc, sub } from "./ui.js";
import { readByOthers, useMessenger } from "../mobile/state/messenger.js";
import { useE2EE } from "../mobile/state/e2ee.js";
import { e2ee } from "../mobile/state/e2ee-app.js";
import { charsNote, clock, dayLabel, fileSize, groupReactions, layout, mentionAt, MAX_TEXT, REACTION_STYLE, snippet } from "../mobile/model/chat.js";

const M = () => useMessenger.getState();

/** The green dot of a workspace's spot: up, or down in red. Nothing when the workspace has none. */
const spotDot = (a) => !a ? "" : ` <i class="ph-fill ph-circle ${a.state === "up" ? "fg-ok" : "fg-crit"}" style="font-size:8px;vertical-align:middle" title="${esc(a.name)} is ${a.state === "up" ? "up" : "down"}"></i>`;

// The reaction words, their keys in the picker and their colours here.
const REACT_KEYS = { o: "ok", n: "noted", w: "working on it", f: "fixed", b: "blocked" };
const REACT_FG = { "ok": "fg-accent", "noted": "fg-info", "working on it": "fg-warn", "fixed": "fg-ok", "blocked": "fg-crit" };

const T = {
  cur: "",          // the open conversation ("" = the private chat with Tria)
  draft: "", replyTo: null, editing: null,
  sel: "",          // the selected message
  mode: "",         // "" | react | forward | delete | people | search | startover
  pick: 0,          // the highlighted row in forward / people / mention lists
  people: null, search: null, mention: null,
  follow: true, keep: null,
};

let C = null; // { flash, redraw, md }
export function initRooms(ctx) {
  C = ctx;
  useMessenger.subscribe(() => C.redraw());
  useE2EE.subscribe((s, prev) => {
    if (s.verification?.phase === "incoming" && prev.verification?.phase !== "incoming") C.flash("emoji verification asked · open tria (0)");
    C.redraw();
  });
}

const V = () => useE2EE.getState().verification;
export const active = () => !!T.cur;
/** The new-chat picker or a verification is open (over the private chat too). */
export const picking = () => T.mode === "people" || !!V();
export const pickerHTML = () => (V() ? verifyHTML() : T.mode === "people" ? modeHTML() : "");
const conv = () => M().convs[T.cur];
const meta = () => M().rooms.find((r) => r.id === T.cur);
const msgs = () => conv()?.msgs ?? [];
const byId = (id) => msgs().find((m) => m.id === id);
const selected = () => byId(T.sel);
const isDM = () => meta()?.kind === "dm";

/** Load the list and open the live stream once; the panel calls this on sight. */
export function ensure() {
  M().start();
}

export function open(id) {
  if (T.cur) M().close(T.cur);
  T.cur = id || "";
  T.sel = ""; T.mode = ""; T.replyTo = null; T.editing = null; T.search = null; T.mention = null; T.follow = true;
  if (T.cur) M().open(T.cur);
  C.redraw();
}

/** Step through private chat → conversations → private chat. */
export function next(step) {
  const ids = ["", ...M().rooms.map((r) => r.id)];
  const i = Math.max(0, ids.indexOf(T.cur));
  open(ids[(i + step + ids.length) % ids.length]);
}

// ── actions ────────────────────────────────────────────────────────────────
const fail = (e) => C.flash(e.message || String(e));

async function submit() {
  const text = T.draft.trim();
  if (!text || !T.cur) return;
  const room = T.cur;
  if (T.editing) {
    const m = T.editing;
    T.editing = null; setDraft("");
    if (text !== m.body) M().edit(room, m.id, text).catch(fail);
    return;
  }
  const rt = T.replyTo?.id;
  T.replyTo = null; T.mention = null; T.follow = true;
  setDraft("");
  await M().send(room, text, rt);
}

function setDraft(v) {
  T.draft = v;
  const q = document.getElementById("roomq");
  if (q && q.value !== v) q.value = v;
  C.redraw();
}

function attach(files) {
  const room = T.cur, rt = T.replyTo?.id;
  T.replyTo = null; T.follow = true;
  for (const f of files) M().attach(room, f, { replyTo: rt }).catch(fail);
}

function moveSel(step) {
  const list = msgs().filter((m) => m.type !== "deleted" || m.mine);
  if (!list.length) return;
  let i = list.findIndex((m) => m.id === T.sel);
  i = i < 0 ? list.length - 1 : Math.max(0, Math.min(list.length - 1, i + step));
  if (i === 0 && step < 0) loadOlder();
  T.sel = list[i].id;
  T.follow = i === list.length - 1;
  C.redraw();
  requestAnimationFrame(() => document.querySelector(`[data-mid="${CSS.escape(T.sel)}"]`)?.scrollIntoView({ block: "nearest" }));
}

function loadOlder() {
  const c = conv();
  if (!c || c.done || c.loading) return;
  const box = document.querySelector('[data-scroll="room"]');
  T.keep = box ? box.scrollHeight - box.scrollTop : null;
  void M().older(T.cur);
}

function jump(id) {
  if (!document.querySelector(`[data-mid="${CSS.escape(id)}"]`)) { C.flash("that message is further back than what is loaded"); return; }
  T.sel = id; T.follow = false; T.mode = ""; T.search = null;
  C.redraw();
  requestAnimationFrame(() => document.querySelector(`[data-mid="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" }));
}

async function copy(m) {
  try { await navigator.clipboard.writeText(m.body); C.flash("copied"); } catch (e) { C.flash("clipboard unavailable"); }
}

function openMedia(m) {
  if (!m?.media?.url) return;
  window.open(m.type === "image" ? m.media.url : m.media.url + "?download=1", "_blank", "noopener");
}

async function startPeople() {
  T.mode = "people"; T.pick = 0; T.people = null; C.redraw();
  try { T.people = (await M().people()).people ?? []; } catch (e) { T.people = []; fail(e); }
  C.redraw();
}

async function runSearch(q) {
  T.search = { q, results: null };
  C.redraw();
  try { T.search = { q, results: (await M().search(T.cur, q)).messages ?? [] }; } catch (e) { T.search = { q, results: [] }; fail(e); }
  C.redraw();
}

function focus() {
  C.redraw();
  requestAnimationFrame(() => { const q = document.getElementById("roomq"); if (q) { q.focus(); const n = q.value.length; q.setSelectionRange(n, n); } });
}

function act(key) {
  const m = selected();
  const c = conv();
  switch (key) {
    case "a": if (m && !m.local && m.type !== "deleted") { T.replyTo = m; T.editing = null; focus(); } return true;
    case "e": if (m && m.mine && m.type === "text" && !m.local) { T.editing = m; T.replyTo = null; setDraft(m.body); focus(); } return true;
    case "+": if (m && !m.local && m.type !== "deleted") { T.mode = "react"; C.redraw(); } return true;
    case ">": if (m && !m.local && m.type !== "deleted" && m.type !== "encrypted") { T.mode = "forward"; T.pick = 0; C.redraw(); } return true;
    case "p": if (m && !m.local && c?.canWrite) M().pin(T.cur, m.id, !c.pinned.includes(m.id)).catch(fail); return true;
    case "c": if (m?.body) void copy(m); return true;
    case "x":
      if (m?.local) { M().discard(T.cur, m.id); T.sel = ""; C.redraw(); }
      else if (m && (m.mine || c?.canWrite) && m.type !== "deleted") { T.mode = "delete"; C.redraw(); }
      return true;
    case "o": openMedia(m); return true;
    case "T": if (m && !m.local && !isDM() && m.type !== "deleted" && m.type !== "encrypted") { T.sel = ""; T.follow = true; M().askTria(T.cur, m).catch(fail); C.redraw(); } return true;
    case "t": if (m?.failed) void M().deliver(T.cur, m.id); return true;
    case "u": document.getElementById("roomfile")?.click(); return true;
    case "/": T.mode = "search"; T.search = null; C.redraw(); requestAnimationFrame(() => document.getElementById("roomsearch")?.focus()); return true;
    case "n": void startPeople(); return true;
    case "V": {
      const e = useE2EE.getState();
      if (!enc() || e.status !== "ready") return true;
      (e.trusted === false ? e2ee.verifySelf() : M().verifyPeer(T.cur)).catch(fail);
      return true;
    }
    case "E": if (isDM() && !enc() && meta()?.peer) M().directChat(meta().peer).then((r) => open(r.id)).catch(fail); return true;
    case "A": if (enc() && trust() === "changed") M().acceptIdentity(T.cur).catch(fail); return true;
    case "S": if (enc() && useE2EE.getState().trusted === false) { T.mode = "startover"; C.redraw(); } return true;
  }
  return false;
}

// ── encryption ─────────────────────────────────────────────────────────────
const enc = () => !!(meta()?.encrypted || conv()?.encrypted);
const trust = () => M().trust[T.cur];
const peerName = () => meta()?.name ?? "them";

/** What an encrypted chat still needs here, with its keys; "" when nothing. */
function e2eeLine() {
  if (isDM() && !enc()) {
    return `<div class="rmpin"><i class="ph ph-lock fg-dim"></i><span class="c flex fg-dim">${meta()?.earlier ? "an earlier chat, from before chats were encrypted · <b>E</b> open the encrypted chat" : "not end-to-end encrypted · <b>E</b> start an encrypted chat (this one stays as an earlier chat)"}</span></div>`;
  }
  if (!enc()) return "";
  const e = useE2EE.getState(), t = trust(), n = esc(peerName());
  const line = (cls, icon, text) => `<div class="rmpin"><i class="ph ph-${icon} ${cls}"></i><span class="c flex">${text}</span></div>`;
  if (e.status === "failed") return line("fg-crit", "lock", `encryption could not start on this device: ${esc(e.error)}`);
  if (e.status !== "ready") return line("fg-accent", "lock", "setting up encryption on this device…");
  if (e.trusted === false) return line("fg-warn", "lock", `this device is not verified · <b>V</b> verify it from another of your devices · <b>S</b> start over`);
  if (t === "none") return line("fg-warn", "lock", `${n} has not opened the messenger since chats became encrypted; you can write once they do`);
  if (t === "changed") return line("fg-crit", "warning", `${n}'s encryption identity changed · check with them, then <b>A</b> accept it`);
  if (t === "unverified") return line("fg-accent", "lock", `compare emoji with ${n} once · <b>V</b> verify`);
  return "";
}
const blocked = () => {
  if (!enc()) return false;
  const e = useE2EE.getState(), t = trust();
  return e.status !== "ready" || e.trusted === false || t === "none" || t === "changed";
};

/** The emoji verification, whichever side asked. */
function verifyHTML() {
  const v = V();
  if (!v) return "";
  const who = v.self ? (v.incoming ? "your other device" : "this device") : esc(M().rooms.find((r) => r.peer === v.peer)?.name ?? v.peer);
  const head = `<span class="fg-accent"><i class="ph ph-shield-check"></i> verify ${who}</span>`;
  let body;
  switch (v.phase) {
    case "incoming": body = `<span>${v.self ? "your other device asks to be verified" : who + " asks to verify your chat"}; you compare emoji on both screens · <b>y</b> compare · <b>n</b> decline</span>`; break;
    case "requested": body = `<span class="fg-dim">waiting for ${who} to answer… · esc cancels</span>`; break;
    case "waiting": body = `<span class="fg-dim">getting the emoji ready… · esc cancels</span>`; break;
    case "emoji":
      body = `<div class="rmemoji">${(v.emoji ?? []).map((e) => `<span><b>${esc(e.symbol)}</b><span class="fg-faint">${esc(e.description)}</span></span>`).join("")}</div>`
        + (v.confirmed ? `<span class="fg-dim">waiting for the other side to confirm…</span>` : `<span>same emoji, same order, on both screens? · <b>y</b> they match · <b>n</b> they differ</span>`);
      break;
    case "done": body = `<span class="fg-ok">${v.self ? (v.incoming ? "your other device is verified" : "this device is verified") : who + " is verified"} · enter</span>`; break;
    default: body = `<span class="fg-warn">the verification stopped${v.reason ? ": " + esc(v.reason) : ""} · enter</span>`;
  }
  return `<div class="rmmode col">${head}${body}</div>`;
}

function verifyKey(key) {
  const v = V();
  const run = (p) => { Promise.resolve(p).catch(fail); };
  if (v.phase === "done" || v.phase === "cancelled") {
    if (key === "Enter" || key === "Escape") { e2ee.dismiss(); for (const r of M().rooms) if (r.encrypted) void M().checkTrust(r.id); }
    return true;
  }
  if (v.phase === "incoming") {
    if (key === "y") run(e2ee.accept());
    else if (key === "n" || key === "Escape") run(e2ee.cancel());
    return true;
  }
  if (v.phase === "emoji" && !v.confirmed) {
    if (key === "y") run(e2ee.confirm());
    else if (key === "n") run(e2ee.cancel(true));
    else if (key === "Escape") run(e2ee.cancel());
    return true;
  }
  if (key === "Escape") run(e2ee.cancel());
  return true;
}

// ── keys ───────────────────────────────────────────────────────────────────
const forwardTargets = () => M().rooms.filter((r) => r.id !== T.cur);

/** Keys from the dispatcher while a conversation is open (not typing). */
export function handleKey(key) {
  if (V()) return verifyKey(key);
  if (T.mode === "startover") {
    T.mode = "";
    if (key === "y") e2ee.startOver().catch(fail);
    C.redraw();
    return true;
  }
  if (T.mode === "react") {
    const word = REACT_KEYS[key];
    if (word) { const m = selected(); T.mode = ""; if (m) M().react(T.cur, m.id, word).catch(fail); C.redraw(); return true; }
    if (key === "Escape") { T.mode = ""; C.redraw(); }
    return true;
  }
  if (T.mode === "delete") {
    if (key === "y") { const m = selected(); T.mode = ""; T.sel = ""; if (m) M().remove(T.cur, m.id).catch(fail); C.redraw(); return true; }
    T.mode = ""; C.redraw(); return true;
  }
  if (T.mode === "forward" || T.mode === "people") {
    const list = T.mode === "forward" ? forwardTargets() : (T.people ?? []);
    if (key === "j" || key === "ArrowDown") { T.pick = Math.min(list.length - 1, T.pick + 1); C.redraw(); return true; }
    if (key === "k" || key === "ArrowUp") { T.pick = Math.max(0, T.pick - 1); C.redraw(); return true; }
    if (key === "Enter") { choose(list[T.pick]); return true; }
    if (key === "Escape") { T.mode = ""; C.redraw(); }
    return true;
  }
  if (T.mode === "search" && key === "Escape") { T.mode = ""; T.search = null; C.redraw(); return true; }
  switch (key) {
    case "j": case "ArrowDown": moveSel(1); return true;
    case "k": case "ArrowUp": moveSel(-1); return true;
    case "G": T.sel = ""; T.follow = true; C.redraw(); return true;
    case "[": toggleSide(); return true;
    case "PageDown": case "PageUp": {
      const box = document.querySelector('[data-scroll="room"]');
      if (box) box.scrollBy(0, key === "PageDown" ? 400 : -400);
      return true;
    }
    case "Enter": case "i": focus(); return true;
    case "Escape":
      if (T.sel || T.replyTo || T.editing) {
        if (T.editing) setDraft("");
        T.sel = ""; T.replyTo = null; T.editing = null; T.follow = true; C.redraw();
      }
      return true;
  }
  return act(key);
}

function choose(target) {
  if (!target) return;
  const mode = T.mode;
  T.mode = "";
  if (mode === "forward") {
    const m = selected();
    if (m) M().forward(T.cur, m.id, target.id).then(() => C.flash("forwarded to " + target.name)).catch(fail);
  } else {
    M().directChat(target.id).then((r) => open(r.id)).catch(fail);
  }
  C.redraw();
}

const mentionNames = () => {
  const names = Object.values(conv()?.members ?? {}).filter((n) => n && n !== "Tria");
  return [...new Set([...(isDM() ? [] : ["Tria"]), ...names])];
};
const mentionList = () => (T.mention ? mentionNames().filter((n) => n.toLowerCase().startsWith(T.mention.query)).slice(0, 6) : []);

function complete(name) {
  const q = document.getElementById("roomq");
  const caret = q ? q.selectionStart : T.draft.length;
  const word = name === "Tria" ? "tria" : name.replace(/\s+/g, "");
  const head = T.draft.slice(0, T.mention.start) + "@" + word + " ";
  T.mention = null;
  setDraft(head + T.draft.slice(caret));
  requestAnimationFrame(() => { const t = document.getElementById("roomq"); if (t) { t.focus(); t.setSelectionRange(head.length, head.length); } });
}

/** Keys inside the conversation's own boxes. */
export function inputKeyDown(ev) {
  const t = ev.target;
  if (t.id === "roomsearch") {
    if (ev.key === "Enter") { ev.preventDefault(); const q = t.value.trim(); if (q) void runSearch(q); return true; }
    if (ev.key === "Escape") { ev.preventDefault(); T.mode = ""; T.search = null; t.blur(); C.redraw(); return true; }
    return false;
  }
  if (t.id !== "roomq") return false;
  const ml = mentionList();
  if (ml.length && (ev.key === "Tab" || (ev.key === "Enter" && !ev.shiftKey))) {
    ev.preventDefault(); complete(ml[Math.min(T.pick, ml.length - 1)]); return true;
  }
  if (ml.length && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
    ev.preventDefault(); T.pick = Math.max(0, Math.min(ml.length - 1, T.pick + (ev.key === "ArrowDown" ? 1 : -1))); C.redraw(); return true;
  }
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); void submit(); return true; }
  if (ev.key === "ArrowUp" && !t.value) {
    const last = [...msgs()].reverse().find((m) => m.mine && m.type === "text" && !m.local);
    if (last) { ev.preventDefault(); T.sel = last.id; act("e"); return true; }
  }
  if (ev.key === "Escape") {
    ev.preventDefault();
    if (T.editing) setDraft("");
    T.editing = null; T.replyTo = null; T.mention = null;
    M().typingOff(T.cur);
    t.blur(); C.redraw();
    return true;
  }
  return false;
}

// The characters left in the message box, shown once 500 remain (the box stops at MAX_TEXT).
function countHTML(draft) {
  const n = charsNote(draft.length);
  const cls = n ? { crit: "fg-crit", warn: "fg-warn", faint: "fg-faint" }[n.level] : "";
  return `<span id="roomcount" class="rmcount ${cls}">${n ? esc(n.text) : ""}</span>`;
}

/** Input events from the conversation's boxes; false when not ours. */
export function onInput(ev) {
  const t = ev.target;
  if (t.id === "roomfile") { const files = [...(t.files ?? [])]; t.value = ""; attach(files); return true; }
  if (t.id === "roomsearch") return true;
  if (t.id !== "roomq") return false;
  const had = !!T.draft.trim();
  T.draft = t.value;
  const cnt = document.getElementById("roomcount");
  if (cnt) cnt.outerHTML = countHTML(T.draft);
  if (T.draft.trim()) M().typingOn(T.cur);
  const before = T.mention;
  T.mention = mentionAt(t.value, t.selectionStart ?? t.value.length);
  if (T.mention && !before) T.pick = 0;
  if (had !== !!T.draft.trim() || before || T.mention) C.redraw();
  return true;
}

export function click(name, el) {
  if (!name.startsWith("room-")) return false;
  const id = el.dataset.id;
  switch (name) {
    case "room-open": open(id || ""); break;
    case "room-side": toggleSide(); break;
    case "room-dots": T.sel = T.sel === id ? "" : id; T.mode = ""; C.redraw(); break;
    case "room-act": T.sel = id || T.sel; act(el.dataset.k); break;
    case "room-react": M().react(T.cur, id, el.dataset.k).catch(fail); break;
    case "room-word": { const m = selected(); T.mode = ""; if (m) M().react(T.cur, m.id, el.dataset.k).catch(fail); C.redraw(); break; }
    case "room-jump": jump(id); break;
    case "room-img": openMedia(byId(id)); break;
    case "room-send": void submit(); break;
    case "room-attach": document.getElementById("roomfile")?.click(); break;
    case "room-cancel": if (T.editing) setDraft(""); T.editing = null; T.replyTo = null; C.redraw(); break;
    case "room-del": { const m = selected(); T.mode = ""; T.sel = ""; if (m) M().remove(T.cur, m.id).catch(fail); C.redraw(); break; }
    case "room-pick": choose((T.mode === "forward" ? forwardTargets() : T.people ?? [])[Number(el.dataset.i)]); break;
    case "room-new": void startPeople(); break;
    case "room-mention": complete(el.dataset.k); break;
    case "room-older": loadOlder(); break;
    case "room-close": T.mode = ""; T.search = null; C.redraw(); break;
    default: return false;
  }
  return true;
}

export function legend(chip) {
  const v = V();
  if (v) {
    if (v.phase === "incoming") return [chip("y", "compare emoji", "y"), chip("n", "decline", "n")];
    if (v.phase === "emoji" && !v.confirmed) return [chip("y", "they match", "y"), chip("n", "they differ", "n"), chip("esc", "cancel", "Escape")];
    if (v.phase === "done" || v.phase === "cancelled") return [chip("enter", "close", "Enter")];
    return [chip("esc", "cancel", "Escape")];
  }
  if (T.mode === "startover") return [chip("y", "start over", "y"), chip("esc", "keep", "Escape")];
  if (T.mode === "react") return Object.entries(REACT_KEYS).map(([k, w]) => chip(k, w, k));
  if (T.mode === "delete") return [chip("y", "delete for everyone", "y"), chip("esc", "keep", "Escape")];
  if (T.mode === "forward" || T.mode === "people") return [chip("j/k", "pick", "j"), chip("enter", T.mode === "forward" ? "forward" : "open", "Enter"), chip("esc", "cancel", "Escape")];
  const m = selected();
  if (m) {
    const c = conv();
    if (m.local) return [...(m.failed ? [chip("t", "resend", "t")] : []), chip("x", "discard", "x")];
    const out = [chip("a", "reply", "a"), chip("+", "react", "+")];
    if (m.mine && m.type === "text") out.push(chip("e", "edit", "e"));
    if (m.type !== "encrypted") out.push(chip(">", "forward", ">"));
    out.push(chip("c", "copy", "c"));
    if (c?.canWrite) out.push(chip("p", c.pinned.includes(m.id) ? "unpin" : "pin", "p"));
    if (m.media) out.push(chip("o", "open", "o"));
    if (!isDM() && m.type !== "encrypted") out.push(chip("T", "ask tria", "T"));
    if (m.mine || c?.canWrite) out.push(chip("x", "delete", "x"));
    out.push(chip("esc", "done", "Escape"));
    return out;
  }
  const out = [chip("j/k", "pick", "k"), chip("/", "search", "/"), chip("u", "attach", "u"), chip("n", "new chat", "n"), chip("r", "next chat", "r"), chip("[", folded ? "show chats" : "hide chats", "[")];
  if (isDM() && !enc()) out.push(chip("E", "encrypted chat", "E"));
  if (enc() && useE2EE.getState().status === "ready") {
    const e = useE2EE.getState(), t = trust();
    if (e.trusted === false) out.push(chip("V", "verify this device", "V"), chip("S", "start over", "S"));
    else if (t === "changed") out.push(chip("A", "accept identity", "A"));
    else if (t === "unverified") out.push(chip("V", "verify " + peerName(), "V"));
  }
  return out;
}

// ── drawing ────────────────────────────────────────────────────────────────
function tick(m, read) {
  if (!m.mine) return "";
  if (m.failed) return ` <span class="fg-crit" title="${esc(m.error || "not sent")}">! not sent (t resends)</span>`;
  if (m.pending) return ` <span class="fg-faint">…</span>`;
  return read ? ` <span class="fg-accent">✓✓</span>` : ` <span class="fg-faint">✓</span>`;
}

function reactionsHTML(m, groups) {
  if (!groups.length) return "";
  return `<div class="rmreacts">${groups.map((g) => {
    const icon = (REACTION_STYLE[g.key] ?? {}).icon || "tag";
    return `<button type="button" class="rmreact${g.mine ? " mine" : ""}" data-act="room-react" data-id="${esc(m.id)}" data-k="${esc(g.key)}" title="${esc(g.key + ": " + g.names.join(", "))}"><i class="ph-fill ph-${esc(icon)} ${REACT_FG[g.key] || ""}"></i>${g.count > 1 ? g.count : ""}</button>`;
  }).join("")}</div>`;
}

function bodyHTML(m) {
  if (m.type === "deleted") return `<p class="para fg-faint">message deleted</p>`;
  if (m.type === "encrypted") return `<p class="para fg-faint"><i class="ph ph-lock"></i> waiting for this message's key</p>`;
  const warn = m.warn ? `<p class="para fg-crit"><i class="ph ph-warning"></i> from a device that is not verified</p>` : "";
  return bodyOf(m) + warn;
}

function bodyOf(m) {
  const caption = m.media && m.body && m.body !== m.media.name ? `<p class="para">${esc(m.body)}</p>` : "";
  if (m.type === "image" && m.media && !m.media.url) return `<p class="para fg-faint"><i class="ph ph-lock"></i> decrypting ${esc(m.media.name || "photo")}…</p>${caption}`;
  if (m.type === "image" && m.media) {
    return `<img class="rmimg" src="${esc(m.media.thumb || m.media.url)}" alt="${esc(m.media.name || "")}" data-act="room-img" data-id="${esc(m.id)}" loading="lazy">${caption}`;
  }
  if (m.type === "file" && m.media) {
    const href = m.media.url + (m.media.url.startsWith("/") ? "?download=1" : "");
    return `<p class="para"><a class="rmfile" href="${esc(href)}" download="${esc(m.media.name)}"><i class="ph ph-file"></i> ${esc(m.media.name)}</a> <span class="fg-faint">${esc(fileSize(m.media.size))}</span></p>${caption}`;
  }
  return m.tria ? C.md(m.body) : `<p class="para${m.mine ? " fg-strong" : ""}">${esc(m.body)}</p>`;
}

function actionsHTML(m, c) {
  const b = (k, label, icon) => `<button type="button" class="btn" data-act="room-act" data-id="${esc(m.id)}" data-k="${esc(k)}"><i class="ph ph-${icon}"></i>${label}</button>`;
  if (m.local) return `<div class="btnrow rmacts">${m.failed ? b("t", "resend", "arrow-clockwise") : ""}${b("x", "discard", "trash")}</div>`;
  if (m.type === "deleted") return "";
  let out = b("a", "reply", "arrow-bend-up-left") + b("+", "react", "thumbs-up");
  if (m.mine && m.type === "text") out += b("e", "edit", "pen");
  if (m.type !== "encrypted") out += b(">", "forward", "share");
  out += b("c", "copy", "copy");
  if (c?.canWrite) out += b("p", c.pinned.includes(m.id) ? "unpin" : "pin", "push-pin");
  if (m.media) out += b("o", "open", "download-simple");
  if (!isDM() && m.type !== "encrypted") out += b("T", "ask tria", "chat-circle-dots");
  if (m.mine || c?.canWrite) out += b("x", "delete", "trash");
  return `<div class="btnrow rmacts">${out}</div>`;
}

// Characters the sender column (.chwho, 4.6em) holds on one line.
const WHO_FIT = 7;

function messageHTML(row, c, reactions, byID, index) {
  const m = row.m;
  const who = m.mine ? "you" : m.tria ? "tria" : m.name;
  const whoCls = m.mine ? "fg-mag" : m.tria ? "fg-accent" : "fg-info";
  const issue = m.tria && m.kind && m.kind.startsWith("issue");
  const sevCls = { critical: "fg-crit", warning: "fg-warn" }[m.severity] || "fg-dim";
  const quote = m.replyTo ? byID.get(m.replyTo) : null;
  const read = m.mine && readByOthers(c, index.get(m.id));
  // A click on the text selects text; the ⋯ beside the time opens the actions.
  let html = `<div class="rm ${m.mine ? "chu" : "chb"}${T.sel === m.id ? " sel" : ""}" data-mid="${esc(m.id)}">`;
  // A name that does not fit the narrow column takes a line of its own above the row, from the left edge of "you".
  const longName = row.first && who.length > WHO_FIT;
  if (longName) html += `<span class="rmwho ${whoCls}">${esc(who)}</span>`;
  html += `<span class="chwho ${whoCls}">${row.first && !longName ? esc(who) : ""}</span><div class="chtext">`;
  if (issue) html += `<span class="${sevCls}">${esc(m.kind.replace("_", " "))}</span>`;
  if (m.forwarded) html += `<span class="fg-dim">⇢ forwarded from ${esc(m.forwarded)}</span>`;
  if (m.replyTo) {
    html += `<span class="rmq" data-act="room-jump" data-id="${esc(m.replyTo)}">↪ ${quote ? `<span class="fg-label">${esc(quote.mine ? "you" : quote.name)}</span> ${esc(snippet(quote).slice(0, 120))}` : "an earlier message"}</span>`;
  }
  html += bodyHTML(m);
  const dots = m.type === "deleted" && !m.local ? "" : `<button type="button" class="rmdots" data-act="room-dots" data-id="${esc(m.id)}" title="actions" aria-label="actions">⋯</button>`;
  html += `<span class="rmmeta">${esc(clock(m.ts))}${m.edited && m.type !== "deleted" ? " · edited" : ""}${tick(m, read)}${dots}</span>`;
  html += reactionsHTML(m, groupReactions(reactions[m.id], M().reactionList));
  if (T.sel === m.id && !T.mode) html += actionsHTML(m, c);
  return html + `</div></div>`;
}

function modeHTML() {
  if (T.mode === "react") {
    return `<div class="rmmode"><span class="fg-dim">react</span>${Object.entries(REACT_KEYS).map(([k, w]) =>
      `<button type="button" class="btn" data-act="room-word" data-k="${esc(w)}"><i class="ph-fill ph-${esc(REACTION_STYLE[w].icon)} ${REACT_FG[w]}"></i>${esc(k)} · ${esc(w)}</button>`).join("")}</div>`;
  }
  if (T.mode === "startover") {
    return `<div class="rmmode col"><span class="fg-warn">start over with a new identity? your other devices and the people you chat with will be asked to verify you again, and this device cannot read older encrypted messages</span><span><b>y</b> start over · esc keep</span></div>`;
  }
  if (T.mode === "delete") {
    return `<div class="rmmode"><span class="fg-warn">delete this message for everyone?</span><button type="button" class="btn primary" data-act="room-del">y — delete</button><button type="button" class="btn" data-act="room-close">keep</button></div>`;
  }
  if (T.mode === "forward" || T.mode === "people") {
    const list = T.mode === "forward" ? forwardTargets() : T.people;
    const title = T.mode === "forward" ? "forward to" : "new chat with someone who shares a workspace with you";
    if (list === null) return `<div class="rmmode col"><span class="fg-dim">${title}</span><span class="fg-faint">loading…</span></div>`;
    if (!list.length) return `<div class="rmmode col"><span class="fg-dim">${title}</span><span class="fg-faint">${T.mode === "forward" ? "no other conversation" : "nobody else has opened the messenger in your workspaces yet"}</span></div>`;
    return `<div class="rmmode col"><span class="fg-dim">${title}</span>${list.map((r, i) =>
      `<div class="tr${i === T.pick ? " sel" : ""}" data-act="room-pick" data-i="${i}"><span class="c flex">${esc(r.name)}</span>${r.kind === "dm" ? `<span class="fg-faint">direct</span>` : ""}</div>`).join("")}</div>`;
  }
  if (T.mode === "search") {
    let html = `<div class="rmmode col"><label class="dsearch"><i class="ph ph-magnifying-glass"></i><input id="roomsearch" type="text" autocomplete="off" spellcheck="false" placeholder="search this chat · enter" value="${esc(T.search?.q ?? "")}"></label>`;
    if (T.search && T.search.results === null) html += `<span class="fg-faint">searching…</span>`;
    else if (T.search) {
      html += T.search.results.length ? T.search.results.map((m) =>
        `<div class="tr" data-act="room-jump" data-id="${esc(m.id)}"><span class="fg-dim">${esc((m.mine ? "you" : m.name) + " · " + dayLabel(m.ts) + " " + clock(m.ts))}</span><span class="c flex">${esc(snippet(m).slice(0, 160))}</span></div>`).join("")
        : `<span class="fg-faint">nothing found for ${esc(T.search.q)}</span>`;
    }
    return html + `</div>`;
  }
  return "";
}

/** The open conversation as panel 0's main column and side. */
export function panelHTML() {
  const c = conv();
  const r = meta();
  const all = msgs();
  const reactions = M().reactions;
  const byID = new Map(all.map((m) => [m.id, m]));
  const index = new Map(all.map((m, i) => [m.id, i]));
  const typing = (M().typing[T.cur] ?? []).filter(Boolean);
  // Who is typing shows just above the message box, not in the title bar.
  const typingLine = `<div class="rmtyping"><span class="rmtypewho">${typing.length ? `<span class="fg-violet">${esc(typing.join(", "))} typing…</span>` : ""}</span>${countHTML(T.draft)}</div>`;
  const status = M().status === "live" ? `<span class="fg-ok">live</span>` : `<span class="fg-faint">connecting…</span>`;
  const lock = enc() ? (trust() === "verified" ? ` <i class="ph ph-shield-check fg-ok" title="end-to-end encrypted, verified"></i>` : ` <i class="ph ph-lock fg-dim" title="end-to-end encrypted"></i>`) : "";
  const title = `<span class="t">${r?.kind === "dm" ? "chat" : "workspace"} [<span class="fg-label">${esc(r?.name ?? "")}</span>]${spotDot(r?.spot)}${lock}</span>`;
  const pinned = c?.pinned?.[0] ? byID.get(c.pinned[0]) : null;
  let log = "";
  if (c?.loading) log += `<div class="fg-faint">loading…</div>`;
  else if (c && !c.done && all.length) log += `<button type="button" class="chcopy" data-act="room-older">older messages</button>`;
  else if (c?.done && all.length) log += `<div class="fg-faint">start of the conversation</div>`;
  if (c?.err && !c.loading) log += `<div class="fg-crit">couldn't load the conversation: ${esc(c.err)} · <button type="button" class="chcopy" data-act="room-older">retry</button></div>`;
  if (c && !c.loading && !c.err && !all.length) {
    log += `<div class="empty">${r?.kind === "dm" ? "No messages yet. Only the two of you can read this chat." : "No messages yet. Write to the workspace; @tria asks Tria, who answers here for everyone."}</div>`;
  }
  if (c) {
    for (const row of layout(all)) {
      log += row.day ? `<div class="rmday fg-faint">— ${esc(dayLabel(row.day))} —</div>` : messageHTML(row, c, reactions, byID, index);
    }
  }
  const ml = mentionList();
  const ref = T.editing ?? T.replyTo;
  const banner = ref
    ? `<div class="rmbanner"><i class="ph ph-${T.editing ? "pen" : "arrow-bend-up-left"} fg-accent"></i><span class="fg-accent">${T.editing ? "editing" : "reply to " + esc(T.replyTo.mine ? "yourself" : T.replyTo.name)}</span><span class="c flex fg-dim">${esc(snippet(ref).slice(0, 140))}</span><button type="button" class="chcopy" data-act="room-cancel">cancel</button></div>`
    : "";
  const mentions = ml.length
    ? `<div class="rmmention">${ml.map((n, i) => `<div class="tr${i === Math.min(T.pick, ml.length - 1) ? " sel" : ""}" data-act="room-mention" data-k="${esc(n)}"><span class="c flex">@${esc(n)}</span>${n === "Tria" ? `<span class="fg-faint">answers here for everyone</span>` : ""}</div>`).join("")}</div>`
    : "";
  const hint = blocked() ? "encrypted chat: not ready on this device (see above)"
    : T.editing ? "edit your message · enter saves · esc cancels"
    : `message ${esc(r?.name ?? "")}…  enter sends · shift+enter newline${r?.kind === "dm" ? "" : " · @tria asks Tria"} · ↑ edits your last`;
  return `<div class="grid chatgrid rooms${folded ? " fold" : ""}">
    <div class="col chatmain">
      <div class="tbar">${title}<span class="fill"></span><span class="hint">${status}</span>${sideButton()}</div>
      ${e2eeLine()}
      ${pinned ? `<div class="rmpin" data-act="room-jump" data-id="${esc(pinned.id)}"><i class="ph ph-push-pin fg-accent"></i><span class="fg-accent">pinned</span><span class="c flex">${esc(snippet(pinned).slice(0, 160))}</span></div>` : ""}
      <div class="chatlog" data-scroll="room">${log}</div>
      ${V() ? verifyHTML() : modeHTML()}
      ${mentions}${banner}
      ${typingLine}
      <div class="chatin">
        <textarea id="roomq" rows="3" spellcheck="false" maxlength="${MAX_TEXT}" placeholder="${hint}"${blocked() ? " disabled" : ""}>${esc(T.draft)}</textarea>
        <div class="chatbtns">
          <button type="button" class="btn primary" data-act="room-send"${T.draft.trim() ? "" : " disabled"}><i class="ph ph-${T.editing ? "check" : "paper-plane-right"}"></i>${T.editing ? "save" : "send"}</button>
          ${T.editing || blocked() ? "" : `<button type="button" class="btn" data-act="room-attach" title="attach a photo or file (u), up to 2 MB; photos are shrunk to fit"><i class="ph ph-paperclip"></i>attach</button>`}
        </div>
        <input id="roomfile" type="file" multiple hidden>
      </div>
    </div>
    <div class="col chatside" data-scroll="chatside">
      ${sideHTML()}
    </div>
  </div>`;
}

// Size the log so the box ends at the bottom of the terminal (as chat.js
// does for the private chat).
function fit(el, box) {
  const term = document.getElementById("term"), main = el.querySelector(".chatmain"), side = el.querySelector(".chatside");
  if (!term || !main || window.matchMedia("(max-width: 899px)").matches) return;
  const pad = parseFloat(getComputedStyle(term).paddingBottom) || 0;
  const avail = term.getBoundingClientRect().bottom - pad - main.getBoundingClientRect().top;
  const rest = main.offsetHeight - box.offsetHeight;
  box.style.height = Math.max(160, Math.floor(avail - rest)) + "px";
  if (side) side.style.maxHeight = Math.max(160, Math.floor(avail)) + "px";
}

/** After each render: size, keep the newest in view (or the reader's place
 *  when older messages arrived above), load older at the top, take pasted
 *  and dropped images. */
export function afterRender(el) {
  const box = el.querySelector('[data-scroll="room"]');
  if (!box) return;
  fit(el, box);
  if (T.keep != null && !conv()?.loading) { box.scrollTop = box.scrollHeight - T.keep; T.keep = null; }
  else if (T.follow) box.scrollTop = box.scrollHeight;
  box.onscroll = () => {
    T.follow = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (box.scrollTop < 60) loadOlder();
  };
  const q = el.querySelector("#roomq");
  if (q && !q.dataset.wired) {
    q.dataset.wired = "1";
    q.addEventListener("paste", (ev) => {
      const files = [...(ev.clipboardData?.files ?? [])];
      if (files.length) { ev.preventDefault(); attach(files); }
    });
    q.addEventListener("dragover", (ev) => ev.preventDefault());
    q.addEventListener("drop", (ev) => {
      const files = [...(ev.dataTransfer?.files ?? [])];
      if (files.length) { ev.preventDefault(); attach(files); }
    });
  }
}

// The chats column folds away, for more room to the conversation: key [ or
// the title bar's button. Kept between visits (a per-viewer convenience).
const SIDE_KEY = "triage.chatSide";
let folded = false;
try { folded = localStorage.getItem(SIDE_KEY) === "fold"; } catch (e) { /* private mode */ }
export const sideFolded = () => folded;
export function toggleSide() {
  folded = !folded;
  try { if (folded) localStorage.setItem(SIDE_KEY, "fold"); else localStorage.removeItem(SIDE_KEY); } catch (e) { /* private mode */ }
  C.redraw();
}
// The title bar's button: the column's state and how to flip it.
export const sideButton = () => `<button type="button" class="close" data-act="room-side" title="${folded ? "show" : "hide"} the chats list ([)">${folded ? "&#9666; chats" : "chats &#9656;"}</button>`;

/** The side list: the private chat, the workspaces and the direct chats. */
export function sideHTML() {
  const s = M();
  let html = sub("chats", ' data-sec="1"');
  const row = (id, name, extra, kind, spot) => `<div class="tr${T.cur === id ? " sel" : ""}" data-act="room-open" data-id="${esc(id)}"><span class="c flex">${kind === "dm" ? `<i class="ph ph-user fg-faint"></i> ` : ""}${esc(name)}${spotDot(spot)}</span>${extra}</div>`;
  html += row("", "tria · private", "");
  if (s.err) return html + `<span class="fg-crit">${esc(s.err)}</span>`;
  if (!s.loaded) return html + `<span class="fg-faint">loading…</span>`;
  html += s.rooms.map((r) => row(r.id, r.earlier ? r.name + " · earlier" : r.name, r.unread ? `<span class="fg-accent">${r.unread}</span>` : r.last ? `<span class="fg-faint">${esc(clock(r.last.ts))}</span>` : "", r.kind, r.spot)).join("");
  html += `<div class="tr" data-act="room-new"><span class="c flex fg-dim"><i class="ph ph-plus"></i> new chat (n)</span></div>`;
  return html;
}
