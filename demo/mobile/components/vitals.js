import { html, useRef } from "../vendor/preact-htm.js"
import { ringDash } from "../model/vitals.js"
import { pct } from "../model/format.js"
import { useStore } from "../state/store.js"
import { useMessenger } from "../state/messenger.js"
import { Icon } from "./Icon.js"

// SVG attributes are written kebab-case (stroke-width, …): Preact core sets
// them as given, it does not translate React's camelCase names.

/** Four rings, outermost first; stroke 8, pitch 10, innermost inner edge at 36 (the centre disc reaches ~34). */
export const HERO_RINGS = [
  { r: 70, metric: "use", color: "#22d3ee", label: "Saturation (USE)" },
  { r: 60, metric: "red", color: "#e879f9", label: "Reliability (RED errors and latency)" },
  { r: 50, metric: "sig", color: "#8b8bf0", label: "Traffic (SIG)" },
  { r: 40, metric: "inc", color: "#fbbf24", label: "Readiness this week" },
]
const RING_STROKE = 8

// A sideways swipe on the rings steps the cluster; the shell leaves it alone
// (data-swipe="x"), so these match its thresholds without clashing.
const SWIPE_MIN_DX = 56
const SWIPE_MAX_MS = 900

/** The vitals hero: signal corona, four goal rings, attainment disc. */
export function VitalsHero({ m, onSwipe }) {
  const navigate = useStore(s => s.navigate)
  // The centre disc opens the workspace's chat; with no chat (no messenger), the goals.
  const tenant = useStore(s => s.tenant)
  const room = useMessenger(s => s.rooms.find(r => r.kind !== "dm" && r.workspace === tenant))
  const open = (metric) =>
    navigate(metric === "inc" ? { screen: "issues" } : { screen: "detail", metric })
  const from = useRef(null)
  const swiped = useRef(false)
  const begin = (x, y) => { swiped.current = false; from.current = { x, y, t: Date.now() } }
  const end = (x, y) => {
    const s = from.current
    from.current = null
    if (!s || !onSwipe) return
    const dx = x - s.x, dy = y - s.y
    if (Date.now() - s.t > SWIPE_MAX_MS || Math.abs(dx) < SWIPE_MIN_DX || Math.abs(dy) > Math.abs(dx) * 0.8) return
    swiped.current = true
    onSwipe(dx < 0 ? 1 : -1)
  }
  return html`
    <div
      style=${{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", height: 248 }}
      data-swipe="x"
      onTouchStart=${e => { const p = e.touches[0]; if (p) begin(p.clientX, p.clientY) }}
      onTouchEnd=${e => { const p = e.changedTouches[0]; if (p) end(p.clientX, p.clientY) }}
      onMouseDown=${e => { if (e.button === 0) begin(e.clientX, e.clientY) }}
      onMouseUp=${e => end(e.clientX, e.clientY)}
      onClickCapture=${e => { if (swiped.current) { swiped.current = false; e.stopPropagation() } }}
    >
      <svg viewBox="7 7 186 186" style=${{ width: 248, height: 248, overflow: "visible", transform: "rotate(-90deg)" }}>
        ${m.halo.flatMap((t, i) => t.segs.length
          ? t.segs.map((g, j) => html`<line key=${i + "." + j} x1=${g.x1} y1=${g.y1} x2=${g.x2} y2=${g.y2} stroke=${g.c} stroke-width="1.7" stroke-opacity=${g.op} />`)
          : [html`<line key=${i} x1=${t.x1} y1=${t.y1} x2=${t.x2} y2=${t.y2} stroke=${t.c} stroke-width="1.7" stroke-linecap="round" stroke-opacity=${t.op} />`])}
        ${m.hand && html`<line x1=${m.hand.x1} y1=${m.hand.y1} x2=${m.hand.x2} y2=${m.hand.y2} stroke=${m.hand.c} stroke-width="2.2" stroke-linecap="round" />`}
        ${HERO_RINGS.map(g => html`
          <circle key=${"t" + g.metric} cx="100" cy="100" r=${g.r} fill="none" stroke="#22262e" stroke-width=${RING_STROKE} onClick=${() => open(g.metric)} style=${{ cursor: "pointer" }} />
        `)}
        ${HERO_RINGS.map(g => {
          const fill = m.fills[g.metric]
          return fill == null ? null : html`
            <circle
              key=${g.metric} cx="100" cy="100" r=${g.r} fill="none" stroke=${g.color} stroke-width=${RING_STROKE} stroke-linecap="round"
              stroke-dasharray=${ringDash(fill, 2 * Math.PI * g.r)} style=${{ cursor: "pointer" }}
              onClick=${() => open(g.metric)} role="button" aria-label=${g.label}
            />
          `
        })}
      </svg>
      <div style=${{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
        <button
          type="button"
          onClick=${() => navigate(room ? { screen: "chat", roomId: room.id, roomName: room.name } : { screen: "goals" })}
          aria-label=${room ? "Open the workspace chat" : "Attainment " + m.attainPct + " of goals"}
          style=${{
            width: 82, height: 82, borderRadius: 999, pointerEvents: "auto",
            background: "radial-gradient(circle,#14161f 56%,rgba(20,22,31,0) 100%)",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1,
          }}
        >
          <span style=${{ fontSize: 35, fontWeight: 500, letterSpacing: "-0.03em", lineHeight: 1, color: "#fff" }}>${m.attainPct}</span>        </button>
      </div>
    </div>
  `
}

const TILE = [
  { k: "USE", name: "Saturation", what: "memory, stalls, OOM", icon: "cpu", metric: "use", c1: "#1f8496", c1x: "#166a7a", c2: "#0c2733", tint: "#eafcff", iconFg: "#67e8f9" },
  { k: "RED", name: "Reliability", what: "errors, p99 latency", icon: "gauge", metric: "red", c1: "#a5449a", c1x: "#88357f", c2: "#331336", tint: "#fdeeff", iconFg: "#f0abfc" },
  { k: "SIG", name: "Traffic", what: "vs own baseline", icon: "waveform", metric: "sig", c1: "#6355d6", c1x: "#4a3cb4", c2: "#1e1a3d", tint: "#efeeff", iconFg: "#b3aef8" },
  { k: "INC", name: "Readiness", what: "issues this week", icon: "chart-bar", metric: null, c1: "#b8741a", c1x: "#94590f", c2: "#3a2508", tint: "#fff7e6", iconFg: "#fcd34d" },
]

/** "56 concerns · 3 critical · goal ≤ 15/wk": what the readiness is made of. */
function incLine(m, goals) {
  const w = m.incWeek
  if (!w) return `goal ≤ ${goals.inc}/wk`
  return `${w.thisWeek} issue${w.thisWeek === 1 ? "" : "s"}` + (w.critical ? ` · ${w.critical} critical` : "") + ` · goal ≤ ${goals.inc}/wk`
}

/** "90", or "90 · kafka memory 92%" while the arm is short of its goal and a worst service is known. */
function goalLine(c, goal) {
  return c.met === false && c.caption !== "—" ? `${goal} · ${c.caption}` : String(goal)
}

/** Four goal tiles (USE, RED, SIG + this week's issues), 2x2, with the two-tone progress fill and gradient numerals. */
export function VitalTiles({ m, goals }) {
  const navigate = useStore(s => s.navigate)
  const { use, red, sig } = m.infra
  const vals = [
    { fill: m.fills.use, now: use.now, goal: goalLine(use, goals.use) },
    { fill: m.fills.red, now: red.now, goal: goalLine(red, goals.red) },
    { fill: m.fills.sig, now: sig.now, goal: goalLine(sig, goals.sig) },
    // This week's opened count against the goal, and its severity split.
    // Readiness: goal / weighted concerns, capped at 100%.
    { fill: m.fills.inc, now: pct(m.fills.inc), goal: incLine(m, goals) },
  ]
  return html`
    <div style=${{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 6 }}>
      ${TILE.map((v, i) => {
        const { fill, now, goal } = vals[i]
        const met = fill != null && fill >= 0.999
        const p = fill == null ? 0 : Math.max(6, Math.min(100, Math.round(fill * 100)))
        const bg = fill == null
          ? v.c2
          : met
            ? `linear-gradient(160deg,${v.c1},${v.c1x})`
            : `linear-gradient(90deg,${v.c1} 0%,${v.c1} ${p}%,rgba(255,255,255,.45) ${p}%,rgba(255,255,255,.45) ${p + 0.6}%,${v.c2} ${p + 0.6}%,${v.c2} 100%)`
        const numGrad = fill == null
          ? `linear-gradient(90deg,${v.iconFg},${v.iconFg})`
          : met ? `linear-gradient(90deg,${v.tint},${v.tint})`
          : `linear-gradient(90deg,#ffffff 0%,#ffffff ${p}%,${v.iconFg} ${p}%,${v.iconFg} 100%)`
        return html`
          <button
            type="button"
            key=${v.k}
            class="tap"
            onClick=${() => navigate(v.metric ? { screen: "detail", metric: v.metric } : { screen: "issues" })}
            style=${{ borderRadius: 14, padding: "9px 11px 10px", display: "flex", flexDirection: "column", gap: 4, backgroundImage: bg, backgroundColor: v.c2, minWidth: 0 }}
          >
            <span class="row" style=${{ gap: 5, fontSize: 11, color: "rgba(255,255,255,.84)" }}>
              <${Icon} name=${v.icon} size=${12} weight="fill" color=${v.iconFg} />${v.name}
            </span>
            <span class="ellip" style=${{ fontSize: 10, color: "rgba(255,255,255,.6)", marginTop: -3 }}>${v.what}</span>
            <span
              class="gradnum"
              style=${{ fontSize: 20, fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1.1, backgroundImage: numGrad, backgroundSize: "calc(100% + 22px) 100%", backgroundPosition: "-11px 0", backgroundRepeat: "no-repeat", whiteSpace: "nowrap" }}
            >
              ${now}
            </span>
            <span class="ellip" style=${{ fontSize: 10.5, color: "rgba(255,255,255,.7)" }}>${v.metric ? "goal " + goal : goal}</span>
          </button>
        `
      })}
    </div>
  `
}

export function LiveIssueCard({ i }) {
  const navigate = useStore(s => s.navigate)
  return html`
    <button
      type="button"
      class="tap"
      onClick=${() => navigate({ screen: "issue", incId: i.id })}
      style=${{ background: "var(--surface2)", borderRadius: 10, padding: "11px 12px", display: "flex", flexDirection: "column", gap: 6, boxShadow: `inset 2px 0 0 ${i.color}` }}
    >
      <div class="row" style=${{ gap: 7, minWidth: 0, width: "100%" }}>
        <span style=${{ fontSize: 11, padding: "2px 7px", borderRadius: 99, background: i.pillBg, color: i.pillFg, flexShrink: 0 }}>${i.sev}</span>
        <span class="ellip" style=${{ fontSize: 13.5, fontWeight: 500 }}>${i.svc}</span>
        <span class="mono ellip" style=${{ fontSize: 11.5, color: "var(--muted)", flexShrink: 1 }}>${i.env}</span>
        <span style=${{ flex: 1 }} />
        <span style=${{ fontSize: 12, color: i.pillFg, flexShrink: 0 }}>${i.age}</span>
      </div>
      <span class="pretty" style=${{ fontSize: 12, lineHeight: 1.4, color: "var(--text-body)" }}>${i.summary}</span>
      <span class="mono" style=${{ fontSize: 11.5, color: "var(--muted)" }}>${i.meta}</span>
    </button>
  `
}

/** Props: values, color = "#5d5294", height = 26, peak. */
export function Bars({ values, color = "#5d5294", height = 26, peak }) {
  const max = Math.max(1, ...values)
  return html`
    <div class="row" style=${{ alignItems: "flex-end", gap: 2, height }} data-swipe="off">
      ${values.map((v, i) => html`
        <span key=${i} style=${{ flex: 1, height: Math.max(v ? 8 : 4, Math.round((v / max) * 100)) + "%", borderRadius: 2, background: v === 0 ? "#262838" : peak && v === max ? peak : color, opacity: v === 0 ? 1 : 0.85, display: "block" }} />
      `)}
    </div>
  `
}
