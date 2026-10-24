// The messenger's state for the whole app: the conversation list, each open
// conversation's messages, and one live stream that keeps them current, so
// the Chats tab's unread badge moves whatever screen is showing.
//
// Outgoing messages show at once as pending ("local-…" ids) and become the
// server's message when it answers; a failed one stays, marked, to resend or
// discard. Reactions are kept per message id as they arrive, so a reaction
// that lands before (or after) its message's page is never lost.
//
// Direct chats are end-to-end encrypted (core ADR-093): this install's
// engine (e2ee-app.js) decrypts what arrives and encrypts what goes out, and
// the stream then syncs as this install's device. A message whose key has
// not arrived yet waits, and is read again when keys come.
import { create } from "../lib/store.js"
import * as api from "../api/messenger.js"
import { editedBody, fromContent, mediaPath, snippet } from "../model/chat.js"
import { deviceName, e2ee } from "./e2ee-app.js"

let seq = 0
let stopStream = null
let spotTimer = null
let cryptoStarting = false
let frames = Promise.resolve()
const typingSent = {}
// A typing indicator nobody refreshes ends by itself: the core asks for a 30 s timeout,
// but its end does not always reach us, so a stopped spot would "type" for ever.
const TYPING_EXPIRY_MS = 40_000
const typingTimers = {}
const blobs = new Map() // mxc -> object URL of the decrypted file

/** The core takes files of at most 2 MB. */
export const MAX_UPLOAD = 2 * 1024 * 1024

/**
 * A photo over the limit is re-encoded as JPEG, its longest side stepping
 * down from 2560 px until it fits; null when it cannot be made to fit.
 */
export async function fitImage(file) {
  if (file.size <= MAX_UPLOAD) return file
  let bmp
  try { bmp = await createImageBitmap(file) } catch { return null }
  const canvas = document.createElement("canvas")
  for (const side of [2560, 2048, 1600, 1280, 1024]) {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height))
    canvas.width = Math.round(bmp.width * k)
    canvas.height = Math.round(bmp.height * k)
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height)
    for (const q of [0.85, 0.72]) {
      const blob = await new Promise(ok => canvas.toBlob(ok, "image/jpeg", q))
      if (blob && blob.size <= MAX_UPLOAD) {
        bmp.close?.()
        return new File([blob], (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" })
      }
    }
  }
  bmp.close?.()
  return null
}

/** A square crop of a photo's centre, at most 512 px, as JPEG. */
async function squarePhoto(file) {
  const bmp = await createImageBitmap(file)
  const side = Math.min(bmp.width, bmp.height), out = Math.min(512, side)
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = out
  canvas.getContext("2d").drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out)
  bmp.close?.()
  return await new Promise(ok => canvas.toBlob(ok, "image/jpeg", 0.88))
}

const sortRooms = (rooms) => rooms.slice().sort((a, b) => (b.last?.ts ?? 0) - (a.last?.ts ?? 0))

export const useMessenger = create((set, get) => {
  const conv = (room) => get().convs[room]
  const patchConv = (room, fn) => {
    const c = conv(room)
    if (!c) return
    set({ convs: { ...get().convs, [room]: { ...c, ...fn(c) } } })
  }
  const patchMsg = (room, id, fn) => patchConv(room, (c) => ({ msgs: c.msgs.map(m => m.id === id ? { ...m, ...fn(m) } : m) }))
  const addReaction = (r) => {
    const all = get().reactions
    const list = all[r.target] ?? []
    if (list.some(x => x.id === r.id)) return
    set({ reactions: { ...all, [r.target]: list.concat(r) } })
  }
  const dropReaction = (id) => {
    const all = get().reactions
    for (const [target, list] of Object.entries(all)) {
      if (list.some(x => x.id === id)) { set({ reactions: { ...all, [target]: list.filter(x => x.id !== id) } }); return true }
    }
    return false
  }
  const touchRoom = (room, m, countUnread) => {
    set({
      rooms: sortRooms(get().rooms.map(r => r.id !== room ? r : {
        ...r, last: m, unread: countUnread ? (r.unread || 0) + 1 : r.unread,
      })),
    })
  }
  const addMessages = (room, more) => patchConv(room, (c) => {
    const seen = new Set(c.msgs.map(m => m.id))
    return { msgs: c.msgs.concat(more.filter(m => !seen.has(m.id))) }
  })

  const isEnc = (room) => !!(get().rooms.find(r => r.id === room)?.encrypted || conv(room)?.encrypted)
  const members = (room) => [get().me, get().rooms.find(r => r.id === room)?.peer].filter(Boolean)

  // An encrypted message as this device reads it; it waits when its key
  // has not arrived.
  async function reveal(m) {
    if (m?.type !== "encrypted") return m
    const d = await e2ee.decrypt(m.enc)
    if (!d) return { ...m, waiting: true }
    let out = fromContent(m, d.content, d.warn)
    if (m.encEdit) {
      const e = await e2ee.decrypt(m.encEdit)
      const body = editedBody(e?.content)
      if (body != null && e.sender === m.sender) out = { ...out, body, edited: true }
    }
    return out
  }
  // An encrypted file is fetched as ciphertext and opened here.
  async function loadMedia(room, m) {
    const f = m?.media?.enc
    if (!f?.url || m.media.url) return
    let url = blobs.get(f.url)
    if (!url) {
      try {
        const res = await fetch(mediaPath(room, f.url), { credentials: "include" })
        if (!res.ok) return
        const plain = e2ee.decryptFile(new Uint8Array(await res.arrayBuffer()), f)
        url = URL.createObjectURL(new Blob([plain], { type: m.media.mime || "application/octet-stream" }))
        blobs.set(f.url, url)
      } catch { return }
    }
    patchMsg(room, m.id, (x) => ({ media: { ...x.media, url, thumb: url } }))
  }
  const loadAll = (room, msgs) => { for (const m of msgs) if (m?.media?.enc) void loadMedia(room, m) }

  // Keys came: whatever was waiting is read again.
  async function retryWaiting() {
    for (const [room, c] of Object.entries(get().convs)) {
      for (const m of c.msgs) {
        if (!m.waiting) continue
        const r = await reveal(m)
        if (!r.waiting) { patchMsg(room, m.id, () => r); loadAll(room, [r]) }
      }
    }
    for (const r of get().rooms) {
      if (r.last?.type !== "encrypted") continue
      const last = await reveal(r.last)
      if (!last.waiting) set({ rooms: get().rooms.map(x => x.id === r.id ? { ...x, last } : x) })
    }
  }
  e2ee.onKeys(() => { void retryWaiting() })

  // The engine starts once the list says who I am; the stream then syncs
  // as this install's device so its keys and messages reach it.
  async function startCrypto() {
    const me = get().me
    if (!me || cryptoStarting || e2ee.ready) return
    cryptoStarting = true
    try {
      await e2ee.start(me, deviceName())
      stopStream?.()
      stopStream = api.follow(onFrame, (status) => set({ status }), e2ee.device)
      void retryWaiting()
    } catch { /* useE2EE says why; plain chats work without it */ }
    cryptoStarting = false
  }

  // Frames are handled in order: a message can need the keys of the crypto
  // frame before it.
  const onFrame = (f) => { frames = frames.then(() => handle(f)).catch(() => {}) }
  const handle = async (f) => {
    if (f.crypto) {
      if (f.crypto.lost) { await e2ee.forget(); await startCrypto(); return }
      await e2ee.receive(f.crypto)
      return
    }
    const room = f.room
    // A conversation not in the list yet (someone opened a direct chat with me).
    if (room && !get().rooms.some(r => r.id === room)) void get().refreshRooms()
    if (f.message) {
      const m = await reveal(f.message)
      const c = conv(room)
      if (c) { addMessages(room, [m]); loadAll(room, [m]) }
      const viewing = get().active === room && !document.hidden
      touchRoom(room, m, !m.mine && !viewing)
      if (viewing) void api.markRead(room, m.id)
      // A message ends its sender's typing (Tria's and a spot's alike).
      if (!m.mine) set({ typing: { ...get().typing, [room]: (get().typing[room] ?? []).filter(n => n !== (m.tria ? "Tria" : m.name)) } })
    }
    if (f.edit?.enc) {
      const e = await e2ee.decrypt(f.edit.enc)
      const body = editedBody(e?.content)
      const orig = conv(room)?.msgs.find(x => x.id === f.edit.id)
      if (body != null && (!orig?.sender || orig.sender === e.sender)) patchMsg(room, f.edit.id, () => ({ body, edited: true }))
    } else if (f.edit) patchMsg(room, f.edit.id, () => ({ body: f.edit.body, edited: true }))
    if (f.redact) {
      if (!dropReaction(f.redact)) patchMsg(room, f.redact, () => ({ type: "deleted", body: "", media: null }))
    }
    if (f.reaction) addReaction(f.reaction)
    if (f.typing) {
      set({ typing: { ...get().typing, [room]: f.typing } })
      clearTimeout(typingTimers[room])
      if (f.typing.length) typingTimers[room] = setTimeout(() => set({ typing: { ...get().typing, [room]: [] } }), TYPING_EXPIRY_MS)
    }
    if (f.receipt) patchConv(room, (c) => ({ receipts: { ...c.receipts, [f.receipt.user]: f.receipt.id } }))
  }

  // Sends one message: plain through the core, or encrypted here first
  // (a file's bytes too, uploaded as ciphertext).
  async function dispatch(room, m) {
    if (!isEnc(room)) {
      return m.file ? api.upload(room, m.file, { caption: m.caption, replyTo: m.replyTo, w: m.media?.w, h: m.media?.h, forwarded: m.forwarded })
        : api.send(room, m.body, m.replyTo, m.forwarded)
    }
    if (!e2ee.ready) throw new Error("Encryption is still starting on this device; try again in a moment")
    let content
    if (m.file) {
      const { data, file } = e2ee.encryptFile(new Uint8Array(await m.file.arrayBuffer()))
      const up = await api.upload(room, new Blob([data], { type: "application/octet-stream" }))
      const info = { mimetype: m.file.type || "application/octet-stream", size: m.file.size, ...(m.media?.w ? { w: m.media.w, h: m.media.h } : {}) }
      content = { msgtype: m.type === "image" ? "m.image" : "m.file", body: m.caption || m.file.name, filename: m.file.name, info, file: { ...file, url: up.mxc } }
    } else content = { msgtype: "m.text", body: m.body }
    if (m.replyTo) content["m.relates_to"] = { "m.in_reply_to": { event_id: m.replyTo } }
    if (m.forwarded) content["app.triage.forwarded"] = { from: m.forwarded }
    return api.sendSealed(room, await e2ee.encrypt(room, members(room), "m.room.message", content))
  }

  return {
    status: "idle",       // idle | connecting | live
    loaded: false, err: "",
    me: "", myName: "", tria: "", reactionList: [],
    rooms: [],            // [{id, kind, workspace, peer, encrypted, name, unread, last}]
    trust: {},            // encrypted chat -> the other person's identity: none | unverified | verified | changed
    convs: {},            // room -> {msgs, before, done, receipts, pinned, members, canWrite, loading}
    reactions: {},        // message id -> [Reaction]
    typing: {},           // room -> [names]
    active: "",           // the conversation on screen
    myPhoto: undefined,   // my photo's URL: undefined not loaded yet, "" none

    /** Load the list and open the stream once. */
    start() {
      if (stopStream) return
      stopStream = api.follow(onFrame, (status) => set({ status }))
      void get().refreshRooms().then(startCrypto)
      // A spot that stops answering goes down without any event, so
      // its dot is read again from time to time.
      spotTimer ??= setInterval(() => void get().refreshSpots(), 30000)
    },
    // Reads only each workspace's spot state, leaving the rest of the list as it is.
    async refreshSpots() {
      try {
        const d = await api.rooms()
        const spot = new Map((d.rooms ?? []).map(r => [r.id, r.spot]))
        set({ rooms: get().rooms.map(r => r.kind === "workspace" && spot.has(r.id) ? { ...r, spot: spot.get(r.id) } : r) })
      } catch { /* the next read tries again */ }
    },
    async refreshRooms() {
      try {
        const d = await api.rooms()
        set({ rooms: sortRooms(d.rooms ?? []), me: d.me, myName: d.name ?? "", tria: d.tria, reactionList: d.reactions ?? [], loaded: true, err: "" })
        for (const r of get().rooms) {
          if (r.last?.type !== "encrypted") continue
          const last = await reveal(r.last)
          set({ rooms: get().rooms.map(x => x.id === r.id ? { ...x, last } : x) })
        }
      } catch (e) {
        set({ err: e.message, loaded: true })
      }
    },
    /** Where the other person's identity stands, in an encrypted chat. */
    async checkTrust(room) {
      const peer = get().rooms.find(r => r.id === room)?.peer
      if (!peer || !isEnc(room)) return
      try { set({ trust: { ...get().trust, [room]: await e2ee.peer(peer) } }) } catch { /* not ready */ }
    },
    /** Accepts the other person's changed identity. */
    async acceptIdentity(room) {
      const peer = get().rooms.find(r => r.id === room)?.peer
      if (peer) await e2ee.acceptPeer(peer)
      await get().checkTrust(room)
    },
    /** Asks the other person to compare emoji. */
    verifyPeer(room) {
      const peer = get().rooms.find(r => r.id === room)?.peer
      return peer ? e2ee.verifyPeer(peer) : Promise.resolve()
    },

    async loadMe() {
      if (get().myPhoto !== undefined) return
      set({ myPhoto: "" })
      try { set({ myPhoto: (await api.me()).avatar || "" }) } catch { /* no messenger on this core: initials */ }
    },
    async setPhoto(file) {
      const blob = await squarePhoto(file)
      const r = await api.setAvatar(blob)
      set({ myPhoto: r.avatar || "" })
    },
    async dropPhoto() {
      await api.dropAvatar()
      set({ myPhoto: "" })
    },

    open(room) {
      set({ active: room, rooms: get().rooms.map(r => r.id === room ? { ...r, unread: 0 } : r) })
      if (conv(room)?.msgs.length) return
      set({ convs: { ...get().convs, [room]: { msgs: [], before: "", done: false, receipts: {}, pinned: [], members: {}, avatars: {}, canWrite: false, loading: true } } })
      void get().older(room, true)
    },
    close(room) { if (get().active === room) set({ active: "" }) },

    /** The first page (first=true) or the next older one. */
    async older(room, first) {
      const c = conv(room)
      if (!c || (!first && (c.loading || c.done))) return
      patchConv(room, () => ({ loading: true, err: "" }))
      try {
        const d = await api.messages(room, first ? "" : c.before)
        ;(d.reactions ?? []).forEach(addReaction)
        const revealed = await Promise.all((d.messages ?? []).map(reveal))
        patchConv(room, (cc) => {
          const seen = new Set(cc.msgs.map(m => m.id))
          const page = revealed.filter(m => !seen.has(m.id))
          return {
            msgs: page.concat(cc.msgs), before: d.before || "", done: !d.before, loading: false, err: "", encrypted: !!d.encrypted,
            members: { ...cc.members, ...(d.members ?? {}) }, avatars: { ...cc.avatars, ...(d.avatars ?? {}) }, canWrite: !!d.canWrite,
            ...(first ? { receipts: d.receipts ?? {}, pinned: d.pinned ?? [] } : {}),
          }
        })
        loadAll(room, revealed)
        if (d.encrypted && first) void get().checkTrust(room)
        const last = (d.messages ?? []).at(-1)
        if (first && last) void api.markRead(room, last.id)
      } catch (e) {
        patchConv(room, () => ({ loading: false, err: e.message }))
      }
    },

    /** Send text; it shows at once, pending, and the server's copy replaces it. */
    async send(room, text, replyTo) {
      const local = `local-${++seq}`
      addMessages(room, [{ id: local, local: true, pending: true, mine: true, name: "You", type: "text", body: text, ts: Date.now(), replyTo }])
      get().typingOff(room)
      return get().deliver(room, local)
    },
    async deliver(room, local) {
      const m = conv(room)?.msgs.find(x => x.id === local)
      if (!m) return null
      patchMsg(room, local, () => ({ pending: true, failed: false }))
      try {
        const r = await dispatch(room, m)
        // The stream may already have brought the server's copy.
        patchConv(room, (c) => {
          const has = c.msgs.some(x => x.id === r.id)
          return { msgs: has ? c.msgs.filter(x => x.id !== local) : c.msgs.map(x => x.id === local ? { ...x, id: r.id, local: false, pending: false, file: undefined } : x) }
        })
        if (r.tria) set({ typing: { ...get().typing, [room]: ["Tria"] } })
        return r
      } catch (e) {
        patchMsg(room, local, () => ({ pending: false, failed: true, error: e.message }))
        return null
      }
    },
    discard(room, local) { patchConv(room, (c) => ({ msgs: c.msgs.filter(x => x.id !== local) })) },

    /** Send an image or file; images preview from the device while they go up. */
    async attach(room, file, { caption, replyTo } = {}) {
      const isImage = file.type.startsWith("image/") && !file.type.includes("svg")
      if (isImage) file = await fitImage(file)
      if (!file) throw new Error("That photo could not be made small enough to send")
      if (file.size > MAX_UPLOAD) throw new Error(`${file.name} is over 2 MB`)
      const local = `local-${++seq}`
      let w = 0, h = 0, preview = ""
      if (isImage) {
        preview = URL.createObjectURL(file)
        try { const b = await createImageBitmap(file); w = b.width; h = b.height; b.close?.() } catch { /* sizes are optional */ }
      }
      addMessages(room, [{
        id: local, local: true, pending: true, mine: true, name: "You", ts: Date.now(), replyTo,
        type: isImage ? "image" : "file", body: caption || file.name, caption, file,
        media: { url: preview, thumb: preview, name: file.name, mime: file.type, size: file.size, w, h },
      }])
      return get().deliver(room, local)
    },

    async edit(room, id, text) {
      const old = conv(room)?.msgs.find(m => m.id === id)
      patchMsg(room, id, () => ({ body: text, edited: true }))
      try {
        if (isEnc(room)) {
          await api.sendSealed(room, await e2ee.encrypt(room, members(room), "m.room.message", {
            msgtype: "m.text", body: "* " + text,
            "m.new_content": { msgtype: "m.text", body: text },
            "m.relates_to": { rel_type: "m.replace", event_id: id },
          }))
        } else await api.edit(room, id, text)
      } catch (e) { if (old) patchMsg(room, id, () => ({ body: old.body, edited: old.edited })); throw e }
    },
    async remove(room, id) {
      await api.remove(room, id)
      patchMsg(room, id, () => ({ type: "deleted", body: "", media: null }))
    },
    /** Toggle one status word on a message. */
    async react(room, id, key) {
      const mine = (get().reactions[id] ?? []).find(r => r.mine && r.key === key)
      if (mine) { await api.unreact(room, mine.id); dropReaction(mine.id); return }
      const r = await api.react(room, id, key)
      addReaction({ id: r.id, target: id, key, sender: get().me, name: "You", mine: true })
    },
    async pin(room, id, on) {
      const r = await api.pin(room, id, on)
      patchConv(room, () => ({ pinned: r.pinned ?? [] }))
    },
    /**
     * Forward a message. Out of or into an encrypted chat the core cannot
     * read it, so this device sends it again, marked as forwarded.
     */
    async forward(room, id, to) {
      if (!isEnc(room) && !isEnc(to)) return api.forward(room, id, to)
      const m = conv(room)?.msgs.find(x => x.id === id)
      if (!m || m.type === "encrypted" || m.type === "deleted") throw new Error("That message cannot be forwarded")
      const forwarded = m.forwarded || (m.mine ? get().myName : m.name)
      if (m.type === "text") return dispatch(to, { type: "text", body: m.body, forwarded })
      if (!m.media?.url) throw new Error("That file has not loaded yet")
      const blob = await (await fetch(m.media.url)).blob()
      const file = new File([blob], m.media.name || "file", { type: m.media.mime || blob.type })
      return dispatch(to, { type: m.type, file, caption: m.body !== m.media.name ? m.body : "", media: m.media, forwarded })
    },
    people: () => api.people(),
    /** Open my direct chat with a person; it joins the list. */
    async directChat(user) {
      const r = await api.dm(user)
      if (!get().rooms.some(x => x.id === r.id)) await get().refreshRooms()
      return r
    },
    /**
     * Ask Tria about one message: a reply to it that mentions @tria and
     * carries its text, so Tria answers in the workspace chat.
     */
    askTria(room, m) {
      const text = snippet(m).slice(0, 3800)
      return get().send(room, `@tria ${m.mine ? "" : (m.tria ? "Tria" : m.name) + ": "}${text}`, m.id)
    },
    /** Search a chat; an encrypted one only on this device, in what it has loaded. */
    async search(room, q) {
      if (!isEnc(room)) return api.search(room, q)
      const needle = q.toLowerCase()
      return { messages: (conv(room)?.msgs ?? []).filter(m => m.type !== "deleted" && m.type !== "encrypted" && snippet(m).toLowerCase().includes(needle)).reverse() }
    },

    /** Tell the others we are typing, at most every 4 s; off when sent or idle. */
    typingOn(room) {
      const now = Date.now()
      if (now - (typingSent[room] ?? 0) < 4000) return
      typingSent[room] = now
      void api.typing(room, true)
    },
    typingOff(room) {
      if (!typingSent[room]) return
      typingSent[room] = 0
      void api.typing(room, false)
    },
  }
})

/** Unread messages across all conversations, for the tab badge. */
export const unreadTotal = (s) => s.rooms.reduce((n, r) => n + (r.unread || 0), 0)

/** Whether one of my messages has been read by anyone else. */
export function readByOthers(c, msgIndex) {
  if (!c) return false
  const order = new Map(c.msgs.map((m, i) => [m.id, i]))
  return Object.values(c.receipts ?? {}).some(id => (order.get(id) ?? -1) >= msgIndex)
}
