import { html, useEffect, useRef } from "../vendor/preact-htm.js"
import { useVoice } from "../voice/voice.js"
import { Icon } from "./Icon.js"
import { useStore, current } from "../state/store.js"

/**
 * The voice card over the tab bar: state line, the running conversation
 * (what the core transcribed from you, the agent's reply, tool calls it made),
 * and an X that ends the session. Hold the triage icon to start, tap it to end.
 */
const BARS = [40, 80, 55, 100, 65, 35, 75, 45]

const STATE_LABEL = {
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  idle: "Ready",
}

/**
 * The Tria chat shows the conversation in its own log, so there the session
 * is one slim row in the screen (state, level bars, end), not a card.
 */
export function VoiceBar() {
  const v = useVoice()
  if (!v.open) return null
  const label = v.conn === "connecting" ? "Connecting" : v.conn === "error" ? "Voice unavailable" : STATE_LABEL[v.agent]
  const animate = v.conn === "open" && (v.agent === "listening" || v.agent === "speaking")
  return html`
    <div role="status" aria-live="polite" class="row" style=${{ gap: 8, padding: "8px 12px", borderRadius: 10, background: "var(--surface2)", boxShadow: "0 0 0 1px #423a6a" }}>
      <span style=${{ width: 8, height: 8, borderRadius: 99, background: v.conn === "error" ? "#f87171" : "#9184d9", display: "block", animation: animate ? "vlisten 1.4s ease-in-out infinite" : "none" }} />
      <span style=${{ fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase", color: v.conn === "error" ? "#f0b7b7" : "var(--accent)" }}>${label}</span>
      ${animate && html`<span class="row" style=${{ gap: 3, height: 14, alignItems: "center" }}>
        ${BARS.slice(0, 5).map((h, i) => html`<span key=${i} style=${{ width: 3, height: h + "%", borderRadius: 99, background: "#796cbf", display: "block", animation: `vlisten ${1.1 + (i % 4) * 0.15}s ease-in-out infinite` }} />`)}
      </span>`}
      <span style=${{ flex: 1 }} />
      <span style=${{ fontSize: 11, color: "var(--muted)" }}>${v.error || "tap the triage icon to end"}</span>
      <button type="button" class="tap" aria-label="End voice session" onClick=${v.close}
        style=${{ width: 40, height: 40, margin: -10, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>
        <${Icon} name="x" size=${16} />
      </button>
    </div>`
}

export function VoiceOverlay() {
  const v = useVoice()
  const onChat = useStore(s => current(s).screen === "tria")
  const listRef = useRef(null)
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }) }, [v.msgs])
  if (!v.open || onChat) return null

  const label = v.conn === "connecting" ? "Connecting" : v.conn === "error" ? "Voice unavailable" : STATE_LABEL[v.agent]
  const animate = v.conn === "open" && (v.agent === "listening" || v.agent === "speaking")
  const hint = v.conn === "error" ? "" : "tap the triage icon to end"

  return html`
    <div
      role="status"
      aria-live="polite"
      data-swipe="off"
      style=${{
        position: "absolute", left: 16, right: 16, bottom: "calc(96px + env(safe-area-inset-bottom, 0px))", zIndex: 20,
        background: "var(--surface2)", borderRadius: 14, padding: 14, display: "flex", flexDirection: "column", gap: 9,
        boxShadow: "0 0 0 1px #423a6a, 0 16px 40px rgba(0,0,0,0.65)", animation: "sheetUp .15s ease",
      }}
    >
      <div class="row" style=${{ gap: 8 }}>
        <span style=${{ width: 8, height: 8, borderRadius: 99, background: v.conn === "error" ? "#f87171" : "#9184d9", display: "block", animation: animate ? "vlisten 1.4s ease-in-out infinite" : "none" }} />
        <span style=${{ fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase", color: v.conn === "error" ? "#f0b7b7" : "var(--accent)" }}>${label}</span>
        <span style=${{ flex: 1 }} />
        <span style=${{ fontSize: 11, color: "var(--muted)" }}>${hint}</span>
        <button type="button" class="tap" aria-label="End voice session" onClick=${v.close}
          style=${{ width: 40, height: 40, margin: -10, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>
          <${Icon} name="x" size=${16} />
        </button>
      </div>

      ${v.error && html`<span class="pretty" style=${{ fontSize: 13, lineHeight: 1.45, color: "#f0b7b7" }}>${v.error}</span>`}

      ${v.msgs.length > 0 ? html`
        <div ref=${listRef} class="col" style=${{ gap: 7, maxHeight: 200, overflowY: "auto" }}>
          ${v.msgs.map(m => m.role === "tool" ? html`
            <span key=${m.id} style=${{ fontFamily: "var(--mono)", fontSize: 10.5, color: "#8a8ea3" }}>→ ${m.text}</span>
          ` : html`
            <span key=${m.id} class="pretty" style=${{ fontSize: 13, lineHeight: 1.45, color: m.role === "user" ? "#c2c6d8" : "#e9e9ed", alignSelf: m.role === "user" ? "flex-end" : "flex-start", textAlign: m.role === "user" ? "right" : "left", maxWidth: "88%" }}>
              ${m.text}
            </span>
          `)}
        </div>
      ` : !v.error && html`
        <span class="pretty" style=${{ fontSize: 13, lineHeight: 1.45, color: "var(--text2)" }}>
          Ask about this tenant — what is open, why a service is degraded, what changed.
        </span>
      `}

      ${animate && html`
        <div class="row" style=${{ gap: 5, height: 22, alignItems: "center" }}>
          ${BARS.map((h, i) => html`
            <span key=${i} style=${{ width: 3, height: h + "%", borderRadius: 99, background: i % 3 === 1 ? "#796cbf" : i === 3 ? "#9184d9" : "#5d5294", display: "block", animation: `vlisten ${1.1 + (i % 4) * 0.15}s ease-in-out infinite` }} />
          `)}
        </div>
      `}
    </div>
  `
}
