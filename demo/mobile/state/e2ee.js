// End-to-end encryption for direct chats (core ADR-093).
//
// This install is a Matrix device with its own keys, made and kept here; the
// core only creates the device and relays what the crypto engine asks the
// homeserver for. The engine is matrix-sdk-crypto-wasm (vendored), its
// store an IndexedDB database sealed with a key that never leaves this
// device.
//
// Trust is cross-signing. A person's first device makes their identity; a
// later device is verified from one they already use by comparing emoji,
// and the other person once, the same way. Room keys go only to devices
// their owner's identity signed. There is no key backup: a lost device
// loses what it held.
import { create } from "../lib/store.js"

/** What the screens show about encryption. */
export const useE2EE = create(() => ({
  status: "off",        // off | starting | ready | failed
  error: "",
  device: "",           // this install's device id
  trusted: null,        // this device is signed by my identity (null: not known yet)
  verification: null,   // the one running: {self, peer, incoming, phase, emoji, confirmed, reason}
}))

/** A send that cannot be encrypted for someone, with why. */
export class KeysProblem extends Error {
  constructor(user, kind) {
    super(kind === "none" ? "they have not opened the messenger since chats became encrypted"
      : kind === "changed" ? "their encryption identity changed; check it with them, then accept it"
      : "this device is not verified yet")
    this.user = user
    this.kind = kind // none | changed | unverified
  }
}

/**
 * The engine with its dependencies, so a test can run two of them against a
 * key server in memory:
 *   load()       → the matrix-sdk-crypto-wasm module, initialised
 *   relay(device, type, body, extra) → the homeserver's reply (core crypto/request)
 *   newDevice(name) → {user, device} (core crypto/device)
 *   storage      → {get(), put(v), clear()} for {user, device}
 *   storeName(device) → the IndexedDB name, undefined for memory
 *   dropStore(device) → deletes that database and its key
 *   storeKey(device) → the secret that seals that database
 *   set(partial) → where the state goes (useE2EE by default)
 */
export function engine(deps) {
  const set = deps.set ?? ((p) => useE2EE.setState(p))
  let trusted = null
  let E = null          // the library
  let machine = null
  let me = null         // {user, device}
  let chain = Promise.resolve()
  let pumping = Promise.resolve()
  let v = null          // the running verification: {req, reqs, sas, self, peer, incoming}
  const listeners = new Set()

  // One crypto conversation with the homeserver at a time: the engine's
  // requests must be sent and marked in order.
  const lock = (fn) => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
  }

  const NAMES = () => ({
    [E.RequestType.KeysUpload]: "keys_upload",
    [E.RequestType.KeysQuery]: "keys_query",
    [E.RequestType.KeysClaim]: "keys_claim",
    [E.RequestType.ToDevice]: "to_device",
    [E.RequestType.SignatureUpload]: "signatures_upload",
  })

  async function send(r) {
    if (!r) return
    const name = NAMES()[r.type]
    if (!name) return // in-room verification and key backup are not used
    const extra = r.type === E.RequestType.ToDevice ? { eventType: r.event_type, txn: r.txn_id } : {}
    const reply = await deps.relay(me.device, name, JSON.parse(r.body), extra)
    if (r.id) await machine.markRequestAsSent(r.id, r.type, JSON.stringify(reply))
  }
  const drain = async () => {
    for (const r of await machine.outgoingRequests()) await send(r)
  }
  const flush = () => lock(drain)
  const uid = (u) => new E.UserId(u)

  async function bootstrap() {
    const b = await machine.bootstrapCrossSigning(true)
    if (b.uploadKeysRequest) await send(b.uploadKeysRequest)
    await deps.relay(me.device, "signing_keys_upload", JSON.parse(b.uploadSigningKeysRequest.body))
    await send(b.uploadSignaturesRequest)
  }

  /** Learns my identity and whether it signed this device; the first device makes it. */
  async function settle() {
    await lock(async () => {
      await machine.updateTrackedUsers([uid(me.user)])
      await drain()
      const st = await machine.crossSigningStatus()
      if (st.hasMaster && st.hasSelfSigning && st.hasUserSigning) return
      if (await machine.getIdentity(uid(me.user))) return
      await bootstrap()
      // Learn the identity and this device's signature back from the server.
      await machine.markAllTrackedUsersAsDirty()
      await drain()
    })
    const dev = await machine.getDevice(uid(me.user), new E.DeviceId(me.device))
    trusted = !!dev?.isCrossSignedByOwner()
    set({ trusted })
    if (trusted) {
      // A verified device asks my other devices for the signing keys, so it
      // can verify people itself.
      await machine.requestMissingSecretsIfNeeded()
      await flush()
    }
  }

  const api = {
    get ready() { return !!machine },
    get user() { return me?.user ?? "" },
    get device() { return me?.device ?? "" },
    get trusted() { return trusted },

    /** Starts this install's device for user, making it on first use. */
    async start(user, name) {
      if (machine && me?.user === user) return me
      set({ status: "starting", error: "" })
      try {
        E ??= await deps.load()
        let s = deps.storage.get()
        if (!s || s.user !== user) {
          const d = await deps.newDevice(name)
          s = { user: d.user, device: d.device }
          deps.storage.put(s)
        }
        me = s
        const store = deps.storeName?.(s.device)
        machine = await E.OlmMachine.initialize(uid(s.user), new E.DeviceId(s.device), store, store ? await deps.storeKey(s.device) : undefined)
        await flush()
        await settle()
        set({ status: "ready", device: s.device })
        return s
      } catch (e) {
        set({ status: "failed", error: e?.message ?? String(e) })
        throw e
      }
    },

    /** The homeserver no longer knows this device: everything here is dropped. */
    async forget() {
      const d = me?.device
      try { machine?.close() } catch { /* already closed */ }
      machine = null
      me = null
      v = null
      trusted = null
      deps.storage.clear()
      if (d) await deps.dropStore?.(d)
      set({ status: "off", device: "", trusted: null, verification: null })
    },

    /** A sync's crypto part: to-device messages, device changes, key counts. */
    async receive(f) {
      if (!machine) return
      const processed = await lock(async () => {
        const lists = new E.DeviceLists((f.changed ?? []).map(uid), (f.left ?? []).map(uid))
        const out = await machine.receiveSyncChanges(JSON.stringify(f.toDevice ?? []), lists,
          new Map(Object.entries(f.oneTimeKeys ?? {})), f.fallback ? new Set(f.fallback) : undefined)
        await drain()
        return out
      })
      const requests = (processed ?? []).map((ev) => {
        try { return JSON.parse(ev.rawEvent ?? "null") } catch { return null }
      }).filter(raw => raw?.type === "m.key.verification.request" && raw.content?.transaction_id)
      const find = (raw) => machine.getVerificationRequest(uid(raw.sender), raw.content.transaction_id)
      // A request from a device the engine had not seen yet is dropped; its
      // keys came in the same sync and are known now, so it goes in again.
      const unknown = requests.filter(raw => !find(raw))
      if (unknown.length) {
        await lock(async () => {
          await machine.receiveSyncChanges(JSON.stringify(unknown), new E.DeviceLists(), new Map(), undefined)
          await drain()
        })
      }
      for (const raw of requests) {
        const req = find(raw)
        if (req && !req.weStarted() && !v) track({ req, self: raw.sender === me.user, peer: raw.sender, incoming: true })
      }
      if (v) await pump()
      if (f.toDevice?.length) for (const l of listeners) l()
    },

    /** Called after room keys may have arrived (to retry what could not be read). */
    onKeys(l) { listeners.add(l); return () => listeners.delete(l) },

    /** {type, content, warn} of an encrypted room event, or null when its key is missing. */
    async decrypt(ev) {
      if (!machine || !ev) return null
      try {
        const r = await machine.decryptRoomEvent(JSON.stringify(ev), new E.RoomId(ev.room_id),
          new E.DecryptionSettings(E.TrustRequirement.Untrusted))
        const out = JSON.parse(r.event)
        return { type: out.type, content: out.content, sender: r.sender.toString(), warn: r.shieldState(false).color === E.ShieldColor.Red }
      } catch {
        return null
      }
    },

    /** The m.room.encrypted content of one event for a room shared by users. */
    async encrypt(room, users, type, content) {
      if (!machine) throw new Error("encryption is not ready on this device")
      if (trusted === false) throw new KeysProblem(me.user, "unverified")
      // The engine takes ownership of the ids passed to it, so each call
      // gets its own.
      const ids = () => users.map(uid)
      return lock(async () => {
        await machine.updateTrackedUsers(ids())
        await drain()
        for (const u of users) {
          if (u === me.user) continue
          const id = await machine.getIdentity(uid(u))
          if (!id) throw new KeysProblem(u, "none")
          if (id.hasVerificationViolation() || id.identityNeedsUserApproval()) throw new KeysProblem(u, "changed")
        }
        await send(await machine.getMissingSessions(ids()))
        const settings = new E.EncryptionSettings()
        settings.sharingStrategy = E.CollectStrategy.identityBasedStrategy()
        for (const r of await machine.shareRoomKey(new E.RoomId(room), ids(), settings)) await send(r)
        return JSON.parse(await machine.encryptRoomEvent(new E.RoomId(room), type, JSON.stringify(content)))
      })
    },

    /** Encrypts a file's bytes: {data, file} where file is the event's key info (no url yet). */
    encryptFile(bytes) {
      const a = E.Attachment.encrypt(bytes)
      const file = JSON.parse(a.mediaEncryptionInfo)
      return { data: a.encryptedData, file }
    },
    /** The plain bytes of a downloaded encrypted file. */
    decryptFile(data, file) {
      const { url: _, mimetype: __, ...info } = file
      return E.Attachment.decrypt(new E.EncryptedAttachment(data, JSON.stringify(info)))
    },

    /** none | unverified | verified | changed: where the other person's identity stands. */
    async peer(user) {
      if (!machine) return "none"
      await lock(async () => { await machine.updateTrackedUsers([uid(user)]); await drain() })
      const id = await machine.getIdentity(uid(user))
      if (!id) return "none"
      if (id.hasVerificationViolation() || id.identityNeedsUserApproval()) return "changed"
      return id.isVerified() ? "verified" : "unverified"
    },
    /** Accepts the other person's new identity after it changed. */
    async acceptPeer(user) {
      const id = await machine.getIdentity(uid(user))
      if (!id) return
      if (id.hasVerificationViolation()) await id.withdrawVerification()
      if (id.identityNeedsUserApproval()) await id.pinCurrentMasterKey()
    },

    /** Asks my other devices to verify this one. */
    async verifySelf() {
      const own = await machine.getIdentity(uid(me.user))
      if (!own) throw new Error("no identity to verify against")
      const [req, out] = await own.requestVerification([E.VerificationMethod.SasV1])
      await lock(() => send(out))
      track({ req, self: true, peer: me.user, incoming: false })
    },
    /** Asks the other person's devices to verify them. */
    async verifyPeer(user) {
      const devices = (await machine.getUserDevices(uid(user))).devices().filter(d => d.isCrossSignedByOwner())
      if (!devices.length) throw new KeysProblem(user, "none")
      const reqs = []
      for (const d of devices) {
        const [req, out] = d.requestVerification([E.VerificationMethod.SasV1])
        await lock(() => send(out))
        reqs.push(req)
      }
      track({ reqs, self: false, peer: user, incoming: false })
    },
    /** Answers an incoming request. */
    async accept() {
      if (!v?.req) return
      await lock(() => send(v.req.accept()))
      await pump()
    },
    /** The emoji match: this side confirms. */
    async confirm() {
      if (!v?.sas) return
      const reqs = await v.sas.confirm()
      await lock(async () => { for (const r of reqs) await send(r) })
      await pump()
    },
    /** The emoji differ, or the person stops. */
    async cancel(mismatch) {
      if (!v) return
      const out = v.sas && mismatch ? v.sas.cancelWithCode("m.mismatched_sas") : (v.sas ?? v.req)?.cancel()
      for (const r of v.reqs ?? []) if (r !== v.req) await lock(() => send(r.cancel()))
      await lock(() => send(out))
      v = null
      set({ verification: null })
    },
    dismiss() { v = null; set({ verification: null }) },

    /** Makes a new identity (every device and person must verify again). */
    async startOver() {
      await lock(bootstrap)
      await settle()
    },
  }

  function track(nv) {
    v = nv
    for (const r of nv.reqs ?? [nv.req]) r.registerChangesCallback(async () => { await pump() })
    void pump()
  }

  // Moves the verification on as far as this side can, and shows where it is.
  function pump() {
    pumping = pumping.then(step, step)
    return pumping
  }
  async function step() {
    if (!v) return
    // Asked of several devices: the first that answers is the one; the
    // others are called off.
    if (!v.req) {
      const ready = v.reqs.find(r => r.isReady())
      if (ready) {
        v.req = ready
        for (const r of v.reqs) if (r !== ready) await lock(() => send(r.cancel()))
      } else if (v.reqs.every(r => r.isCancelled())) {
        set({ verification: { ...view(), phase: "cancelled", reason: v.reqs[0].cancelInfo?.reason ?? "" } })
        return
      } else {
        set({ verification: { ...view(), phase: "requested" } })
        return
      }
    }
    const req = v.req
    if (!v.sas) {
      const s = req.getVerification()
      if (s instanceof E.Sas) v.sas = s
      else if (req.isReady() && req.weStarted()) {
        const r = await req.startSas()
        if (r) { v.sas = r[0]; await lock(() => send(r[1])) }
      }
      if (v.sas) {
        v.sas.registerChangesCallback(async () => { await pump() })
        if (!v.sas.weStarted() && !v.sas.hasBeenAccepted()) await lock(() => send(v.sas.accept()))
      }
    }
    const s = v.sas
    if (req.isCancelled() || s?.isCancelled()) {
      set({ verification: { ...view(), phase: "cancelled", reason: (s?.cancelInfo() ?? req.cancelInfo)?.reason ?? "" } })
      return
    }
    if (req.isDone() || s?.isDone()) {
      set({ verification: { ...view(), phase: "done" } })
      // This device was verified: learn its new signature, then ask for
      // the signing keys.
      if (v.self && !v.incoming) {
        machine.markAllTrackedUsersAsDirty()
        await settle()
      }
      return
    }
    const emoji = s?.canBePresented() ? (s.emoji() ?? []).map(e => ({ symbol: e.symbol, description: e.description })) : null
    const phase = emoji ? "emoji" : v.incoming && req.phase() === E.VerificationRequestPhase.Requested ? "incoming" : "waiting"
    set({ verification: { ...view(), phase, emoji, confirmed: !!s?.haveWeConfirmed() } })
  }
  const view = () => ({ self: v.self, peer: v.peer, incoming: v.incoming, emoji: null, confirmed: false, reason: "" })

  return api
}
