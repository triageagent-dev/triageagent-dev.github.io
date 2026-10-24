/**
 * The messenger (core ADR-092): one conversation per workspace where people
 * and Tria write to each other. Everything goes through the core's
 * /v2/messenger routes on this origin, behind the Triage session; the server
 * that stores the conversations is the core's, never reached from here.
 */
import { call as callApp, inApp } from "../lib/native.js"

async function req(method, path, body, raw) {
  const headers = { Accept: "application/json" }
  let payload
  if (raw) { headers["Content-Type"] = raw.type || "application/octet-stream"; payload = raw }
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body) }
  const res = await fetch("/v2/messenger" + path, { method, credentials: "include", headers, body: payload })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }
  if (!res.ok) {
    const e = new Error(data?.error || (res.status === 503 ? "the messenger is not set up on this core" : `${res.status} ${res.statusText}`))
    e.status = res.status
    throw e
  }
  return data ?? {}
}

const enc = encodeURIComponent
const room = (id) => `/rooms/${enc(id)}`

/** {me, name, tria, reactions, rooms: [{id, workspace, name, unread, last}]} */
export const rooms = () => req("GET", "/rooms")

/** {id, name, avatar}: me in the messenger; avatar is "" without a photo. */
export const me = () => req("GET", "/me")
/** Set my photo (an image of at most 2 MB): {avatar}. */
export const setAvatar = (blob) => req("PUT", "/me/avatar", undefined, blob)
export const dropAvatar = () => req("DELETE", "/me/avatar")

/** {people: [{id, name}]}: who shares a workspace with me, for a direct chat. */
export const people = () => req("GET", "/people")

/** Open (or create) my direct chat with one person: {id, name, peer}. */
export const dm = (user) => req("POST", "/dms", { user })

/** One page, oldest first: {me, messages, reactions, before, members, canWrite, receipts?, pinned?} */
export const messages = (r, before = "") => req("GET", `${room(r)}/messages${before ? "?before=" + enc(before) : ""}`)

/**
 * {id, tria}: tria is true when @tria asked Tria, whose answer follows on the
 * stream. forwarded names who wrote the original, for a forward made here.
 */
export const send = (r, text, replyTo, forwarded) => req("POST", `${room(r)}/messages`, { text, ...(replyTo ? { replyTo } : {}), ...(forwarded ? { forwarded } : {}) })
/** An encrypted chat's message: the m.room.encrypted content this device made (core ADR-093). */
export const sendSealed = (r, encrypted) => req("POST", `${room(r)}/messages`, { encrypted })
export const edit = (r, id, text) => req("PUT", `${room(r)}/messages/${enc(id)}`, { text })
export const remove = (r, id) => req("DELETE", `${room(r)}/messages/${enc(id)}`)
export const react = (r, id, key) => req("POST", `${room(r)}/messages/${enc(id)}/reactions`, { key })
export const unreact = (r, reactionId) => req("DELETE", `${room(r)}/reactions/${enc(reactionId)}`)
export const forward = (r, id, to) => req("POST", `${room(r)}/messages/${enc(id)}/forward`, { to })
export const pin = (r, id, on) => req("POST", `${room(r)}/messages/${enc(id)}/pin`, { on })
export const search = (r, q) => req("GET", `${room(r)}/search?q=${enc(q)}`)
export const typing = (r, on) => req("POST", `${room(r)}/typing`, { on }).catch(() => {})
export const markRead = (r, id) => req("POST", `${room(r)}/read`, { id }).catch(() => {})

/**
 * An image or file as the raw body; opts: {caption, replyTo, w, h, forwarded}.
 * In an encrypted chat the body is the ciphertext and the answer is
 * {mxc, url}: the device then sends the message that holds the key.
 */
export function upload(r, file, opts = {}) {
  const q = new URLSearchParams({ name: file.name || "file" })
  for (const k of ["caption", "replyTo", "w", "h", "forwarded"]) if (opts[k]) q.set(k, String(opts[k]))
  return req("POST", `${room(r)}/media?${q}`, undefined, file)
}

/** This install's encrypting device, made by the core: {user, device}. */
export const cryptoDevice = (name) => req("POST", "/crypto/device", { name })
/** One crypto-engine call relayed to the homeserver as that device: its reply. */
export const cryptoRequest = (device, type, body, extra = {}) => req("POST", "/crypto/request", { device, type, body, ...extra })

/**
 * The live stream: onFrame gets {room, message} · {room, edit} ·
 * {room, redact} · {room, reaction} · {room, typing} · {room, receipt}, and
 * with a device, {crypto} for its engine; onState "live" or "connecting". It
 * reconnects until stop() is called.
 */
export function follow(onFrame, onState = () => {}, device = "") {
  let sock = null, stopped = false, retry = null
  const open = () => {
    if (stopped) return
    onState("connecting")
    const proto = location.protocol === "https:" ? "wss" : "ws"
    sock = new WebSocket(`${proto}://${location.host}/v2/messenger/ws${device ? "?device=" + encodeURIComponent(device) : ""}`)
    sock.onmessage = (ev) => {
      let f
      try { f = JSON.parse(ev.data) } catch { return }
      if (f.hello) onState("live")
      else onFrame(f)
    }
    sock.onclose = () => { onState("connecting"); if (!stopped) retry = setTimeout(open, 4000) }
  }
  open()
  return () => { stopped = true; clearTimeout(retry); sock?.close() }
}

/**
 * In the Android app with alerts on, this install's Firebase token is added
 * to the person's messenger devices, so messages wake the phone.
 */
export async function syncMessengerPush() {
  if (!inApp) return
  const p = (await callApp("push.state")).push ?? {}
  if (p.state !== "on" || !p.token) return
  await req("PUT", "/devices", { token: p.token })
}
