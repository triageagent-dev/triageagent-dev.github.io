/**
 * Web Push for this device. The core owns the VAPID key and the subscription
 * list (/v2/push/*, session-gated); the app-wide service worker (public/sw.js)
 * already shows the notification. This only subscribes and unsubscribes.
 */
import { ApiError } from "./client.js"
import { call as callApp, inApp } from "../lib/native.js"

const LEVEL_KEY = "triage.push.level"

export function pushLevel() {
  try { return localStorage.getItem(LEVEL_KEY) === "all" ? "all" : "issues" } catch { return "issues" }
}

function rememberLevel(level) {
  try { localStorage.setItem(LEVEL_KEY, level) } catch { /* private window: the core still has it */ }
}

export const pushSupported = () =>
  inApp ||
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window

/** base64url VAPID key -> the bytes pushManager.subscribe wants. */
export function keyBytes(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4)
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

async function call(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new ApiError(res.status, path, res.status === 401 ? "signed out" : `${res.status} ${res.statusText}`.trim())
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration()) ?? null
}

/**
 * In the Android app the browser has no push service, so the app holds a Firebase token and
 * the core delivers to it as a device subscription (endpoint "fcm:" + token). The app answers
 * {push: {state: "on"|"off"|"denied", token?}}.
 */
const deviceEndpoint = (token) => "fcm:" + token
const appPush = async (type) => (await callApp(type)).push ?? {}

export async function pushState() {
  if (inApp) return (await appPush("push.state")).state ?? "off"
  if (!pushSupported()) return "unsupported"
  if (Notification.permission === "denied") return "denied"
  const sub = await (await registration())?.pushManager.getSubscription()
  return sub && Notification.permission === "granted" ? "on" : "off"
}

/** The level the core holds for this device's subscription, else the remembered one. */
export async function storedPushLevel() {
  if (inApp) {
    const { token } = await appPush("push.state")
    if (token) {
      try {
        const st = await call(`/v2/push/state?endpoint=${encodeURIComponent(deviceEndpoint(token))}`)
        if (st?.subscribed) { const l = st.level === "all" ? "all" : "issues"; rememberLevel(l); return l }
      } catch { /* fall through to the remembered choice */ }
    }
    return pushLevel()
  }
  const sub = await (await registration())?.pushManager.getSubscription().catch(() => null)
  if (sub) {
    try {
      const st = await call(`/v2/push/state?endpoint=${encodeURIComponent(sub.endpoint)}`)
      if (st?.subscribed) { const l = st.level === "all" ? "all" : "issues"; rememberLevel(l); return l }
    } catch { /* older core: fall through to the remembered choice */ }
  }
  return pushLevel()
}

async function register(sub, level) {
  await call("/v2/push/subscribe", { ...sub.toJSON(), level })
  rememberLevel(level)
}

async function registerDevice(token, level) {
  await call("/v2/push/device", { token, level })
  rememberLevel(level)
}

export async function enablePush(level = pushLevel()) {
  if (inApp) {
    const p = await appPush("push.enable")
    if (p.state === "denied") return "denied"
    if (!p.token) throw new Error(p.error || "the app could not get a notification token")
    await registerDevice(p.token, level)
    return "on"
  }
  if (!pushSupported()) return "unsupported"
  const permission = await Notification.requestPermission()
  if (permission !== "granted") return permission === "denied" ? "denied" : "off"
  const reg = await navigator.serviceWorker.ready
  const k = await call("/v2/push/vapid-key")
  const publicKey = k?.Body?.publicKey ?? k?.publicKey
  if (!publicKey) throw new Error("the core has no push key configured")
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  await register(sub, level)
  return "on"
}

/** Re-registers the existing subscription with a new level; a no-op when push is off. */
export async function setPushLevel(level) {
  if (inApp) {
    const { state, token } = await appPush("push.state")
    if (state === "on" && token) await registerDevice(token, level)
    else rememberLevel(level)
    return level
  }
  const sub = await (await registration())?.pushManager.getSubscription()
  if (sub) await register(sub, level)
  else rememberLevel(level)
  return level
}

export async function disablePush() {
  if (inApp) {
    const { token } = await appPush("push.disable")
    if (token) await call("/v2/push/unsubscribe", { endpoint: deviceEndpoint(token) })
    return "off"
  }
  const sub = await (await registration())?.pushManager.getSubscription()
  if (sub) {
    await call("/v2/push/unsubscribe", { endpoint: sub.endpoint })
    await sub.unsubscribe()
  }
  return "off"
}

/**
 * Signed in, in the app, with alerts on: tell the core about this install again. A token
 * Firebase rotated, or a session whose grants changed, then reach the core without a toggle.
 */
export async function resyncDevicePush() {
  if (!inApp) return
  const { state, token } = await appPush("push.state")
  if (state === "on" && token) await registerDevice(token, pushLevel())
}
