import { html, useEffect, useMemo } from "../vendor/preact-htm.js"
import { issueRow } from "../model/vitals.js"
import { drawFractal, LAYER_NAMES, LAYER_TINTS } from "../model/fractal.js"
import { fmtClock } from "../model/format.js"
import { current, useStore } from "../state/store.js"
import { useMessenger } from "../state/messenger.js"
import { Header, Kicker, Tap } from "../components/ui.js"
import { Icon } from "../components/Icon.js"

export function IssueDetail() {
  const id = useStore(s => current(s).incId ?? "")
  const snap = useStore(s => s.snap)
  const fr = useStore(s => s.fractals[id])
  const ctxOpen = useStore(s => s.incContextOpen)
  const set = useStore(s => s.set)
  const loadFractal = useStore(s => s.loadFractal)
  const now = snap?.fetchedAt ?? Date.now()
  const inc = snap?.issues?.issues?.find(i => i.id === id) ?? null
  const row = useMemo(() => (inc ? issueRow(inc, snap?.graph, now) : null), [inc, snap, now])
  const fractal = fr && typeof fr === "object" && !("error" in fr) ? fr : null
  const drawing = useMemo(() => (fractal ? drawFractal(fractal) : null), [fractal])
  useEffect(() => { if (id && fr === undefined) void loadFractal(id) }, [id, fr, loadFractal])
  // A tapped notification can name an issue that is gone; the workspace chat still has what Tria said.
  const tenant = useStore(s => s.tenant)
  const navigate = useStore(s => s.navigate)
  const room = useMessenger(s => s.rooms.find(r => r.kind !== "dm" && r.workspace === tenant))
  const gone = !!snap && (!inc || !row)
  useEffect(() => { if (gone) useMessenger.getState().start() }, [gone])

  if (!inc || !row) {
    return html`
      <main class="screen">
        <${Header} title="Issue" size=${15} />
        <span style=${{ fontSize: 12.5, color: "var(--muted)" }}>
          ${snap ? "This issue is no longer in the tenant's issue list." : "Loading…"}
        </span>
        ${room && html`
          <${Tap} bg onClick=${() => navigate({ screen: "chat", roomId: room.id, roomName: room.name })} style=${{ display: "flex", alignItems: "center", justifyContent: "center", background: "var(--surface2)", borderRadius: 8, padding: 12, fontSize: 13.5 }}>
            Open the workspace chat
          <//>
        `}
      </main>
    `
  }

  const drawn = fractal ? 1 + 5 + fractal.counts.reduce((a, b) => a + b, 0) : 0
  const tally = fractal ? { ...fractal.roleTally, ...pick(fractal.kindTally, ["status", "episode", "memory"]) } : {}
  const legend = fractal ? [
    { label: "affected", n: fractal.affected, color: "#9ca3af" },
    { label: "root", n: tally.root ?? 0, color: "#ef4444" },
    { label: "symptom", n: tally.symptom ?? 0, color: "#f59e0b" },
    { label: "recovery", n: tally.recovery ?? 0, color: "#22c55e" },
    { label: "status", n: tally.status ?? 0, color: "#38bdf8" },
    { label: "episode", n: tally.episode ?? 0, color: "#6b7280" },
    { label: "memory", n: tally.memory ?? 0, color: "#a78bfa" },
  ].filter(x => x.n > 0) : []

  const timeline = [
    { t: inc.firstSeen, label: "opened" },
    ...(inc.relatedEventDetails ?? []).map(e => ({ t: e.timestamp, label: `${e.type ?? "event"} · ${e.message ?? ""}` })),
    ...(inc.lastSeen && inc.lastSeen !== inc.firstSeen ? [{ t: inc.lastSeen, label: "last seen" }] : []),
    ...(inc.resolution?.resolvedAt ? [{ t: inc.resolution.resolvedAt, label: "resolved" + (inc.resolution.resolvedBy ? " by " + inc.resolution.resolvedBy : "") }] : []),
  ].filter(x => x.t).sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())

  const failed = fr && typeof fr === "object" && "error" in fr

  return html`
    <main class="screen" style=${{ gap: 12 }}>
      <${Header}
        title=${html`<span style=${{ fontSize: 11.5, letterSpacing: ".1em", textTransform: "uppercase", color: row.color }}>${row.sev}</span>`}
        right=${html`
          <span style=${{ height: 20, padding: "0 8px", borderRadius: 999, fontSize: 11.5, display: "inline-flex", alignItems: "center", background: row.open ? "var(--tint-warn)" : "rgba(34,197,94,.16)", color: row.open ? "var(--on-warn)" : "#4ade80" }}>
            ${row.status}
          </span>
        `}
      />

      <div class="col" style=${{ gap: 5 }}>
        <span class="pretty" style=${{ fontSize: 15, lineHeight: 1.35 }}>${row.summary}</span>
        <span class="mono" style=${{ fontSize: 12, color: "var(--muted)", overflowWrap: "anywhere" }}>${row.source} · ${row.when}</span>
        ${row.context && html`
          <${Tap} onClick=${() => set({ incContextOpen: !ctxOpen })} style=${{ fontSize: 12, color: "var(--text2)", paddingTop: 2 }}>
            ${ctxOpen ? "Hide classifier context" : "Show classifier context"}
          <//>
        `}
        ${ctxOpen && row.context && html`
          <span class="mono" style=${{ fontSize: 12, lineHeight: 1.5, color: "var(--text2)", whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--surface)", borderRadius: 8, padding: "10px 11px", maxHeight: 200, overflow: "auto" }}>
            ${row.context}
          </span>
        `}
      </div>

      <div style=${{ background: "var(--well)", borderRadius: 10, padding: "10px 0 8px", display: "flex", flexDirection: "column", gap: 4 }} data-swipe="off">
        <div class="row" style=${{ gap: 8, padding: "0 12px" }}>
          <span class="kicker2">Fractal</span>
          <span class="mono" style=${{ fontSize: 12, color: "var(--muted)" }}>
            ${fractal ? `${drawn} nodes · 5 layers` : fr === "loading" ? "" : "no graph"}
          </span>
          <span style=${{ flex: 1 }} />
          ${fr === "loading" && html`<span style=${{ fontSize: 11.5, color: "var(--accent)" }}>loading…</span>`}
          ${failed && html`
            <${Tap} onClick=${() => void loadFractal(id)} style=${{ fontSize: 11.5, color: "var(--accent)" }}>retry<//>
          `}
        </div>
        ${failed && html`
          <span class="mono" style=${{ fontSize: 11.5, lineHeight: 1.4, color: "#f59e0b", padding: "2px 12px 4px", wordBreak: "break-word" }}>
            Blast graph unavailable: ${fr.error}
          </span>
        `}
        ${drawing ? html`
          <svg viewBox="0 0 370 300" style=${{ width: "100%", height: 262 }} role="img" aria-label="Issue fractal graph">
            <g fill="none" stroke="#4b5563" stroke-width="0.7" opacity="0.65">
              ${drawing.edges.map((e, i) => html`<path key=${i} d=${e.d} />`)}
            </g>
            <g>
              ${drawing.nodes.map((n, i) => html`<circle key=${i} cx=${n.x} cy=${n.y} r=${n.r} fill=${n.fill} stroke=${n.stroke} stroke-width="1.2" />`)}
            </g>
            <g font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="9.5" fill="#b5abfc">
              ${drawing.labels.map((l, i) => html`<text key=${i} x=${l.x} y=${l.y}>${LAYER_NAMES[i]}</text>`)}
            </g>
          </svg>
        ` : html`
          <div style=${{ height: 80, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11.5, color: "var(--muted)" }}>
            ${fr === "loading" ? "" : "Nothing to draw."}
          </div>
        `}
        ${legend.length > 0 && html`
          <div class="row" style=${{ gap: 11, padding: "0 12px", flexWrap: "wrap", fontSize: 11, color: "var(--text2)" }}>
            ${legend.map(l => html`
              <span key=${l.label} class="row" style=${{ gap: 4 }}>
                <span style=${{ width: 6, height: 6, borderRadius: 99, background: l.color, display: "block" }} />${l.label} ${l.n}
              </span>
            `)}
          </div>
        `}
      </div>

      ${fractal && html`
        <div class="col" style=${{ gap: 1 }}>
          ${LAYER_NAMES.map((label, i) => html`
            <div key=${label} class="row hair" style=${{ gap: 10, padding: "9px 0", overflow: "hidden" }}>
              <span style=${{ width: 7, height: 7, borderRadius: 99, background: LAYER_TINTS[i], display: "block", flexShrink: 0 }} />
              <span style=${{ fontSize: 13.5, width: 96, flexShrink: 0 }}>${label}</span>
              <span class="grow clamp2" style=${{ fontSize: 11, lineHeight: 1.35, color: "var(--text2)" }}>${fractal.details[i]}</span>
              <${Icon} name="caret-right" size=${12} color="#595d6c" style=${{ flexShrink: 0 }} />
            </div>
          `)}
        </div>
      `}

      ${(row.rootCause || row.fix || inc.investigationPlan?.hypothesis) && html`
        <div class="col" style=${{ gap: 8 }}>
          <${Kicker} light>Diagnosis<//>
          <div class="card col" style=${{ padding: 12, gap: 8 }}>
            ${row.rootCause && html`<${Fact} k="Root cause" v=${row.rootCause} />`}
            ${row.fix && html`<${Fact} k="Fix" v=${row.fix} />`}
            ${inc.investigationPlan?.hypothesis && html`<${Fact} k="Hypothesis" v=${inc.investigationPlan.hypothesis} />`}
          </div>
        </div>
      `}

      ${timeline.length > 0 && html`
        <div class="col" style=${{ gap: 8, paddingBottom: 6 }}>
          <${Kicker} light>Timeline<//>
          <div class="col" style=${{ gap: 0 }}>
            ${timeline.map((t, i) => html`
              <div key=${i} class="row" style=${{ gap: 10, alignItems: "flex-start", padding: "6px 0" }}>
                <span class="mono" style=${{ fontSize: 11, color: "var(--muted)", width: 118, flexShrink: 0 }}>${fmtClock(t.t, now)}</span>
                <span class="grow clamp2" style=${{ fontSize: 12, lineHeight: 1.4, color: "var(--text-body)" }}>${t.label}</span>
              </div>
            `)}
          </div>
        </div>
      `}
    </main>
  `
}

function Fact({ k, v }) {
  return html`
    <div class="col" style=${{ gap: 2 }}>
      <span style=${{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--muted)" }}>${k}</span>
      <span class="pretty" style=${{ fontSize: 12.5, lineHeight: 1.45, color: "var(--text-body)" }}>${v}</span>
    </div>
  `
}

function pick(o, keys) {
  const out = {}
  for (const k of keys) if (o[k]) out[k] = o[k]
  return out
}
