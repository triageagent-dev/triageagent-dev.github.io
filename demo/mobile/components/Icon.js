import { html } from "../vendor/preact-htm.js"

/**
 * Phosphor icon from the TUI's vendored webfonts, standing in for the
 * @phosphor-icons/react components: `name` is the kebab-case icon name
 * (ArrowLeftIcon → "arrow-left"), `size` the px box (the React `size` prop),
 * `weight` "fill" for the filled set, `color` the glyph colour (the React
 * `color` prop; omitted → currentColor, as there). The React SVG was a block
 * box size × size (preflight makes svg display:block); this keeps that box.
 */
export function Icon({ name, size = 16, weight, color, style }) {
  const cls = (weight === "fill" ? "ph-fill" : "ph") + " ph-" + name
  return html`<i
    class=${cls}
    aria-hidden="true"
    style=${{ display: "block", width: size, height: size, fontSize: size, lineHeight: 1, color, ...style }}
  />`
}

/**
 * The Triage tab mark: three closed rings inside a corona of ticks, as on the vitals hero
 * (the launcher and PWA icons keep the open rings). Not a Phosphor glyph, so it has its own
 * colours instead of `color`.
 */
const MARK = [[44, "#8b8bf0"], [32, "#22d3ee"], [20, "#e879f9"]]
const TICKS = Array.from({ length: 48 }, (_, i) => {
  const a = (i / 48) * 2 * Math.PI, r0 = 46, r1 = r0 + 2 + ((i * 7) % 11) * 0.5
  return { x1: 54 + Math.cos(a) * r0, y1: 54 + Math.sin(a) * r0, x2: 54 + Math.cos(a) * r1, y2: 54 + Math.sin(a) * r1 }
})
export function TriageMark({ size = 24, style }) {
  return html`<svg viewBox="0 0 108 108" aria-hidden="true" style=${{ display: "block", width: size, height: size, transform: "rotate(-90deg)", ...style }}>
    ${TICKS.map((t, i) => html`<line key=${i} x1=${t.x1} y1=${t.y1} x2=${t.x2} y2=${t.y2} stroke="#4ade80" stroke-width="3" stroke-linecap="round" stroke-opacity="0.6" />`)}
    <g transform="translate(54 54) scale(0.8) translate(-54 -54)">
      ${MARK.map(([r, c]) => html`<circle key=${r} cx="54" cy="54" r=${r} fill="none" stroke=${c} stroke-width="10" />`)}
    </g>
  </svg>`
}
