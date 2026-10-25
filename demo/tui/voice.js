// Voice agent for the TUI tab bar — a port of the mobile client
// (mobile/voice/voice.js) over the core's live voice session
// (GET /v2/agent/voice/session, a WebSocket; same-origin, so the SSO cookie
// authenticates the upgrade).
//
//   up:   {"audio": <base64 Int16 PCM, 16 kHz mono>} · {"text"} · {"audioStreamEnd": true}
//   down: {"audio": <base64 Int16 PCM, 24 kHz>} · {"transcript"} · {"inputTranscript"}
//         · {"toolCall": name} · {"toolResult"} · {"interrupt": true} · {"done": true} · {"error"}
//
// Hands-free: a click starts a session and the mic stays open (the model
// takes turns and stops when talked over); a second click ends it, as do the
// tab going hidden, IDLE_MS without the core hearing you, and MAX_MS in all.

const IDLE_MS = 120_000;
const MAX_MS = 15 * 60_000;
const IN_RATE = 16_000;
const OUT_RATE = 24_000;

// conn: idle | connecting | open | error; agent: idle | listening | thinking | speaking
export const V = { conn: "idle", agent: "idle", last: "", error: "" };

let onChange = () => {};
// The transcript feed for panel 0 (chat.js): start · you · bot · tool · result · end,
// and quota (the caller's voice tokens today against the cap).
let onEvent = () => {};
export const onTranscript = (fn) => { onEvent = fn; };
let ws = null, micCtx = null, playCtx = null, stream = null, node = null, source = null;
let playing = [], nextStart = 0, idleTimer = null, maxTimer = null;

const set = (patch) => { Object.assign(V, patch); onChange(); };

function b64FromPCM(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32767));
  const bytes = new Uint8Array(i16.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function pcmFromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  return f32;
}

function stopPlayback() {
  playing.forEach((s) => { try { s.stop(); } catch (e) { /* already stopped */ } });
  playing = [];
  nextStart = 0;
}

function teardown() {
  clearTimeout(idleTimer); clearTimeout(maxTimer);
  idleTimer = maxTimer = null;
  if (node) node.disconnect(); node = null;
  if (source) source.disconnect(); source = null;
  if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null;
  stopPlayback();
  if (micCtx) micCtx.close(); micCtx = null;
  if (playCtx) playCtx.close(); playCtx = null;
  if (ws) {
    const w = ws;
    ws = null;
    try {
      if (w.readyState === WebSocket.OPEN) w.send(JSON.stringify({ audioStreamEnd: true }));
      w.close(1000, "user closed");
    } catch (e) { /* socket already gone */ }
  }
}

// Only the user's own speech resets the idle clock.
const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(stop, IDLE_MS); };

function onMessage(ev) {
  let m;
  try { m = JSON.parse(String(ev.data)); } catch (e) { return; }
  if (m.done) { stop(); return; }
  if (typeof m.error === "string") { set({ error: m.error }); return; }
  if (m.interrupt) { stopPlayback(); set({ agent: "listening" }); }
  if (typeof m.toolCall === "string") { onEvent({ t: "tool", text: m.toolCall }); set({ agent: "thinking", last: "⚙ " + m.toolCall }); }
  if (typeof m.toolResult === "string") onEvent({ t: "result", text: m.toolResult });
  if (m.quota) onEvent({ t: "quota", used: m.quota.used, limit: m.quota.limit });
  if (typeof m.inputTranscript === "string") { touch(); onEvent({ t: "you", text: m.inputTranscript }); set({ last: "you: " + m.inputTranscript }); }
  if (typeof m.transcript === "string") { onEvent({ t: "bot", text: m.transcript }); set({ agent: "speaking", last: m.transcript }); }
  if (typeof m.audio === "string" && playCtx) {
    if (V.agent !== "speaking") set({ agent: "speaking" });
    const f32 = pcmFromB64(m.audio);
    const buf = playCtx.createBuffer(1, f32.length, OUT_RATE);
    buf.getChannelData(0).set(f32);
    const src = playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(playCtx.destination);
    const at = Math.max(nextStart, playCtx.currentTime);
    src.start(at);
    nextStart = at + buf.duration;
    playing.push(src);
    src.onended = () => {
      playing = playing.filter((p) => p !== src);
      if (!playing.length && V.agent === "speaking") set({ agent: "listening" });
    };
  }
}

async function connect(tenant) {
  set({ conn: "connecting", agent: "idle", error: "", last: "" });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // No sampleRate constraint: a non-native rate turns off echo
      // cancellation. The 16 kHz context resamples instead.
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    if (!micCtx) throw new Error("audio unavailable");
    // The TUI's own worklet (tui/pcm-capture.js), resolved from this module so it loads under /tui/ and /ui/tui/ alike: the CSP is script-src 'self'.
    await micCtx.audioWorklet.addModule(new URL("./pcm-capture.js", import.meta.url).href);
    const qp = new URLSearchParams();
    if (tenant) qp.set("tenant", tenant);
    const q = qp.toString() ? "?" + qp : "";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/v2/agent/voice/session${q}`);
    ws = sock;
    await new Promise((resolve, reject) => {
      sock.onopen = () => resolve();
      sock.onerror = () => reject(new Error("voice session refused — is voice enabled for this tenant?"));
      sock.onclose = () => reject(new Error("voice session closed before it opened"));
    });
    sock.onmessage = onMessage;
    sock.onclose = () => { if (ws === sock) { if (V.conn === "open") onEvent({ t: "end" }); teardown(); set({ conn: "idle", agent: "idle" }); } };
    source = micCtx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(micCtx, "pcm-capture");
    node.port.onmessage = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ audio: b64FromPCM(e.data) }));
    };
    source.connect(node);
    set({ conn: "open", agent: "listening" });
    onEvent({ t: "start" });
    touch();
  } catch (e) {
    teardown();
    const msg = e && e.name === "NotAllowedError" ? "microphone permission was denied" : (e && e.message) || String(e);
    set({ conn: "error", agent: "idle", error: msg });
  }
}

export function initVoice(cb) {
  onChange = cb;
  // A hidden tab ends the session: nobody can see the button, so the mic must not stay open.
  const end = () => { if (V.conn !== "idle" && V.conn !== "error") stop(); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") end(); });
  window.addEventListener("pagehide", end);
}

export const active = () => V.conn === "connecting" || V.conn === "open";

// Start inside the click: browsers only let an AudioContext start from a gesture.
export function start(tenant) {
  if (window.TriageDemo) { window.TriageDemo.playSound(); return; }
  if (active()) return;
  try {
    micCtx = new AudioContext({ sampleRate: IN_RATE });
    playCtx = new AudioContext({ sampleRate: OUT_RATE });
    micCtx.resume(); playCtx.resume();
  } catch (e) { /* no Web Audio: connect() reports it */ }
  clearTimeout(maxTimer);
  maxTimer = setTimeout(stop, MAX_MS);
  connect(tenant);
}

export function stop() {
  if (V.conn === "open") onEvent({ t: "end" });
  teardown();
  set({ conn: "idle", agent: "idle", last: "", error: "" });
}

// Typed text goes into the open voice session as a user turn (panel 0 while voice runs).
export function sendText(text) {
  if (V.conn !== "open" || !ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ text }));
  touch();
  return true;
}

export function toggle(tenant) {
  if (window.TriageDemo && window.TriageDemo.stopSound()) return;
  if (active()) stop(); else start(tenant);
}
