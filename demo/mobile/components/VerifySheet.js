import { html } from "../vendor/preact-htm.js"
import { useE2EE } from "../state/e2ee.js"
import { e2ee } from "../state/e2ee-app.js"
import { useMessenger } from "../state/messenger.js"
import { Tap } from "./ui.js"
import { Icon } from "./Icon.js"

/**
 * Emoji verification (core ADR-093), wherever the app is: another of my
 * devices, or the other person in an encrypted chat, asks to compare the
 * same seven emoji on both screens. They match: each side confirms and the
 * device or person is verified. They differ: it is called off.
 */
export function VerifySheet() {
  const v = useE2EE(s => s.verification)
  const rooms = useMessenger(s => s.rooms)
  if (!v) return null
  const who = v.self ? "your other device" : rooms.find(r => r.peer === v.peer)?.name ?? v.peer
  const run = (fn) => () => { fn().catch(() => {}) }
  const button = (label, onClick, primary) => html`
    <${Tap} onClick=${onClick} style=${{ flex: 1, height: 44, borderRadius: 12, fontSize: 15, fontWeight: 500,
      background: primary ? "var(--accent-deep)" : "var(--surface3)", color: primary ? "var(--text-strong)" : "var(--text)" }}>${label}<//>`

  let body
  switch (v.phase) {
    case "incoming":
      body = html`
        <p class="cs-verify-text">${v.self ? "Your other device asks to be verified." : `${who} asks to verify your chat.`} You will compare emoji on both screens.</p>
        <div class="row" style=${{ gap: 10 }}>${button("Decline", run(() => e2ee.cancel()))}${button("Compare emoji", run(() => e2ee.accept()), true)}</div>`
      break
    case "requested":
    case "waiting":
      body = html`
        <p class="cs-verify-text">${v.phase === "requested" ? `Waiting for ${who} to answer…` : "Getting the emoji ready…"}</p>
        <div class="row">${button("Cancel", run(() => e2ee.cancel()))}</div>`
      break
    case "emoji":
      body = html`
        <p class="cs-verify-text">${v.self ? "Check that your other device shows these emoji, in this order." : `Check with ${who} that you both see these emoji, in this order.`}</p>
        <div class="cs-emoji">
          ${(v.emoji ?? []).map(e => html`<div class="col" style=${{ alignItems: "center", gap: 4 }}><span style=${{ fontSize: 34 }}>${e.symbol}</span><span style=${{ fontSize: 11, color: "var(--muted)" }}>${e.description}</span></div>`)}
        </div>
        ${v.confirmed
          ? html`<p class="cs-verify-text">Waiting for the other side to confirm…</p>`
          : html`<div class="row" style=${{ gap: 10 }}>${button("They differ", run(() => e2ee.cancel(true)))}${button("They match", run(() => e2ee.confirm()), true)}</div>`}`
      break
    case "done":
      body = html`
        <p class="cs-verify-text">${!v.self ? `${who} is verified.` : v.incoming ? "Your other device is verified." : "This device is verified. It can read your encrypted chats from now on."}</p>
        <div class="row">${button("Done", () => { e2ee.dismiss(); useMessenger.getState().rooms.filter(r => r.encrypted).forEach(r => void useMessenger.getState().checkTrust(r.id)) }, true)}</div>`
      break
    default:
      body = html`
        <p class="cs-verify-text">The verification stopped${v.reason ? `: ${v.reason}` : ""}.</p>
        <div class="row">${button("Close", () => e2ee.dismiss())}</div>`
  }
  return html`
    <div class="cs-sheet-back" style=${{ zIndex: 45 }}>
      <div class="cs-sheet" style=${{ padding: "16px 20px calc(18px + env(safe-area-inset-bottom, 0px))", display: "flex", flexDirection: "column", gap: 14 }}>
        <div class="row" style=${{ gap: 10 }}>
          <${Icon} name="shield-check" size=${22} color="var(--accent)" />
          <span style=${{ fontSize: 16, fontWeight: 500 }}>${!v.self ? `Verify ${who}` : v.incoming ? "Verify your other device" : "Verify this device"}</span>
        </div>
        ${body}
      </div>
    </div>
  `
}
