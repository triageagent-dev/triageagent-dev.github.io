/** Formatting shared by every screen. Absent is null and renders "—". */

export const DASH = "—"

export const num = (v) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined

export function fmtDur(sec) {
  if (sec == null || !Number.isFinite(sec)) return DASH
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return s + "s"
  if (s < 3600) return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s"
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60)
  return h < 24 ? h + "h " + String(m).padStart(2, "0") + "m" : Math.floor(h / 24) + "d " + (h % 24) + "h"
}

export function fmtDurShort(sec) {
  if (sec == null || !Number.isFinite(sec)) return DASH
  const s = Math.max(0, Math.round(sec))
  if (s && s % 3600 === 0) return s / 3600 + "h"
  if (s >= 5400) return fmtDur(s)
  if (s && s % 60 === 0) return s / 60 + "m"
  return fmtDur(s)
}

export function ageShort(iso, now) {
  const t = iso ? new Date(iso).getTime() : NaN
  if (!Number.isFinite(t)) return ""
  const m = Math.max(0, Math.round((now - t) / 60000))
  if (m < 60) return m + "m"
  const h = Math.round(m / 60)
  return h < 48 ? h + "h" : Math.round(h / 24) + "d"
}

export function durBetween(a, b) {
  if (!a || !b) return null
  const ms = new Date(b).getTime() - new Date(a).getTime()
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : null
}

export const ordinal = (n) =>
  n + (["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4)] || "th")

export const pct = (fill) => (fill == null ? DASH : Math.round(fill * 100) + "%")

export const count = (n) => (n == null ? DASH : n.toLocaleString("en-US"))

/** 1.2K / 3.4M, for token counts. */
export function compact(n) {
  if (n == null || !Number.isFinite(n)) return DASH
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K"
  return String(Math.round(n))
}

export function fmtClock(iso, now = Date.now()) {
  const d = iso ? new Date(iso) : null
  if (!d || !Number.isFinite(d.getTime())) return DASH
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  if (d.toDateString() === new Date(now).toDateString()) return time
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`
}

export const firstLine = (s) =>
  String(s || "").split(/\r?\n/).map(x => x.trim()).find(Boolean) || ""

export function restLines(s) {
  const lines = String(s || "").split(/\r?\n/)
  const i = lines.findIndex(x => x.trim())
  return i < 0 ? "" : lines.slice(i + 1).join("\n").trim()
}

/**
 * Cluster and namespace from a source path:
 *   k8s/<cluster>/<Kind>/<ns>/<name> | k8s/<Kind>/<ns>/<name>
 *   app/<cluster>/<ns>/<name>        | app/<ns>/<name>
 *   flux/<cluster>/<ns>/<name>       | flux/<ns>/<name>
 */
export function parseSource(source) {
  const parts = String(source ?? "").split("/")
  const kind = parts[0] ?? ""
  const minCluster = { k8s: 5, app: 4, flux: 4 }
  const multi = !!(minCluster[kind] && parts.length >= minCluster[kind])
  const cluster = multi ? (parts[1] ?? "") : ""
  let namespace = ""
  let resource = ""
  if (kind === "k8s") {
    namespace = parts[multi ? 3 : 2] ?? ""
    resource = parts[multi ? 2 : 1] ?? ""
  } else if (kind === "app" || kind === "flux") namespace = parts[multi ? 2 : 1] ?? ""
  return { kind, cluster, namespace, resource }
}

/** The service an issue or event is about: the last segment of its source. */
export function lastSegment(source) {
  const parts = String(source || "").split("/").filter(Boolean)
  return parts[parts.length - 1] || source || DASH
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
