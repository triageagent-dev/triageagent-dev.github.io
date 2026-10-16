import { html, useRef } from "../vendor/preact-htm.js"
import { current, useStore } from "../state/store.js"
import { useVoice } from "../voice/voice.js"
import { Icon, TriageMark } from "./Icon.js"

const LONG_PRESS_MS = 450

/** The main panels, left to right as the tab bar draws them. They carry no
 *  back arrow; a horizontal swipe on one moves to its neighbour. */
export const tabScreens = (pro) =>
  ["predict", "graph", "home", pro ? "cost" : "issues", pro ? "secure" : "stream"]

/**
 * Five slots: Trends, Apps, Vitals (centre), then Issues/Events on the free
 * tier or Cost/Secure with Pro. Holding the centre 450 ms starts a hands-free
 * voice session (voice/voice.js); tapping it while one is live ends it,
 * otherwise a tap returns home.
 */
export function TabBar() {
  const screen = useStore(s => current(s).screen)
  const pro = useStore(s => s.pro)
  const voice = useVoice(s => s.open)
  const tenant = useStore(s => s.tenant)
  const navigate = useStore(s => s.navigate)
  const lp = useRef({ t: null, fired: false })

  const on = (...s) => s.includes(screen)
  const slot4 = pro
    ? { label: "Cost", icon: "currency-dollar", screen: "cost", active: on("cost") }
    : { label: "Issues", icon: "warning", screen: "issues", active: on("issues", "issue") }
  const slot5 = pro
    ? { label: "Secure", icon: "shield-check", screen: "secure", active: on("secure") }
    : { label: "Events", icon: "pulse", screen: "stream", active: on("stream", "event") }

  const down = () => {
    lp.current.fired = false
    if (lp.current.t) clearTimeout(lp.current.t)
    useVoice.getState().prime()
    lp.current.t = setTimeout(() => { lp.current.fired = true; useVoice.getState().start(tenant) }, LONG_PRESS_MS)
  }
  const up = () => {
    if (lp.current.t) clearTimeout(lp.current.t)
    if (lp.current.fired) { lp.current.fired = false; return }
    if (useVoice.getState().open) { useVoice.getState().close(); return }
    navigate({ screen: "home" })
  }
  const cancel = () => {
    if (lp.current.t) clearTimeout(lp.current.t)
    lp.current.fired = false
  }

  return html`
    <nav class="tabbar" aria-label="Main">
      <${Slot} label="Trends" active=${on("predict")} onClick=${() => navigate({ screen: "predict" })} icon=${html`<${Icon} name="chart-bar" size=${22} />`} />
      <${Slot} label="Apps" active=${on("graph", "svc")} onClick=${() => navigate({ screen: "graph" })} icon=${html`<${Icon} name="squares-four" size=${22} />`} />
      <button
        type="button"
        aria-label=${voice ? "End voice session" : "Vitals (hold for voice)"}
        onPointerDown=${down}
        onPointerUp=${up}
        onPointerLeave=${cancel}
        onPointerCancel=${cancel}
        onContextMenu=${e => e.preventDefault()}
        onKeyDown=${e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate({ screen: "home" }) } }}
        style=${{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, padding: "2px 0", userSelect: "none", WebkitUserSelect: "none", touchAction: "none" }}
      >
        <span
          style=${{
            width: 46, height: 46, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center",
            border: `1px solid ${voice ? "#b5abfc" : "#5d5294"}`,
            background: voice ? "rgba(145,132,217,0.18)" : on("home") ? "rgba(145,132,217,0.08)" : "transparent",
            boxShadow: voice ? "0 0 18px rgba(145,132,217,0.35)" : "none",
            transition: "all .15s ease",
          }}
        >
          <${TriageMark} size=${32} />
        </span>
      </button>
      <${Slot} label=${slot4.label} active=${slot4.active} onClick=${() => navigate({ screen: slot4.screen })} icon=${html`<${Icon} name=${slot4.icon} size=${22} />`} />
      <${Slot} label=${slot5.label} active=${slot5.active} onClick=${() => navigate({ screen: slot5.screen })} icon=${html`<${Icon} name=${slot5.icon} size=${22} />`} />
    </nav>
  `
}

/** Props: label, active, onClick, icon. */
function Slot(props) {
  return html`
    <button
      type="button"
      class="tap"
      onClick=${props.onClick}
      aria-current=${props.active ? "page" : undefined}
      style=${{
        flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "6px 0",
        color: props.active ? "#b5abfc" : "#a3a7bd", minHeight: 40,
      }}
    >
      ${props.icon}
      <span style=${{ fontSize: 11.5 }}>${props.label}</span>
    </button>
  `
}
