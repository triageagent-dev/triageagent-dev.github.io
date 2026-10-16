/**
 * The Android app's bridge (window.TriageNative, a WebView message listener on this
 * origin only). The page posts JSON {type, id?, ...}; the app answers a request with
 * {re: id, ...} and pushes its own events (voice state, a tapped notification) as
 * {type, ...}. One handler owns the bridge's single onmessage, so voice, push and
 * the rest share it here. Absent in a browser: `inApp` is false and nothing is sent.
 */
const bridge = typeof window !== "undefined" ? window.TriageNative : undefined
const handlers = new Set()
const waiting = new Map()
let seq = 0

if (bridge) {
  bridge.onmessage = (ev) => {
    let m
    try { m = JSON.parse(String(ev.data)) } catch { return }
    const w = m.re !== undefined ? waiting.get(m.re) : undefined
    if (w) { waiting.delete(m.re); w(m); return }
    handlers.forEach(h => h(m))
  }
}

export const inApp = !!bridge

export function send(m) {
  bridge?.postMessage(JSON.stringify(m))
}

/** Subscribe to the app's own events; returns the unsubscribe. */
export function onMessage(h) {
  handlers.add(h)
  return () => handlers.delete(h)
}

/** A request the app answers with {re: id, ...}. */
export function call(type, body = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    const t = setTimeout(() => { waiting.delete(id); reject(new Error("the app did not answer")) }, timeoutMs)
    waiting.set(id, (m) => { clearTimeout(t); resolve(m) })
    send({ type, id, ...body })
  })
}
