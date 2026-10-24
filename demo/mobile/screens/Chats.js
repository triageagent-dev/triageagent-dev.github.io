import { html, useEffect, useState } from "../vendor/preact-htm.js"
import { useStore } from "../state/store.js"
import { useMessenger } from "../state/messenger.js"
import { Tap } from "../components/ui.js"
import { Icon, TriageMark } from "../components/Icon.js"
import { Photo } from "../components/Photo.js"
import { avatarColor, preview, shortTime } from "../model/chat.js"

/**
 * The Chats tab: the private chat with Tria pinned first, then one
 * conversation per workspace the viewer can read, newest first, with unread
 * counts. A filter narrows the list by name.
 */
export function Chats() {
  const navigate = useStore(s => s.navigate)
  const rooms = useMessenger(s => s.rooms)
  const loaded = useMessenger(s => s.loaded)
  const err = useMessenger(s => s.err)
  const status = useMessenger(s => s.status)
  const typing = useMessenger(s => s.typing)
  const [q, setQ] = useState("")
  const [picker, setPicker] = useState(null) // null, or {people, err}

  useEffect(() => { useMessenger.getState().start(); void useMessenger.getState().refreshRooms() }, [])

  const shown = rooms.filter(r => !q || r.name.toLowerCase().includes(q.toLowerCase()))
  const showTria = !q || "tria".includes(q.toLowerCase())

  return html`
    <div class="cs">
      <div class="cs-head" style=${{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
        <div class="row" style=${{ gap: 8 }}>
          <span style=${{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.02em" }}>Chats</span>
          <span style=${{ flex: 1 }} />
          ${status !== "live" && html`<span style=${{ fontSize: 11.5, color: "var(--muted)" }}>connecting…</span>`}
          <${Tap} label="New chat" onClick=${async () => {
            setPicker({ people: null })
            try { setPicker({ people: (await useMessenger.getState().people()).people ?? [] }) } catch (e) { setPicker({ people: [], err: e.message }) }
          }} style=${{ padding: 4 }}><${Icon} name="pen" size=${20} color="var(--accent)" /><//>
        </div>
        <label class="row" style=${{ gap: 8, height: 36, padding: "0 12px", borderRadius: 10, background: "var(--well)", border: "1px solid var(--input-line)" }}>
          <${Icon} name="magnifying-glass" size=${15} color="var(--muted)" />
          <input value=${q} onInput=${e => setQ(e.currentTarget.value)} placeholder="Search chats" style=${{ flex: 1, minWidth: 0, background: "transparent", border: 0, color: "var(--text)", fontSize: 14, outline: "none" }} />
        </label>
      </div>
      <div class="cs-list" style=${{ padding: "4px 0" }}>
        ${showTria && html`
          <${Row} onClick=${() => navigate({ screen: "tria" })}
            avatar=${html`<span class="cs-ava" style=${{ background: "var(--accent-tint)" }}><${TriageMark} size=${26} /></span>`}
            name="Tria" line="Private chat · ask about this workspace" />
        `}
        ${shown.map(r => {
          const t = (typing[r.id] ?? []).filter(Boolean)
          return html`
            <${Row} key=${r.id} onClick=${() => navigate({ screen: "chat", roomId: r.id, roomName: r.name })}
              avatar=${html`<${Photo} src=${r.avatar} name=${r.name} size=${36} color=${avatarColor(r.kind === "dm" ? r.peer : r.workspace)} square=${r.kind !== "dm"} />`}
              name=${r.name}
              spot=${r.spot}
              time=${r.last ? shortTime(r.last.ts) : ""}
              line=${t.length ? html`<span style=${{ color: "var(--accent)" }}>${t.join(", ")} typing…</span>` : r.earlier ? "Earlier chat · not encrypted" : r.last ? preview(r.last) : "No messages yet"}
              unread=${r.unread} />
          `
        })}
        ${loaded && err && html`<span style=${{ padding: "10px 16px", fontSize: 12.5, color: "var(--bad-text)" }}>${err}</span>`}
        ${loaded && !err && !rooms.length && html`<span style=${{ padding: "10px 16px", fontSize: 12.5, color: "var(--muted)" }}>No workspaces for this account yet.</span>`}
      </div>
      ${picker && html`
        <div class="cs-sheet-back" onClick=${() => setPicker(null)}>
          <div class="cs-sheet" onClick=${e => e.stopPropagation()}>
            <div style=${{ padding: "8px 20px 4px", fontSize: 15, fontWeight: 500 }}>New chat</div>
            <div style=${{ padding: "0 20px 8px", fontSize: 12, color: "var(--muted)" }}>A private chat with someone who shares a workspace with you.</div>
            ${picker.people === null && html`<span style=${{ padding: "8px 20px", fontSize: 12.5, color: "var(--muted)" }}>loading…</span>`}
            ${picker.err && html`<span style=${{ padding: "8px 20px", fontSize: 12.5, color: "var(--bad-text)" }}>${picker.err}</span>`}
            ${picker.people && !picker.people.length && !picker.err && html`<span style=${{ padding: "8px 20px", fontSize: 12.5, color: "var(--muted)" }}>Nobody else has opened the messenger in your workspaces yet.</span>`}
            ${(picker.people ?? []).map(p => html`
              <${Tap} key=${p.id} className="cs-sheet-row tap-bg" onClick=${async () => {
                setPicker(null)
                try { const r = await useMessenger.getState().directChat(p.id); navigate({ screen: "chat", roomId: r.id, roomName: r.name }) }
                catch (e) { setPicker({ people: [], err: e.message }) }
              }}>
                <${Photo} src=${p.avatar} name=${p.name} size=${34} color=${avatarColor(p.id)} />${p.name}
              <//>
            `)}
          </div>
        </div>
      `}
    </div>
  `
}

function Row({ onClick, avatar, name, spot, time, line, unread }) {
  return html`
    <${Tap} onClick=${onClick} className="tap-bg" style=${{ display: "flex", gap: 12, padding: "9px 14px", alignItems: "center", textAlign: "left", width: "100%" }}>
      ${avatar}
      <div class="grow col" style=${{ gap: 3, borderBottom: "1px solid var(--line2)", paddingBottom: 9 }}>
        <div class="row" style=${{ gap: 6 }}>
          <span class="ellip" style=${{ fontSize: 15, fontWeight: 500 }}>${name}</span>
          ${spot && html`<span title=${spot.name + (spot.state === "up" ? " is up" : " is down")} style=${{ width: 8, height: 8, borderRadius: 4, flex: "none", background: spot.state === "up" ? "var(--ok-text)" : "var(--bad-text)" }} />`}
          <span style=${{ flex: 1 }} />
          ${time && html`<span style=${{ fontSize: 11.5, color: unread ? "var(--accent)" : "var(--muted)" }}>${time}</span>`}
        </div>
        <div class="row" style=${{ gap: 6 }}>
          <span class="ellip grow" style=${{ fontSize: 13, color: "var(--text3)" }}>${line}</span>
          ${unread > 0 && html`<span class="cs-badge">${unread}</span>`}
        </div>
      </div>
    <//>
  `
}
