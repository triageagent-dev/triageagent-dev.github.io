// This install's encryption engine (core ADR-093): state/e2ee.js wired to
// the core's crypto routes, the browser's IndexedDB and, in the Android app,
// a store key the Android Keystore keeps.
import * as api from "../api/messenger.js"
import { call as callApp, inApp } from "../lib/native.js"
import { engine } from "./e2ee.js"

const RECORD = "triage.e2ee"
const keyName = (device) => `triage.e2ee.key.${device}`
const dbPrefix = (device) => `triage-e2ee-${device}`

const local = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  put(k, v) { try { localStorage.setItem(k, v) } catch { /* private window: the engine still runs, once */ } },
  drop(k) { try { localStorage.removeItem(k) } catch { /* nothing kept */ } },
}

function randomKey() {
  const b = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...b))
}

/** What this device is called in the person's device list. */
function deviceName() {
  if (inApp) return "Triage Android app"
  return location.pathname.includes("/mobile") ? "Triage mobile web" : "Triage TUI"
}

export const e2ee = engine({
  async load() {
    throw new Error("The demo has no encryption")
  },
  relay: (device, type, body, extra) => api.cryptoRequest(device, type, body, extra),
  newDevice: (name) => api.cryptoDevice(name || deviceName()),
  storage: {
    get() { try { return JSON.parse(local.get(RECORD) ?? "null") } catch { return null } },
    put(v) { local.put(RECORD, JSON.stringify(v)) },
    clear() { local.drop(RECORD) },
  },
  storeName: dbPrefix,
  async dropStore(device) {
    local.drop(keyName(device))
    if (inApp) { try { await callApp("crypto.dropKey", { device }, 3000) } catch { /* an older app keeps none */ } }
    try {
      for (const db of (await indexedDB.databases?.()) ?? []) {
        if (db.name?.startsWith(dbPrefix(device))) indexedDB.deleteDatabase(db.name)
      }
    } catch { /* nothing to drop */ }
  },
  // A key kept in this browser's storage seals the store; the Android app
  // keeps it in the Keystore instead. A key already here stays in use.
  async storeKey(device) {
    const kept = local.get(keyName(device))
    if (kept) return kept
    if (inApp) {
      try {
        const r = await callApp("crypto.storeKey", { device }, 3000)
        if (r?.key) return r.key
      } catch { /* an app build without the Keystore key: this browser's storage */ }
    }
    const k = randomKey()
    local.put(keyName(device), k)
    return k
  },
})

export { deviceName }
if (window.TriageDemo) e2ee.start = async () => {}

/**
 * In the Android app a decrypted file (a blob: URL the page made) cannot go
 * to the system's download manager, so its bytes go to the app, which saves
 * them to Downloads. Elsewhere the link's own download does it: false.
 */
export function saveInApp(ev, url, name, mime) {
  if (!inApp || !url?.startsWith("blob:")) return false
  ev.preventDefault()
  void (async () => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
    let bin = ""
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    await callApp("files.save", { name: name || "file", mime: mime || "", data: btoa(bin) }, 60_000)
  })().catch(() => {})
  return true
}
