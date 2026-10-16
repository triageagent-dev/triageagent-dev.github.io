import { html } from "../vendor/preact-htm.js"
import { DASH } from "../model/format.js"
import { useStore } from "../state/store.js"
import { Header } from "../components/ui.js"
import { Icon } from "../components/Icon.js"

/**
 * Secure (Pro). The core exposes no security-anomaly or posture API, so this
 * screen shows the design's frame with every figure absent, and says why.
 */
export function Secure() {
  const tenant = useStore(s => s.tenant)
  const tiles = [["open", DASH], ["blocked", DASH], ["posture", DASH]]
  return html`
    <main class="screen">
      <${Header} back=${false} title="Secure" right=${html`<span style=${{ fontSize: 12, color: "var(--muted)" }}>${tenant}</span>`} />
      <div style=${{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6 }}>
        ${tiles.map(([k, v]) => html`
          <div key=${k} style=${{ background: "var(--surface)", borderRadius: 10, padding: "12px 11px", display: "flex", flexDirection: "column", gap: 4, boxShadow: "inset 0 0 0 1px var(--line2)" }}>
            <span style=${{ fontSize: 23, fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1.1, color: "var(--muted)" }}>${v}</span>
            <span style=${{ fontSize: 11, color: "var(--muted)" }}>${k}</span>
          </div>
        `)}
      </div>
      <div class="note">
        <${Icon} name="shield-check" size=${16} color="var(--accent)" style=${{ flexShrink: 0, marginTop: 2 }} />
        <p class="pretty" style=${{ fontSize: 13, lineHeight: 1.5, color: "var(--text-body)" }}>
          Security anomalies and posture checks are not available from this core. It reports no security findings, so this screen shows none rather than examples — it fills in when the core ships a security API.
        </p>
      </div>
    </main>
  `
}
