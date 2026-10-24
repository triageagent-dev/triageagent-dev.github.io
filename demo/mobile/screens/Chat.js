import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "../vendor/preact-htm.js"
import { current, useStore } from "../state/store.js"
import { readByOthers, useMessenger } from "../state/messenger.js"
import { useE2EE } from "../state/e2ee.js"
import { e2ee, saveInApp } from "../state/e2ee-app.js"
import { Tap } from "../components/ui.js"
import { Icon, TriageMark } from "../components/Icon.js"
import { Photo } from "../components/Photo.js"
import { Md } from "../components/Md.js"
import { avatarColor, charsNote, clock, dayLabel, fileSize, groupReactions, layout, MAX_TEXT, mentionAt, nameColor, reactionStyle, snippet } from "../model/chat.js"

const LONG_PRESS_MS = 420
const SEV = { critical: "var(--bad-text)", warning: "#e0a030" }
const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches

/** One workspace conversation, Telegram-style. */
export function Chat() {
  const roomId = useStore(s => current(s).roomId)
  const roomName = useStore(s => current(s).roomName)
  const navigate = useStore(s => s.navigate)
  const back = useStore(s => s.back)
  const hi = useStore(s => s.hi)
  const c = useMessenger(s => s.convs[roomId])
  const reactions = useMessenger(s => s.reactions)
  const reactionList = useMessenger(s => s.reactionList)
  const typing = useMessenger(s => s.typing[roomId])
  const status = useMessenger(s => s.status)
  const rooms = useMessenger(s => s.rooms)
  const M = useMessenger.getState

  const [text, setText] = useState("")
  const [replyTo, setReplyTo] = useState(null)
  const [editing, setEditing] = useState(null)
  const [sheet, setSheet] = useState(null)       // the message whose menu is open
  const [confirmDel, setConfirmDel] = useState(false)
  const [forwardOf, setForwardOf] = useState(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const [viewer, setViewer] = useState(null)
  const [search, setSearch] = useState(null)     // null = closed, else {q, results, busy}
  const [hl, setHl] = useState("")
  const [atBottom, setAtBottom] = useState(true)
  const [below, setBelow] = useState(0)
  const [mention, setMention] = useState(null)
  const [toast, setToast] = useState("")
  const [startOver, setStartOver] = useState(false)
  const e2Status = useE2EE(s => s.status)
  const e2Error = useE2EE(s => s.error)
  const e2Trusted = useE2EE(s => s.trusted)
  const trust = useMessenger(s => s.trust[roomId])

  const listRef = useRef(null)
  const inputRef = useRef(null)
  const fileRef = useRef(null)
  const camRef = useRef(null)
  const edges = useRef({ first: "", last: "", height: 0, loadingOlder: false })
  const press = useRef(null)

  useEffect(() => {
    if (!roomId) return
    M().start()
    M().open(roomId)
    return () => { M().typingOff(roomId); M().close(roomId) }
  }, [roomId])

  const msgs = c?.msgs ?? []
  const rows = useMemo(() => layout(msgs), [msgs])
  const index = useMemo(() => new Map(msgs.map((m, i) => [m.id, i])), [msgs])
  const byId = useMemo(() => new Map(msgs.map(m => [m.id, m])), [msgs])
  const members = c?.members ?? {}
  const avatars = c?.avatars ?? {}
  const photoOf = (name) => { const id = Object.keys(members).find(k => members[k] === name); return id ? avatars[id] : "" }
  const meta = rooms.find(r => r.id === roomId)
  const isDM = meta?.kind === "dm"
  const title = roomName || meta?.name || "Chat"
  const enc = !!(meta?.encrypted || c?.encrypted)

  // Where the other person's identity stands, once this device can tell.
  useEffect(() => { if (enc && e2Status === "ready") void M().checkTrust(roomId) }, [enc, e2Status, e2Trusted, roomId])

  const flash = (t) => { setToast(t); setTimeout(() => setToast(""), 2400) }

  // Keep the view where the reader is: pinned to the bottom for new
  // messages, still for older ones loaded above.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const first = msgs[0]?.id ?? "", last = msgs.at(-1)?.id ?? ""
    const e = edges.current
    if (e.loadingOlder && first !== e.first) {
      el.scrollTop += el.scrollHeight - e.height
      e.loadingOlder = false
    } else if (last !== e.last) {
      const newest = msgs.at(-1)
      if (atBottom || !e.last || newest?.mine) el.scrollTop = el.scrollHeight
      else setBelow(n => n + 1)
    }
    e.first = first; e.last = last
  }, [msgs])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (bottom !== atBottom) setAtBottom(bottom)
    if (bottom && below) setBelow(0)
    if (el.scrollTop < 150 && c && !c.done && !c.loading) {
      edges.current.loadingOlder = true
      edges.current.height = el.scrollHeight
      void M().older(roomId)
    }
  }
  const toBottom = () => { const el = listRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); setBelow(0) }

  const jumpTo = (id) => {
    const el = listRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`)
    if (!el) { flash("That message is further back than what is loaded"); return }
    el.scrollIntoView({ block: "center", behavior: "smooth" })
    setHl(id)
    setTimeout(() => setHl(""), 1600)
  }

  // ── composer ──────────────────────────────────────────────────────────
  const grow = () => { const t = inputRef.current; if (t) { t.style.height = "auto"; t.style.height = Math.min(140, t.scrollHeight) + "px" } }
  const onInput = (e) => {
    const v = e.currentTarget.value
    setText(v)
    grow()
    if (v.trim()) M().typingOn(roomId)
    setMention(mentionAt(v, e.currentTarget.selectionStart ?? v.length))
  }
  const candidates = useMemo(() => {
    if (!mention) return []
    const names = [...(isDM ? [] : ["Tria"]), ...Object.values(members).filter(n => n && n !== "Tria")]
    return [...new Set(names)].filter(n => n.toLowerCase().startsWith(mention.query)).slice(0, 6)
  }, [mention, members])
  const pickMention = (name) => {
    const v = text, at = mention.start
    const caret = inputRef.current?.selectionStart ?? v.length
    const word = name === "Tria" ? "tria" : name.replace(/\s+/g, "")
    const next = v.slice(0, at) + "@" + word + " " + v.slice(caret)
    setText(next)
    setMention(null)
    requestAnimationFrame(() => { const t = inputRef.current; if (t) { t.focus(); const p = at + word.length + 2; t.setSelectionRange(p, p) } })
  }

  const submit = async () => {
    const t = text.trim()
    if (!t) return
    if (editing) {
      const m = editing
      setEditing(null); setText(""); requestAnimationFrame(grow)
      if (t !== m.body) M().edit(roomId, m.id, t).catch(e => flash(e.message))
      return
    }
    const rt = replyTo?.id
    setText(""); setReplyTo(null); setMention(null)
    requestAnimationFrame(grow)
    setAtBottom(true)
    await M().send(roomId, t, rt)
  }
  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); void submit() }
    if (e.key === "Escape") { setEditing(null); setReplyTo(null) }
  }
  const onFiles = (e) => {
    const files = [...(e.currentTarget.files ?? [])]
    e.currentTarget.value = ""
    setAttachOpen(false)
    const rt = replyTo?.id
    setReplyTo(null)
    setAtBottom(true)
    for (const f of files) M().attach(roomId, f, { replyTo: rt }).catch(e => flash(e.message))
  }

  // ── message menu ─────────────────────────────────────────────────────
  const openMenu = (m) => { setConfirmDel(false); setSheet(m) }
  const pressStart = (m, e) => {
    if (e.button && e.button !== 0) return
    clearTimeout(press.current)
    press.current = setTimeout(() => { press.current = null; navigator.vibrate?.(12); openMenu(m) }, LONG_PRESS_MS)
  }
  const pressEnd = () => { clearTimeout(press.current); press.current = null }
  const act = async (fn) => { const m = sheet; setSheet(null); try { await fn(m) } catch (e) { flash(e.message) } }

  const pinnedId = c?.pinned?.[0]
  const pinned = pinnedId ? byId.get(pinnedId) : null
  const typingNow = (typing ?? []).filter(Boolean)
  const subtitle = typingNow.length ? `${typingNow.join(", ")} typing…`
    : status !== "live" ? "connecting…"
    : enc ? (trust === "verified" ? "end-to-end encrypted · verified" : "end-to-end encrypted")
    : isDM ? (meta?.earlier ? "earlier chat · not encrypted" : "private chat · not encrypted")
    : `${Object.keys(members).length || "…"} members`

  // What an encrypted chat needs before it can be read and written here.
  const safe = (fn) => () => { Promise.resolve().then(fn).catch(e => flash(e.message)) }
  const toEncrypted = safe(async () => {
    const r = await M().directChat(meta.peer)
    navigate({ screen: "chat", roomId: r.id, roomName: r.name })
  })
  const bar = isDM && !enc ? {
      text: meta?.earlier ? "An earlier chat, from before chats were encrypted." : `This chat is not end-to-end encrypted. Start an encrypted chat with ${title}; this one stays as an earlier chat.`,
      acts: [[meta?.earlier ? "Open the encrypted chat" : "Start", toEncrypted]],
    }
    : !enc ? null
    : e2Status === "failed" ? { text: `Encryption could not start on this device: ${e2Error}` }
    : e2Status !== "ready" ? { text: "Setting up encryption on this device…" }
    : e2Trusted === false && startOver ? {
      text: "Starting over makes a new identity. Your other devices and the people you chat with will be asked to verify you again, and this device cannot read older encrypted messages.",
      acts: [["Start over", safe(async () => { await e2ee.startOver(); setStartOver(false) })], ["Cancel", () => setStartOver(false)]],
    }
    : e2Trusted === false ? {
      text: "Verify this device from one you already use, to read and write encrypted chats.",
      acts: [["Verify", safe(() => e2ee.verifySelf())], ["Start over", () => setStartOver(true)]],
    }
    : trust === "none" ? { text: `${title} has not opened the messenger since chats became encrypted. Once they do, you can write here.` }
    : trust === "changed" ? { text: `${title}'s encryption identity changed. Check with them that it was them, then accept it.`, acts: [["Accept", safe(() => M().acceptIdentity(roomId))]] }
    : trust === "unverified" ? { text: `Compare emoji with ${title} once, to be sure nobody else reads this chat.`, acts: [["Verify", safe(() => M().verifyPeer(roomId))]] }
    : null
  const blocked = enc && (e2Status !== "ready" || e2Trusted === false || trust === "none" || trust === "changed")

  const doSearch = async (q) => {
    setSearch({ q, results: null, busy: true })
    try { const r = await M().search(roomId, q); setSearch({ q, results: r.messages ?? [], busy: false }) }
    catch (e) { setSearch({ q, results: [], busy: false, err: e.message }) }
  }

  return html`
    <div class="cs">
      <div class="cs-head">
        <${Tap} label="Back" onClick=${() => (hi > 0 ? back() : navigate({ screen: "chats" }))} style=${{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 -4px" }}>
          <${Icon} name="arrow-left" size=${20} color="var(--text-body)" />
        <//>
        ${search ? html`
          <form class="grow row" style=${{ gap: 8 }} onSubmit=${(e) => { e.preventDefault(); const q = e.currentTarget.q.value.trim(); if (q) void doSearch(q) }}>
            <input name="q" autoFocus placeholder="Search this chat" enterkeyhint="search" style=${{ flex: 1, minWidth: 0, height: 36, padding: "0 12px", borderRadius: 10, border: "1px solid var(--input-line)", background: "var(--well)", color: "var(--text)", fontSize: 14 }} />
          </form>
          <${Tap} label="Close search" onClick=${() => setSearch(null)} style=${{ padding: 6 }}><${Icon} name="x" size=${18} color="var(--text2)" /><//>
        ` : html`
          <${Photo} src=${isDM ? meta?.avatar : ""} name=${title} size=${36} color=${avatarColor(isDM ? meta.peer : meta?.workspace ?? title)} square=${!isDM} />
          <div class="grow col" style=${{ gap: 1, minWidth: 0 }}>
            <span class="ellip" style=${{ fontSize: 16, fontWeight: 500 }}>${title}</span>
            <span class="ellip row" style=${{ gap: 4, fontSize: 12, color: typingNow.length ? "var(--accent)" : "var(--muted)" }}>${enc && !typingNow.length && html`<${Icon} name=${trust === "verified" ? "shield-check" : "lock"} size=${12} color=${trust === "verified" ? "var(--ok-text)" : "var(--muted)"} />`}${subtitle}</span>
          </div>
          <${Tap} label="Search" onClick=${() => setSearch({ q: "", results: null })} style=${{ padding: 6 }}><${Icon} name="magnifying-glass" size=${19} color="var(--text2)" /><//>
        `}
      </div>

      ${bar && !search && html`
        <div class="cs-e2ee">
          <${Icon} name=${trust === "changed" ? "warning" : "lock"} size=${16} color=${trust === "changed" ? "var(--bad-text)" : "var(--accent)"} />
          <span class="grow">${bar.text}</span>
          ${(bar.acts ?? []).map(([label, fn]) => html`<${Tap} key=${label} className="act" onClick=${fn}>${label}<//>`)}
        </div>
      `}
      ${pinned && !search && html`
        <${Tap} className="cs-pin" onClick=${() => jumpTo(pinned.id)}>
          <${Icon} name="push-pin" size=${15} color="var(--accent)" />
          <div class="grow col" style=${{ minWidth: 0, textAlign: "left" }}>
            <span style=${{ fontSize: 11.5, color: "var(--accent)" }}>Pinned message</span>
            <span class="ellip" style=${{ color: "var(--text2)" }}>${snippet(pinned)}</span>
          </div>
        <//>
      `}

      ${search?.results && html`
        <div class="cs-list" style=${{ flex: "0 1 auto", maxHeight: "45%", borderBottom: "1px solid var(--line2)" }}>
          ${search.err && html`<span style=${{ fontSize: 12.5, color: "var(--bad-text)", padding: 8 }}>${search.err}</span>`}
          ${!search.results.length && !search.err && html`<span style=${{ fontSize: 12.5, color: "var(--muted)", padding: 8 }}>Nothing found for “${search.q}”.</span>`}
          ${search.results.map(m => html`
            <${Tap} key=${m.id} onClick=${() => { setSearch(null); jumpTo(m.id) }} style=${{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 6px", textAlign: "left", borderBottom: "1px solid var(--line2)" }}>
              <span style=${{ fontSize: 12, color: "var(--muted)" }}>${m.mine ? "You" : m.name} · ${dayLabel(m.ts)} ${clock(m.ts)}</span>
              <span class="clamp2" style=${{ fontSize: 13.5 }}>${snippet(m)}</span>
            <//>
          `)}
        </div>
      `}

      <div class="cs-list" ref=${listRef} onScroll=${onScroll} data-swipe="x">
        ${c?.loading && html`<span style=${{ alignSelf: "center", fontSize: 12, color: "var(--muted)", padding: 8 }}>loading…</span>`}
        ${c?.done && msgs.length > 0 && html`<span style=${{ alignSelf: "center", fontSize: 11.5, color: "var(--muted2)", padding: "4px 0 8px" }}>Start of the conversation</span>`}
        ${c?.err && !c.loading && html`
          <div style=${{ alignSelf: "center", marginTop: msgs.length ? 0 : 40, textAlign: "center", fontSize: 13, lineHeight: 1.5, color: "var(--bad-text)", padding: 8 }}>
            Couldn't load the conversation: ${c.err}
            <div><${Tap} onClick=${() => useMessenger.getState().older(roomId, !msgs.length)} style=${{ color: "var(--accent)", padding: 6 }}>Retry<//></div>
          </div>
        `}
        ${c && !c.loading && !c.err && !msgs.length && html`
          <div class="empty" style=${{ alignSelf: "center", marginTop: 40, textAlign: "center", fontSize: 13, lineHeight: 1.5 }}>
            ${isDM ? html`No messages yet. Only the two of you can read this chat.` : html`No messages yet.<br />Write to the workspace; <b>@tria</b> asks Tria, who answers here for everyone.`}
          </div>
        `}
        ${rows.map(row => row.day
          ? html`<span key=${row.key} class="cs-day">${dayLabel(row.day)}</span>`
          : html`<${Bubble} key=${row.key} m=${row.m} first=${row.first} hl=${hl === row.m.id}
              face=${!isDM && !row.m.mine ? { src: row.m.tria ? "" : avatars[row.m.sender], tria: row.m.tria } : null}
              quote=${row.m.replyTo ? byId.get(row.m.replyTo) ?? { missing: true } : null}
              reactions=${groupReactions(reactions[row.m.id], reactionList)}
              read=${row.m.mine && readByOthers(c, index.get(row.m.id))}
              onPress=${pressStart} onRelease=${pressEnd} onMenu=${openMenu}
              onQuote=${jumpTo} onImage=${setViewer}
              onReact=${(key) => M().react(roomId, row.m.id, key).catch(e => flash(e.message))}
              onRetry=${() => openMenu(row.m)} />`)}
      </div>

      ${!atBottom && html`
        <${Tap} className="cs-jump" label="Jump to the latest" onClick=${toBottom}>
          <${Icon} name="arrow-down" size=${20} color="var(--text-body)" />
          ${below > 0 && html`<span class="cs-badge" style=${{ position: "absolute", top: -6, right: -4 }}>${below}</span>`}
        <//>
      `}

      <div class="cs-comp">
        ${candidates.length > 0 && html`
          <div class="col" style=${{ background: "var(--surface)", borderRadius: 10, overflow: "hidden" }}>
            ${candidates.map(n => html`
              <${Tap} key=${n} onClick=${() => pickMention(n)} className="tap-bg" style=${{ display: "flex", gap: 10, alignItems: "center", padding: "8px 12px", textAlign: "left" }}>
                <${Photo} src=${n === "Tria" ? "" : photoOf(n)} name=${n} size=${26} color=${n === "Tria" ? "var(--accent-deep)" : avatarColor(n)} />
                <span style=${{ fontSize: 14 }}>${n}</span>
                ${n === "Tria" && html`<span style=${{ fontSize: 11.5, color: "var(--muted)" }}>answers here for everyone</span>`}
              <//>
            `)}
          </div>
        `}
        ${(replyTo || editing) && html`
          <div class="row" style=${{ gap: 10, padding: "2px 4px" }}>
            <${Icon} name=${editing ? "pen" : "arrow-bend-up-left"} size=${18} color="var(--accent)" />
            <div class="grow col" style=${{ minWidth: 0, borderLeft: "2px solid var(--accent-line)", paddingLeft: 8 }}>
              <span style=${{ fontSize: 12, color: "var(--accent)" }}>${editing ? "Editing" : `Reply to ${replyTo.mine ? "yourself" : replyTo.name}`}</span>
              <span class="ellip" style=${{ fontSize: 12.5, color: "var(--text2)" }}>${snippet(editing ?? replyTo)}</span>
            </div>
            <${Tap} label="Cancel" onClick=${() => { if (editing) setText(""); setEditing(null); setReplyTo(null) }} style=${{ padding: 6 }}><${Icon} name="x" size=${16} color="var(--muted)" /><//>
          </div>
        `}
        ${(() => { const n = charsNote(text.length); return n && html`<div style=${{ textAlign: "right", padding: "0 16px 2px", fontSize: 11.5, color: { crit: "var(--bad-text)", warn: "#e0a030", faint: "var(--muted)" }[n.level] }}>${n.text}</div>` })()}
        <div class="row" style=${{ gap: 6, alignItems: "flex-end" }}>
          ${!editing && !blocked && html`<${Tap} className="cs-icon" label="Attach" onClick=${() => setAttachOpen(true)}><${Icon} name="paperclip" size=${22} color="var(--text2)" /><//>`}
          <textarea ref=${inputRef} class="cs-input" rows="1" maxLength=${MAX_TEXT} value=${text} onInput=${onInput} onKeyDown=${onKey} disabled=${blocked}
            onBlur=${() => M().typingOff(roomId)} placeholder=${blocked ? "Encrypted chat: not ready on this device" : editing ? "Edit message" : "Message"} />
          <${Tap} className="cs-icon" label=${editing ? "Save" : "Send"} onClick=${() => void submit()}
            style=${{ background: text.trim() ? "var(--accent-deep)" : "transparent", opacity: text.trim() ? 1 : 0.5 }}>
            <${Icon} name=${editing ? "check" : "paper-plane-right"} size=${20} weight="fill" color=${text.trim() ? "var(--text-strong)" : "var(--muted)"} />
          <//>
        </div>
        <input ref=${fileRef} type="file" multiple style=${{ display: "none" }} onChange=${onFiles} />
        <input ref=${camRef} type="file" accept="image/*" capture="environment" style=${{ display: "none" }} onChange=${onFiles} />
      </div>

      ${attachOpen && html`
        <div class="cs-sheet-back" onClick=${() => setAttachOpen(false)}>
          <div class="cs-sheet" onClick=${e => e.stopPropagation()}>
            <${Tap} className="cs-sheet-row tap-bg" onClick=${() => { fileRef.current.accept = "image/*"; fileRef.current.click() }}><${Icon} name="image" size=${22} color="var(--accent)" />Photo<//>
            <${Tap} className="cs-sheet-row tap-bg" onClick=${() => camRef.current.click()}><${Icon} name="camera" size=${22} color="var(--accent)" />Camera<//>
            <${Tap} className="cs-sheet-row tap-bg" onClick=${() => { fileRef.current.accept = ""; fileRef.current.click() }}><${Icon} name="file" size=${22} color="var(--accent)" />File<//>
          </div>
        </div>
      `}

      ${sheet && html`
        <div class="cs-sheet-back" onClick=${() => setSheet(null)}>
          <div class="cs-sheet" onClick=${e => e.stopPropagation()}>
            ${!sheet.local && sheet.type !== "deleted" && html`
              <div class="row" style=${{ justifyContent: "space-around", padding: "8px 10px 12px", borderBottom: "1px solid var(--line2)" }}>
                ${reactionList.map(k => {
                  const mine = (reactions[sheet.id] ?? []).some(r => r.mine && r.key === k)
                  const st = reactionStyle(k)
                  return html`<${Tap} key=${k} label=${k} onClick=${() => act(m => M().react(roomId, m.id, k))}
                    style=${{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, width: 64 }}>
                    <span style=${{ width: 44, height: 44, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center",
                      background: mine ? "var(--accent-deep)" : "var(--surface3)" }}>
                      <${Icon} name=${st.icon} size=${24} weight="fill" color=${mine ? "var(--text-strong)" : st.color} />
                    </span>
                    <span style=${{ fontSize: 10.5, color: "var(--muted)", textAlign: "center", lineHeight: 1.2 }}>${k}</span>
                  <//>`
                })}
              </div>
            `}
            ${sheet.failed && html`
              <${Row} icon="arrow-clockwise" label="Resend" onClick=${() => act(m => M().deliver(roomId, m.id))} />
              <${Row} icon="trash" label="Discard" danger onClick=${() => act(m => M().discard(roomId, m.id))} />
            `}
            ${!sheet.local && sheet.type !== "deleted" && html`
              <${Row} icon="arrow-bend-up-left" label="Reply" onClick=${() => act(m => { setEditing(null); setReplyTo(m); inputRef.current?.focus() })} />
              ${sheet.mine && sheet.type === "text" && html`<${Row} icon="pen" label="Edit" onClick=${() => act(m => { setReplyTo(null); setEditing(m); setText(m.body); requestAnimationFrame(() => { grow(); inputRef.current?.focus() }) })} />`}
              ${sheet.body && html`<${Row} icon="copy" label="Copy text" onClick=${() => act(async m => { await navigator.clipboard?.writeText(m.body); flash("Copied") })} />`}
              ${rooms.length > 1 && sheet.type !== "encrypted" && html`<${Row} icon="share" label="Forward" onClick=${() => act(m => setForwardOf(m))} />`}
              ${!isDM && sheet.type !== "encrypted" && html`<${Row} icon="chat-circle-dots" label="Ask Tria" onClick=${() => act(m => { setAtBottom(true); return M().askTria(roomId, m) })} />`}
              ${sheet.issue && html`<${Row} icon="warning" label="Open the issue" onClick=${() => act(m => navigate({ screen: "issue", incId: m.issue }))} />`}
              ${c?.canWrite && html`<${Row} icon="push-pin" label=${pinnedId === sheet.id || c?.pinned?.includes(sheet.id) ? "Unpin" : "Pin"}
                onClick=${() => act(m => M().pin(roomId, m.id, !c.pinned.includes(m.id)))} />`}
              ${(sheet.mine || c?.canWrite) && (confirmDel
                ? html`<${Row} icon="trash" label="Delete for everyone?" danger onClick=${() => act(m => M().remove(roomId, m.id))} />`
                : html`<${Row} icon="trash" label="Delete" danger onClick=${() => setConfirmDel(true)} />`)}
            `}
            <div style=${{ padding: "6px 20px 0", fontSize: 11.5, color: "var(--muted)" }}>${sheet.mine ? "You" : sheet.name} · ${dayLabel(sheet.ts)} ${clock(sheet.ts)}${sheet.edited ? " · edited" : ""}</div>
          </div>
        </div>
      `}

      ${forwardOf && html`
        <div class="cs-sheet-back" onClick=${() => setForwardOf(null)}>
          <div class="cs-sheet" onClick=${e => e.stopPropagation()}>
            <div style=${{ padding: "8px 20px", fontSize: 13, color: "var(--muted)" }}>Forward to</div>
            ${rooms.filter(r => r.id !== roomId).map(r => html`
              <${Tap} key=${r.id} className="cs-sheet-row tap-bg" onClick=${async () => {
                const m = forwardOf
                setForwardOf(null)
                try { await M().forward(roomId, m.id, r.id); flash(`Forwarded to ${r.name}`) } catch (e) { flash(e.message) }
              }}>
                <span class="cs-ava" style=${{ width: 30, height: 30, fontSize: 13, background: avatarColor(r.workspace) }}>${r.name.slice(0, 1).toUpperCase()}</span>${r.name}
              <//>
            `)}
          </div>
        </div>
      `}

      ${viewer && html`
        <div class="cs-viewer" onClick=${() => setViewer(null)}>
          <div class="row" style=${{ padding: "calc(env(safe-area-inset-top, 0px) + 10px) 12px 10px", gap: 10 }} onClick=${e => e.stopPropagation()}>
            <${Tap} label="Close" onClick=${() => setViewer(null)} style=${{ padding: 6 }}><${Icon} name="x" size=${22} color="#fff" /><//>
            <span class="grow ellip" style=${{ color: "#ddd", fontSize: 13 }}>${viewer.name}</span>
            <a href=${viewer.url + (viewer.url.startsWith("/") ? "?download=1" : "")} download=${viewer.name} style=${{ padding: 6 }} onClick=${e => { e.stopPropagation(); saveInApp(e, viewer.url, viewer.name, viewer.mime) }}><${Icon} name="download-simple" size=${22} color="#fff" /></a>
          </div>
          <div class="grow" style=${{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
            <img src=${viewer.url} alt=${viewer.name} style=${{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          </div>
        </div>
      `}

      ${toast && html`<div style=${{ position: "absolute", left: "50%", bottom: 96, transform: "translateX(-50%)", background: "var(--surface3)", padding: "8px 14px", borderRadius: 10, fontSize: 13, zIndex: 50, boxShadow: "0 4px 14px rgba(0,0,0,.4)" }}>${toast}</div>`}
    </div>
  `
}

function Row({ icon, label, onClick, danger }) {
  return html`
    <${Tap} className="cs-sheet-row tap-bg" onClick=${onClick} style=${{ color: danger ? "var(--bad-text)" : "var(--text)" }}>
      <${Icon} name=${icon} size=${20} color=${danger ? "var(--bad-text)" : "var(--text2)"} />${label}
    <//>
  `
}

/** One message: who, a quoted reply, the content, time and ticks, reactions. */
function Bubble({ m, first, hl, face, quote, reactions, read, onPress, onRelease, onMenu, onQuote, onImage, onReact, onRetry }) {
  const deleted = m.type === "deleted"
  const issue = m.tria && m.kind && m.kind.startsWith("issue")
  const tick = !m.mine ? null
    : m.failed ? html`<${Icon} name="warning-circle" size=${13} color="var(--bad-text)" />`
    : m.pending ? html`<${Icon} name="clock" size=${12} />`
    : html`<${Icon} name=${read ? "checks" : "check"} size=${13} color=${read ? "var(--accent)" : undefined} />`
  // In a workspace chat, others' runs start with their photo (Tria: her mark).
  const facePic = face && first
    ? (face.tria ? html`<span style=${{ width: 30, height: 30, borderRadius: 999, background: "var(--accent-tint)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><${TriageMark} size=${22} /></span>`
      : html`<${Photo} src=${face.src} name=${m.name} size=${30} color=${avatarColor(m.sender)} />`)
    : face ? html`<span style=${{ width: 30, flexShrink: 0 }} />` : null
  return html`
    <div class=${"cs-row" + (m.mine ? " mine" : "") + (first ? " first" : "") + (hl ? " hl" : "")} data-id=${m.id}
      style=${face ? { flexDirection: "row", alignItems: "flex-start", gap: 6 } : undefined}>
      ${facePic}
      <div class="col" style=${face ? { minWidth: 0, flex: "0 1 auto", maxWidth: "calc(100% - 36px)" } : { display: "contents" }}>
      <div class="cs-bub"
        style=${{ borderLeft: issue && SEV[m.severity] ? `3px solid ${SEV[m.severity]}` : undefined, opacity: m.pending ? 0.75 : 1 }}
        onPointerDown=${(e) => onPress(m, e)} onPointerUp=${onRelease} onPointerLeave=${onRelease} onPointerCancel=${onRelease}
        onContextMenu=${(e) => { e.preventDefault(); onRelease(); onMenu(m) }}
        onClick=${m.failed ? onRetry : undefined}>
        ${first && !m.mine && html`<div class="cs-name" style=${{ color: m.tria ? "var(--accent)" : nameColor(m.sender) }}>${m.name}${issue ? html` <span style=${{ color: SEV[m.severity] ?? "var(--muted)", fontWeight: 400 }}>· ${m.kind.replace("_", " ")}</span>` : ""}</div>`}
        ${m.forwarded && html`<div style=${{ fontSize: 12, color: "var(--accent)", marginBottom: 2 }}>Forwarded from ${m.forwarded}</div>`}
        ${quote && html`
          <div class="cs-quote" onClick=${(e) => { e.stopPropagation(); if (!quote.missing) onQuote(quote.id) }}>
            <div style=${{ color: "var(--accent)", fontWeight: 500 }}>${quote.missing ? "Reply" : quote.mine ? "You" : quote.name}</div>
            <div class="ellip" style=${{ color: "var(--text2)" }}>${quote.missing ? "an earlier message" : snippet(quote)}</div>
          </div>
        `}
        ${deleted ? html`<span style=${{ fontStyle: "italic", color: "var(--muted)" }}>Message deleted</span>`
          : m.type === "encrypted" ? html`<span class="row" style=${{ gap: 5, fontStyle: "italic", color: "var(--muted)" }}><${Icon} name="lock" size=${13} />Waiting for this message's key</span>`
          : m.type === "image" && m.media && !m.media.url ? html`
            <div class="cs-img" style=${{ width: 220, aspectRatio: m.media.w && m.media.h ? `${m.media.w} / ${m.media.h}` : "4 / 3", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface3)", color: "var(--muted)", fontSize: 12.5 }}>Decrypting…</div>
            ${m.body && m.body !== m.media.name ? m.body : ""}`
          : m.type === "image" && m.media ? html`
            <img class="cs-img" src=${m.media.thumb || m.media.url} alt=${m.media.name} loading="lazy"
              style=${m.media.w && m.media.h ? { aspectRatio: `${m.media.w} / ${m.media.h}`, width: Math.min(260, m.media.w) } : { width: 220 }}
              onClick=${(e) => { e.stopPropagation(); onImage(m.media) }} />
            ${m.body && m.body !== m.media.name ? m.body : ""}`
          : m.type === "file" && m.media ? html`
            <a class="cs-file" href=${m.media.url + (m.media.url.startsWith("/") ? "?download=1" : "")} download=${m.media.name} onClick=${(e) => { e.stopPropagation(); saveInApp(e, m.media.url, m.media.name, m.media.mime) }} style=${{ color: "inherit", textDecoration: "none" }}>
              <span class="cs-ava" style=${{ width: 38, height: 38, background: "var(--accent-deep)" }}><${Icon} name="file" size=${20} color="#fff" /></span>
              <span class="col" style=${{ minWidth: 0 }}>
                <span class="ellip" style=${{ fontSize: 14 }}>${m.media.name}</span>
                <span style=${{ fontSize: 11.5, color: "var(--muted)" }}>${fileSize(m.media.size)}</span>
              </span>
            </a>
            ${m.body && m.body !== m.media.name ? m.body : ""}`
          : m.tria ? html`<${Md} text=${m.body} />` : m.body}
        ${m.warn && html`<div class="row" style=${{ gap: 4, fontSize: 11.5, color: "var(--bad-text)" }}><${Icon} name="warning" size=${12} />from a device that is not verified</div>`}
        <span class="cs-meta">${m.edited && !deleted ? "edited " : ""}${clock(m.ts)} ${tick}</span>
        ${m.failed && html`<div style=${{ clear: "both", fontSize: 11.5, color: "var(--bad-text)" }}>Not sent. Tap to retry.</div>`}
      </div>
      ${reactions.length > 0 && html`
        <div class="cs-reacts" style=${face ? { maxWidth: "100%" } : undefined}>
          ${reactions.map(g => {
            const st = reactionStyle(g.key)
            return html`<${Tap} key=${g.key} className=${"cs-react" + (g.mine ? " mine" : "")} onClick=${() => onReact(g.key)} label=${g.key + ": " + g.names.join(", ")}>
              <${Icon} name=${st.icon} size=${15} weight="fill" color=${g.mine ? "var(--text-strong)" : st.color} />${g.count > 1 ? html`<b>${g.count}</b>` : ""}
            <//>`
          })}
        </div>
      `}
      </div>
    </div>
  `
}
