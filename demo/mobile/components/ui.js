import { html, useEffect } from "../vendor/preact-htm.js"
import { current, useStore } from "../state/store.js"
import { useMessenger } from "../state/messenger.js"
import { Icon } from "./Icon.js"

/** Stop a tap inside a tappable card from also firing the card. */
export const stop = (e) => e.stopPropagation()

/** Props: onClick, style, className, children, label, pressed, bg. */
export function Tap(props) {
  return html`
    <button
      type="button"
      class=${"tap" + (props.bg ? " tap-bg" : "") + (props.className ? " " + props.className : "")}
      onClick=${props.onClick}
      style=${props.style}
      aria-label=${props.label}
      aria-pressed=${props.pressed}
    >
      ${props.children}
    </button>
  `
}

export function useGo() {
  const navigate = useStore(s => s.navigate)
  return (v) => () => navigate(v)
}

export function Avatar({ size = 26 }) {
  const username = useStore(s => s.username)
  const navigate = useStore(s => s.navigate)
  const photo = useMessenger(s => s.myPhoto)
  useEffect(() => { void useMessenger.getState().loadMe() }, [])
  const initial = (username || "?").slice(0, 1).toUpperCase()
  return html`
    <${Tap}
      label="Account and settings"
      onClick=${() => navigate({ screen: "settings" })}
      style=${{
        display: "flex", alignItems: "center", justifyContent: "center", width: size, height: size,
        borderRadius: 999, background: "var(--avatar-bg)", boxShadow: "0 0 0 1px var(--avatar-ring)",
        fontSize: size > 40 ? 19 : 11, fontWeight: 500, color: "var(--accent-strong)", flexShrink: 0, overflow: "hidden", padding: 0,
      }}
    >
      ${photo ? html`<img src=${photo} alt="" style=${{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />` : initial}
    <//>
  `
}

export function useSource() {
  const conn = useStore(s => s.conn)
  const hasSnap = useStore(s => !!s.snap)
  const lastLiveAt = useStore(s => s.lastLiveAt)
  const age = lastLiveAt ? Math.max(1, Math.round((Date.now() - lastLiveAt) / 60000)) : null
  if (conn === "live") return { label: "Live", fg: "var(--st-ok)" }
  if (conn === "connecting") return { label: "Connecting", fg: "var(--st-idle)" }
  if (conn === "failed" && hasSnap) return { label: age ? `Stale ${age}m` : "Stale", fg: "var(--st-warn)" }
  if (conn === "failed") return { label: "Offline", fg: "var(--st-crit-soft)" }
  return { label: "Idle", fg: "var(--st-idle)" }
}

export function SourcePill() {
  const src = useSource()
  const navigate = useStore(s => s.navigate)
  return html`
    <${Tap}
      label=${"Connection: " + src.label}
      onClick=${() => navigate({ screen: "settings" })}
      style=${{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: src.fg }}
    >
      <span style=${{ width: 6, height: 6, borderRadius: 99, background: src.fg, display: "block" }} />
      ${src.label}
    <//>
  `
}

/** Screen header: back arrow (history back, or home), title, right slot.
 *  Props: title, right, size, back, icon. */
export function Header(props) {
  const back = useStore(s => s.back)
  const hi = useStore(s => s.hi)
  const navigate = useStore(s => s.navigate)
  const onBack = () => (hi > 0 ? back() : navigate({ screen: "home" }))
  return html`
    <div class="row" style=${{ gap: 10, minHeight: 28 }}>
      ${props.back !== false && html`
        <${Tap} label="Back" onClick=${onBack} style=${{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, margin: "-4px 0 -4px -4px" }}>
          <${Icon} name="arrow-left" size=${19} color="var(--text-body)" />
        <//>
      `}
      ${props.icon}
      <span style=${{ fontSize: props.size ?? 22, fontWeight: 500, letterSpacing: "-0.02em", minWidth: 0 }} class="ellip">${props.title}</span>
      <span style=${{ flex: 1 }} />
      ${props.right}
    </div>
  `
}

export function Kicker({ children, right, light }) {
  return html`
    <div class="row" style=${{ alignItems: "baseline", gap: 8 }}>
      <span class=${light ? "kicker2" : "kicker"}>${children}</span>
      <span style=${{ flex: 1 }} />
      ${right}
    </div>
  `
}

export function Empty({ icon, children }) {
  return html`
    <div class="empty">
      ${icon}
      <span class="grow pretty">${children}</span>
    </div>
  `
}

/** The connection banner: shown only when the last poll failed. */
export function ConnBanner() {
  const conn = useStore(s => s.conn)
  const msg = useStore(s => s.connMsg)
  const hasSnap = useStore(s => !!s.snap)
  const lastLiveAt = useStore(s => s.lastLiveAt)
  const nextRetryAt = useStore(s => s.nextRetryAt)
  const navigate = useStore(s => s.navigate)
  if (conn !== "failed") return null
  const at = lastLiveAt ? new Date(lastLiveAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""
  const retry = nextRetryAt ? Math.max(1, Math.round((nextRetryAt - Date.now()) / 1000)) : null
  return html`
    <${Tap}
      onClick=${() => navigate({ screen: "settings" })}
      style=${{ background: "var(--bad-tint)", borderRadius: 8, padding: "10px 12px", display: "flex", gap: 9, alignItems: "flex-start", boxShadow: "inset 2px 0 0 var(--st-crit-soft)" }}
    >
      <${Icon} name="warning-circle" size=${15} color="var(--st-crit-soft)" style=${{ flexShrink: 0, marginTop: 1 }} />
      <span class="grow pretty" style=${{ fontSize: 11, lineHeight: 1.45, color: "var(--bad-text)" }}>
        ${hasSnap ? `Not connected — figures below are from ${at}. ` : "Not connected — nothing to show yet. "}
        ${msg ? msg + ". " : ""}
        ${retry ? `Retrying in ${retry}s.` : "Retrying automatically."}
      </span>
    <//>
  `
}

export function useView() {
  return useStore(s => current(s))
}
