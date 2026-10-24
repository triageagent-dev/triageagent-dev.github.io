// Pure helpers for the messenger screens (tested in chat.test.js).

const PALETTE = ["#7b6cd9", "#3f8fd2", "#2fa37a", "#c9852f", "#c25b8a", "#4aa3a3", "#8a7a3a", "#a35bc2"]

/** A stable colour for a person or workspace. */
export function avatarColor(key = "") {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

/** A name's colour above a bubble (lighter than the avatar). */
export function nameColor(key = "") {
  const c = avatarColor(key)
  return `color-mix(in srgb, ${c} 70%, white)`
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** The list's time: today as HH:MM, this week as the weekday, else the date. */
export function shortTime(ts, now = Date.now()) {
  const d = new Date(ts), n = new Date(now)
  if (sameDay(d, n)) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  if (now - ts < 6 * 864e5) return d.toLocaleDateString("en-GB", { weekday: "short" })
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
}

export const clock = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })

/** A day separator's label. */
export function dayLabel(ts, now = Date.now()) {
  const d = new Date(ts), n = new Date(now)
  if (sameDay(d, n)) return "Today"
  if (sameDay(d, new Date(now - 864e5))) return "Yesterday"
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", ...(d.getFullYear() !== n.getFullYear() ? { year: "numeric" } : {}) })
}

/** One line for a message in the list or a quote. */
export function snippet(m) {
  if (!m) return ""
  if (m.type === "deleted") return "Message deleted"
  if (m.type === "encrypted") return "Encrypted message"
  if (m.type === "image") return m.body && m.body !== m.media?.name ? "📷 " + m.body : "📷 Photo"
  if (m.type === "file") return "📎 " + (m.media?.name || m.body)
  return (m.body || "").replace(/\s+/g, " ")
}

/** One message holds at most this many characters; the boxes stop there. */
export const MAX_TEXT = 2500

/**
 * What a message box says about the room left: nothing until 500 characters
 * remain, then how many are left, then that the limit is reached (a longer
 * paste is cut there).
 */
export function charsNote(len) {
  const left = MAX_TEXT - len
  if (left > 500) return null
  const at = n => n.toLocaleString("en")
  return left <= 0
    ? { left: 0, level: "crit", text: `Limit reached: ${at(MAX_TEXT)} characters, the rest is cut` }
    : { left, level: left <= 100 ? "warn" : "faint", text: `${at(left)} left` }
}

/** The list's preview: who wrote it, then what. */
export function preview(m) {
  const who = m.mine ? "You" : m.tria ? "Tria" : m.name
  return `${who}: ${snippet(m)}`
}

/**
 * The rows the conversation draws, oldest first: day separators, and each
 * message marked first when it starts a run from one sender (a new sender, a
 * new day, or more than 5 minutes after the last).
 */
export function layout(msgs) {
  const out = []
  let prev = null
  for (const m of msgs) {
    const d = new Date(m.ts)
    const newDay = !prev || !sameDay(d, new Date(prev.ts))
    if (newDay) out.push({ day: m.ts, key: "day-" + m.ts })
    out.push({ m, key: m.id, first: newDay || prev.sender !== m.sender || prev.mine !== m.mine || m.ts - prev.ts > 5 * 60e3 })
    prev = m
  }
  return out
}

/** How each status word shows: a Phosphor icon in its status colour. */
export const REACTION_STYLE = {
  "ok": { icon: "thumbs-up", color: "var(--accent)" },
  "noted": { icon: "eye", color: "var(--st-info)" },
  "working on it": { icon: "hammer", color: "var(--st-warn)" },
  "fixed": { icon: "check-circle", color: "var(--st-ok)" },
  "blocked": { icon: "prohibit", color: "var(--st-crit)" },
}
export const reactionStyle = (key) => REACTION_STYLE[key] ?? { icon: "tag", color: "var(--text2)" }

/** Reactions on one message grouped by word, in the fixed list's order. */
export function groupReactions(list = [], order = []) {
  const by = new Map()
  for (const r of list) {
    const g = by.get(r.key) ?? { key: r.key, count: 0, mine: false, names: [] }
    g.count++
    g.mine ||= !!r.mine
    g.names.push(r.mine ? "You" : r.name)
    by.set(r.key, g)
  }
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? 99 : i }
  return [...by.values()].sort((a, b) => rank(a.key) - rank(b.key))
}

/** The @word being typed at the caret, or null. */
export function mentionAt(text, caret) {
  const m = /(^|\s)@([\w.-]*)$/.exec(text.slice(0, caret))
  return m ? { query: m[2].toLowerCase(), start: caret - m[2].length - 1 } : null
}

export function fileSize(n = 0) {
  if (n < 1024) return n + " B"
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB"
  return (n / 1024 / 1024).toFixed(1) + " MB"
}

/**
 * An encrypted message (core ADR-093) once its device decrypted it: the
 * content as the core would have read it in a plain chat. A file keeps its
 * key (media.enc) and gets its URL when the device has decrypted the bytes.
 * warn: the engine could not tie it to a verified device.
 */
export function fromContent(m, content, warn) {
  const c = content ?? {}
  const out = { ...m, enc: undefined, encEdit: undefined, waiting: false, warn: !!warn, type: "text", body: String(c.body ?? "") }
  const rel = c["m.relates_to"]?.["m.in_reply_to"]?.event_id
  if (rel && !out.replyTo) out.replyTo = rel
  const from = c["app.triage.forwarded"]?.from
  if (from) out.forwarded = String(from)
  if ((c.msgtype === "m.image" || c.msgtype === "m.file") && c.file?.url) {
    out.type = c.msgtype === "m.image" ? "image" : "file"
    const info = c.info ?? {}
    out.media = { url: "", thumb: "", name: String(c.filename || c.body || "file"), mime: String(info.mimetype || ""), size: Number(info.size) || 0, w: Number(info.w) || 0, h: Number(info.h) || 0, enc: c.file }
  }
  return out
}

/** An edit's new text, from a decrypted m.replace content; null when it is not one. */
export function editedBody(content) {
  const n = content?.["m.new_content"]
  return n && typeof n.body === "string" ? n.body : null
}

/** The server's path for an mxc:// file in a conversation (what the core serves). */
export function mediaPath(room, mxc) {
  const m = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxc || "")
  return m ? `/v2/messenger/rooms/${encodeURIComponent(room)}/media/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}` : ""
}
