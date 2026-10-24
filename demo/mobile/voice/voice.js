/**
 * Voice agent over the core's live voice session (GET /v2/agent/voice/session,
 * a WebSocket; same-origin, so the SSO cookie authenticates the upgrade).
 * Wire protocol, as the desktop UI speaks it (ui/hooks/use-voice-session.ts):
 *
 *   up:   {"audio": <base64 Int16 PCM, 16 kHz mono>} · {"text": "..."} · {"audioStreamEnd": true}
 *   down: {"audio": <base64 Int16 PCM, 24 kHz>} · {"transcript"} · {"inputTranscript"}
 *         · {"toolCall": name} · {"toolResult"} · {"interrupt": true} · {"done": true} · {"error"}
 *
 * Hands-free: holding the centre tab button starts a session and the mic
 * stays open, so it is a conversation, not push-to-talk — the core's model
 * takes turns (and cuts itself off when you talk over it). A tap on the same
 * button ends it, as do the card's X, a tenant switch or sign-out (the main
 * store's subscription), the app going to the background or the screen
 * locking, IDLE_MS without the core hearing you speak, and MAX_MS in all.
 *
 * In the Android app (lib/native.js, the WebView message bridge on this
 * origin only) the session runs natively in a foreground service, so it goes
 * on with the screen off, and the page only mirrors it: it posts
 * {type: "voice.start", tenant, into} / {type: "voice.stop"} / {type: "hello"} and
 * takes back {state: {conn, agent, live, error}} and the core's transcript
 * frames (never the audio). The native side owns the idle and total timers.
 */
import { create } from "../lib/store.js"
import { BASE_PATH } from "../lib/ui-version.js"
import { call as callApp, inApp, onMessage as onAppMessage, send as toApp } from "../lib/native.js"
import { voiceEvent as chatLog } from "../api/chat.js"

// A session started from a workspace's shared chat speaks into that chat: the
// core posts its turns to the room, so they stay out of the Tria chat's log.
let intoRoom = false
const log = (e) => { if (!intoRoom) chatLog(e) }

// VoiceConn: "idle" | "connecting" | "open" | "error"
// VoiceAgent: "idle" | "listening" | "thinking" | "speaking"
// VoiceMsg: { id, role: "user" | "agent" | "tool", text }
//
// State: open, conn, agent, live (a session is live and the mic is
// streaming), msgs, error.
// prime(): create/resume the audio contexts. Call from inside the pointer-down
//   gesture: iOS only lets an AudioContext start there, and the long-press
//   that calls press() fires from a timer.
// start(tenant, into): start the session (the long-press on the centre button);
//   into "room" speaks into the workspace chat that is open.
// close(): close the session and the card.

const IDLE_MS = 120_000
const MAX_MS = 15 * 60_000
const IN_RATE = 16_000
const OUT_RATE = 24_000

let ws = null
let micCtx = null
let playCtx = null
let stream = null
let node = null
let source = null
let playing = []
let nextStart = 0
let msgId = 0
let idleTimer = null
let maxTimer = null
let sessionTenant = null

const native = inApp
const toNative = toApp

function b64FromPCM(f32) {
  const i16 = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32767))
  const bytes = new Uint8Array(i16.buffer)
  let bin = ""
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function pcmFromB64(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const i16 = new Int16Array(bytes.buffer, 0, bytes.length >> 1)
  const f32 = new Float32Array(i16.length)
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768
  return f32
}

function stopPlayback() {
  playing.forEach(s => { try { s.stop() } catch { /* already stopped */ } })
  playing = []
  nextStart = 0
}

function teardown() {
  if (idleTimer) clearTimeout(idleTimer)
  if (maxTimer) clearTimeout(maxTimer)
  idleTimer = maxTimer = null
  node?.disconnect(); node = null
  source?.disconnect(); source = null
  stream?.getTracks().forEach(t => t.stop()); stream = null
  stopPlayback()
  void micCtx?.close(); micCtx = null
  void playCtx?.close(); playCtx = null
  if (ws) {
    const w = ws
    ws = null
    try {
      if (w.readyState === WebSocket.OPEN) w.send(JSON.stringify({ audioStreamEnd: true }))
      w.close(1000, "user closed")
    } catch { /* socket already gone */ }
  }
  sessionTenant = null
}

export const useVoice = create((set, get) => {
  // Only the user's own speech (the core's inputTranscript) or a fresh start
  // resets this: an agent answering overheard audio must not keep the mic
  // open forever.
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => get().close(), IDLE_MS)
  }

  // The core sends a turn's transcript in fragments: they join the line
  // until the other side speaks, here and in the Tria chat's log.
  const append = (role, text, merge) => {
    log({ t: role === "user" ? "you" : role === "agent" ? "bot" : "tool", text })
    set(s => {
      const last = s.msgs[s.msgs.length - 1]
      if (merge && last && last.role === role) return { msgs: [...s.msgs.slice(0, -1), { ...last, text: last.text + text }] }
      return { msgs: [...s.msgs, { id: msgId++, role, text }].slice(-40) }
    })
  }

  // The Android app's side of the session: its state, and the frames that carry text.
  const onNative = (m) => {
    if (m.state) {
      const st = m.state
      if (st.live) set({ open: true, live: true, conn: st.conn, agent: st.agent, error: st.error || "" })
      else { set({ open: !!st.error, live: false, conn: st.error ? "error" : "idle", agent: "idle", msgs: st.error ? get().msgs : [], error: st.error || "" }); log({ t: "end" }) }
      return
    }
    if (typeof m.error === "string") set({ error: m.error })
    if (typeof m.toolCall === "string") append("tool", m.toolCall, false)
    if (typeof m.inputTranscript === "string") append("user", m.inputTranscript, true)
    if (typeof m.transcript === "string") append("agent", m.transcript, true)
  }

  const onMessage = (ev) => {
    let m
    try { m = JSON.parse(String(ev.data)) } catch { return }
    if (m.done) { get().close(); return }
    if (typeof m.error === "string") { set({ error: m.error }); return }
    if (m.interrupt) { stopPlayback(); set({ agent: "listening" }) }
    if (typeof m.toolCall === "string") { set({ agent: "thinking" }); append("tool", m.toolCall, false) }
    if (typeof m.inputTranscript === "string") { touch(); append("user", m.inputTranscript, true) }
    if (typeof m.transcript === "string") { set({ agent: "speaking" }); append("agent", m.transcript, true) }
    if (typeof m.audio === "string" && playCtx) {
      set({ agent: "speaking" })
      const f32 = pcmFromB64(m.audio)
      const buf = playCtx.createBuffer(1, f32.length, OUT_RATE)
      buf.getChannelData(0).set(f32)
      const src = playCtx.createBufferSource()
      src.buffer = buf
      src.connect(playCtx.destination)
      const at = Math.max(nextStart, playCtx.currentTime)
      src.start(at)
      nextStart = at + buf.duration
      playing.push(src)
      src.onended = () => {
        playing = playing.filter(p => p !== src)
        if (!playing.length) set(s => ({ agent: s.agent === "speaking" ? "listening" : s.agent }))
      }
    }
  }

  if (native) {
    onAppMessage(onNative)
    toNative({ type: "hello" }) // a page loaded while a session runs picks it up
  }

  const connect = async (tenant, into) => {
    set({ conn: "connecting", error: "" })
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // No sampleRate constraint: asking for a non-native rate turns off the
        // browser's echo cancellation. The 16 kHz context resamples instead.
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
      if (!micCtx) throw new Error("audio unavailable")
      await micCtx.audioWorklet.addModule(BASE_PATH + "/pcm-capture.js")
      const params = new URLSearchParams(tenant ? { tenant } : {})
      if (into) params.set("into", into)
      const q = params.toString() ? "?" + params : ""
      const proto = location.protocol === "https:" ? "wss" : "ws"
      const sock = new WebSocket(`${proto}://${location.host}/v2/agent/voice/session${q}`)
      ws = sock
      await new Promise((resolve, reject) => {
        sock.onopen = () => resolve()
        sock.onerror = () => reject(new Error("voice session refused — is voice enabled for this tenant?"))
        sock.onclose = () => reject(new Error("voice session closed before it opened"))
      })
      sock.onmessage = onMessage
      sock.onclose = () => { if (ws === sock) { teardown(); set({ open: false, conn: "idle", agent: "idle", live: false }); log({ t: "end" }) } }
      source = micCtx.createMediaStreamSource(stream)
      node = new AudioWorkletNode(micCtx, "pcm-capture")
      node.port.onmessage = (e) => {
        if (!get().live || ws?.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({ audio: b64FromPCM(e.data) }))
      }
      source.connect(node)
      sessionTenant = tenant
      set({ conn: "open", agent: "listening" })
      touch()
    } catch (e) {
      teardown()
      const msg = e instanceof DOMException && e.name === "NotAllowedError"
        ? "Microphone permission was denied."
        : e instanceof Error ? e.message : String(e)
      set({ conn: "error", agent: "idle", live: false, error: msg })
    }
  }

  return {
    open: false,
    conn: "idle",
    agent: "idle",
    live: false,
    msgs: [],
    error: "",
    prime() {
      if (native) return
      try {
        micCtx ??= new AudioContext({ sampleRate: IN_RATE })
        playCtx ??= new AudioContext({ sampleRate: OUT_RATE })
        void micCtx.resume(); void playCtx.resume()
      } catch { /* no Web Audio: connect() reports it */ }
    },
    /**
     * Text typed into the open session, resolving true when it went in. The app owns its
     * session's socket and takes the text over its bridge; an app build without that
     * message never answers, so it resolves false and the text goes to the chat instead.
     */
    async sendText(text) {
      if (native) {
        if (get().conn !== "open") return false
        try { return (await callApp("voice.text", { text }, 1500)).ok === true } catch { return false }
      }
      if (!ws || ws.readyState !== WebSocket.OPEN || get().conn !== "open") return false
      ws.send(JSON.stringify({ text }))
      touch()
      return true
    },
    start(tenant, into) {
      intoRoom = into === "room"
      log({ t: "start" })
      if (native) {
        set({ open: true, live: true, conn: "connecting", agent: "listening", error: "" })
        toNative({ type: "voice.start", tenant: tenant || "", into: into || "" })
        return
      }
      get().prime()
      if (ws && sessionTenant !== tenant) { teardown(); set({ conn: "idle", msgs: [] }) }
      set({ open: true, live: true, agent: "listening", error: "" })
      if (!ws && get().conn !== "connecting") {
        if (maxTimer) clearTimeout(maxTimer)
        maxTimer = setTimeout(() => get().close(), MAX_MS)
        void connect(tenant, into)
      }
      touch()
    },
    close() {
      log({ t: "end" })
      if (native) {
        toNative({ type: "voice.stop" })
        set({ open: false, conn: "idle", agent: "idle", live: false, msgs: [], error: "" })
        return
      }
      teardown()
      set({ open: false, conn: "idle", agent: "idle", live: false, msgs: [], error: "" })
    },
  }
})

// A hidden page (app switched away, screen locked, tab closed) ends the
// session: nobody can see the card or tap the triage icon, so the mic must not stay open.
if (typeof document !== "undefined") {
  const end = () => { if (!native && useVoice.getState().open) useVoice.getState().close() }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") end() })
  window.addEventListener("pagehide", end)
}
