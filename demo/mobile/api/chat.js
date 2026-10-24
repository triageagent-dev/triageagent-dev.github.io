/**
 * The private chat with Tria (core ADR-066), as the TUI's panel 0 has it:
 * one WebSocket to /v2/agent/chat on this origin (the session cookie
 * authenticates the upgrade). The core runs the model, the tools, the tenant
 * binding and the daily chat cap; the transcript lives here, so a new socket
 * (after a disconnect or a core restart) carries the earlier turns as
 * "history" and the conversation goes on.
 *
 *   up:   {text, history?, files?} · {confirm: {id, ok}} · {stop: true}
 *   down: {hello} · {past} · {delta} · {tool} · {note} · {usage} · {done} · {error}
 *
 * The core keeps the conversation per workspace (core ADR-096): the first
 * socket of a workspace is followed by a past frame with the newest stored
 * turns, and GET /v2/messenger/tria/history pages back through older ones.
 *
 * The state is a small store the screen subscribes to; it outlives the
 * screen, so leaving and coming back keeps the conversation.
 */
import { shown, wire } from "./chatfiles.js"

const S = {
  items: [],      // {k: "user"|"bot"|"tool"|"note"|"err"|"sys", text?, id?, name?, args?, state?, done?}
  busy: false, conn: "idle", tenant: "",
  hello: null, usage: null,
  older: "",      // token for the page before the oldest stored turn shown
  loadingOlder: false,
}
// pastFor is the workspace whose stored turns this page has asked for,
// pastOpen that the next past frame is its first, fresh that the next socket
// starts without the stored turns.
let ws = null, pending = null, resume = false, pastFor = null, pastOpen = false, fresh = false
const subs = new Set()
const emit = () => subs.forEach(f => f({ ...S, items: S.items.slice() }))

export function subscribe(fn) {
  subs.add(fn)
  fn({ ...S, items: S.items.slice() })
  return () => subs.delete(fn)
}

function connect(tenant) {
  if (ws) return
  S.conn = "connecting"; S.tenant = tenant || ""
  const params = new URLSearchParams(S.tenant ? { tenant: S.tenant } : {})
  if (fresh) { params.set("fresh", "1"); fresh = false }
  const q = params.toString() ? "?" + params : ""
  const proto = location.protocol === "https:" ? "wss" : "ws"
  const sock = new WebSocket(`${proto}://${location.host}/v2/agent/chat${q}`)
  ws = sock
  let opened = false, refused = false
  sock.onopen = () => { opened = true }
  sock.onmessage = (ev) => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    if (m.refused) refused = true
    onFrame(m)
  }
  sock.onclose = () => {
    if (ws !== sock) return
    ws = null; S.conn = "closed"; S.busy = false
    S.items.forEach(it => { if (it.k === "tool" && (it.state === "ask" || it.state === "run")) it.state = "stopped" })
    if (opened && !refused && S.items.some(x => x.k === "user")) resume = true
    if ((!opened || refused) && pending) {
      if (pending.history) resume = true
      pending = null
    }
    if (!refused) S.items.push(opened
      ? { k: "sys", text: "Disconnected. The next message reconnects and carries this conversation over." }
      : { k: "err", text: "Could not reach Tria. Send again; if it keeps failing, the core may be restarting, voice is off for this workspace, or today's chat limit is spent." })
    emit()
  }
  emit()
}

function onFrame(m) {
  if (m.hello) {
    S.hello = m.hello; S.conn = "open"
    pastOpen = pastFor !== S.tenant; pastFor = S.tenant
    if (m.hello.usage) S.usage = m.hello.usage
    if (pending) { const p = pending; pending = null; ws.send(JSON.stringify(p)) }
  }
  if (m.past && pastOpen) {
    pastOpen = false
    S.items.unshift(...pastItems(m.past.turns))
    S.older = m.past.next || ""
  }
  if (m.delta) {
    const last = S.items[S.items.length - 1]
    if (last && last.k === "bot" && !last.done && !last.voice) last.text += m.delta
    else S.items.push({ k: "bot", text: m.delta })
  }
  if (m.tool) {
    // A tool call ends the text before it: the next delta starts a new answer.
    S.items.forEach(it => { if (it.k === "bot") it.done = true })
    const t = m.tool
    let it = S.items.find(x => x.k === "tool" && x.id === t.id)
    if (!it) { it = { k: "tool", id: t.id, name: t.name, args: t.args || {} }; S.items.push(it) }
    it.state = t.state
    if (t.args) it.args = t.args
  }
  if (m.note) S.items.push({ k: "note", text: m.note })
  if (m.usage) S.usage = m.usage
  if (m.error) S.items.push({ k: "err", text: m.error })
  if (m.done) {
    S.busy = false
    S.items.forEach(it => { if (it.k === "bot") it.done = true })
  }
  emit()
}

// A voice session's transcript joins the log, as in the TUI (core ADR-096):
// the pieces arrive in fragments and join the open "you" or "Tria" line until
// the other side speaks. The text chat's model does not see these lines while
// they are live; the core keeps both modes in one stored conversation.
let voiceOn = false, voiceTool = 0
const openVoice = (k) => { const last = S.items[S.items.length - 1]; return last && last.k === k && last.voice && !last.done ? last : null }
const endVoiceText = () => S.items.forEach(it => { if (it.voice && (it.k === "user" || it.k === "bot")) it.done = true })

/** One event of a voice session: start, you / bot (fragments), tool, typed (text sent into it), end. */
export function voiceEvent(e) {
  if (e.t === "start") {
    if (voiceOn) return
    voiceOn = true
    S.items.push({ k: "sys", text: "Voice session. The conversation shows here." })
  } else if (e.t === "you" || e.t === "bot") {
    const k = e.t === "you" ? "user" : "bot"
    const it = openVoice(k)
    if (it) it.text += e.text
    else if (e.text.trim()) { endVoiceText(); S.items.push({ k, voice: true, text: e.text.trimStart() }) }
  } else if (e.t === "tool") {
    endVoiceText()
    S.items.push({ k: "tool", voice: true, id: "voice-" + ++voiceTool, name: e.text, args: {}, state: "ok" })
  } else if (e.t === "typed") {
    endVoiceText()
    S.items.push({ k: "user", voice: true, done: true, text: e.text })
  } else if (e.t === "end") {
    if (!voiceOn) return
    voiceOn = false
    endVoiceText()
    S.items.push({ k: "sys", text: "Voice session ended." })
  } else return
  emit()
}

const pastItems = (turns = []) => turns.map(t => t.role === "user"
  ? { k: "user", text: t.text, files: t.files }
  : { k: "bot", text: t.text, done: true })

/** One page of older stored turns, above the ones shown. */
export async function loadOlder() {
  if (!S.older || S.loadingOlder) return
  S.loadingOlder = true; emit()
  try {
    const q = new URLSearchParams({ before: S.older })
    if (S.tenant) q.set("tenant", S.tenant)
    const res = await fetch("/v2/messenger/tria/history?" + q, { credentials: "same-origin", headers: { Accept: "application/json" } })
    if (!res.ok) throw new Error("HTTP " + res.status)
    const page = await res.json()
    S.items.unshift(...pastItems(page.turns))
    S.older = page.next || ""
  } catch (e) {
    S.items.push({ k: "err", text: "Could not load older messages: " + e.message })
  }
  S.loadingOlder = false; emit()
}

const transcript = () => S.items
  .filter(x => (x.k === "user" || x.k === "bot") && x.text && !x.voice)
  .map(x => ({ role: x.k === "user" ? "user" : "model", text: x.text }))

/** Ask Tria, with files from chatfiles.prepare; false while an answer is still running. */
export function ask(text, tenant, files = []) {
  if (S.busy || (!text.trim() && !files.length)) return false
  if (S.tenant !== (tenant || "") && S.items.length) {
    if (ws) { const old = ws; ws = null; old.close() }
    resume = false
    // The new workspace has its own stored conversation, shown when it connects.
    S.items = []; S.older = ""; pastFor = null
  }
  const msg = { text }
  if (files.length) msg.files = wire(files)
  if (resume) { msg.history = transcript(); resume = false }
  S.items.push(files.length ? { k: "user", text, files: shown(files) } : { k: "user", text })
  S.busy = true
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  else { pending = msg; connect(tenant) }
  emit()
  return true
}

/** Answer a write tool's confirm. */
export function confirm(id, ok) {
  const it = S.items.find(x => x.k === "tool" && x.id === id)
  if (!it || it.state !== "ask" || !ws) return
  ws.send(JSON.stringify({ confirm: { id, ok } }))
  it.state = ok ? "run" : "denied"
  emit()
}

export function stop() {
  if (S.busy && ws) ws.send(JSON.stringify({ stop: true }))
}

/** A new conversation (the core keeps the last one as a session note and the stored chat stays). */
export function reset() {
  if (S.busy) return false
  if (ws) { const old = ws; ws = null; old.close() }
  S.items = []; S.conn = "idle"; S.hello = null; S.usage = null; resume = false
  fresh = true; S.older = ""
  emit()
  return true
}

/** Open the socket on sight, so the caps show before the first question. */
export function warm(tenant) {
  if (S.conn === "idle" && !ws) connect(tenant)
}
