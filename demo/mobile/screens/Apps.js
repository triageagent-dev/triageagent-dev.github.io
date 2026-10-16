import { html, useMemo, useRef, useState } from "../vendor/preact-htm.js"
import { layoutGraph, CX, CY } from "../model/graph.js"
import { appStatus } from "../model/service.js"
import { buildMemory } from "../model/memory.js"
import { tenantEntry } from "../model/vitals.js"
import { DASH, num } from "../model/format.js"
import { useStore } from "../state/store.js"
import { Avatar, ConnBanner, Empty, Header, Kicker, Tap } from "../components/ui.js"
import { Icon } from "../components/Icon.js"

const stColor = (st) => st === "Ready" ? "var(--st-ok)" : st === "Degraded" ? "var(--st-warn)" : "var(--st-crit)"
const stBg = (st) => st === "Ready" ? "var(--tint-ok)" : st === "Degraded" ? "var(--tint-warn)" : "var(--tint-crit)"

export function Apps() {
  const snap = useStore(s => s.snap)
  const mode = useStore(s => s.graphMode)
  const set = useStore(s => s.set)
  const navigate = useStore(s => s.navigate)
  const layout = useMemo(() => layoutGraph(snap?.graph ?? null), [snap])
  const mem = useMemo(() => buildMemory(snap), [snap])
  const ts = tenantEntry(snap)
  const apps = snap?.apps?.applications ?? null
  const rows = (apps ?? []).map(a => {
    const st = appStatus(a)
    const name = a.application || a.serviceName || a.namespace || DASH
    return { key: [a.cluster, a.namespace, a.serviceName].join("/"), name, svc: a.serviceName || "", st, comp: a.componentsReady || DASH, tags: [a.cluster, a.namespace].filter(Boolean) }
  }).sort((a, b) => (a.st === "Ready" ? 1 : 0) - (b.st === "Ready" ? 1 : 0) || a.name.localeCompare(b.name))
  const ready = rows.filter(r => r.st === "Ready").length
  const degraded = rows.filter(r => r.st === "Degraded").length
  const down = rows.filter(r => r.st === "Down").length

  const svcPct = num(ts?.serviceCoveragePct)
  const evPct = num(ts?.coveragePct)
  const round1 = (v) => Math.round(v * 10) / 10
  const covFg = svcPct == null ? "var(--muted)" : svcPct >= 80 ? "#4ade80" : svcPct >= 50 ? "#f59e0b" : "#ef4444"

  // m: "service" | "memory"
  const segBtn = (m, label) => html`
    <${Tap} onClick=${() => set({ graphMode: m })} pressed=${mode === m}
      style=${{ flex: 1, textAlign: "center", fontSize: 11.5, padding: "6px 0", borderRadius: 6, background: mode === m ? "#423a6a" : "transparent", color: mode === m ? "var(--text)" : "var(--text2)" }}>
      ${label}
    <//>
  `

  return html`
    <main class="screen" style=${{ gap: 13 }}>
      <${Header} back=${false} size=${19} icon=${html`<${Icon} name="squares-four" size=${17} color="var(--accent)" />`}
        title=${mode === "service" ? "Service graph" : "Memory"} right=${html`<${Avatar} />`} />
      <${ConnBanner} />
      <div class="row" style=${{ background: "var(--surface3)", borderRadius: 8, padding: 3, gap: 3 }}>
        ${segBtn("service", "Services")}${segBtn("memory", "Memory")}
      </div>

      ${mode === "memory" ? (
        mem ? html`
          <div class="col" style=${{ gap: 10 }}>
            <${Kicker} right=${html`<span class="mono" style=${{ fontSize: 11.5, color: "var(--muted)" }}>
              ${mem.total == null ? DASH : mem.total.toLocaleString("en-US")} held${mem.workingSet != null ? ` · ${mem.workingSet} working set` : ""}
            </span>`}>By kind<//>
            <${MemoryBars} mem=${mem} />
          </div>
        ` : snap && html`<${Empty}>Memory did not answer for this tenant.<//>`
      ) : html`
        ${layout ? html`<${GraphView} layout=${layout} onOpen=${n => navigate({ screen: "svc", svcName: n })} />` : snap && html`
          <${Empty}>${snap.graph ? "This tenant's service graph has no nodes yet." : "The service graph did not answer for this tenant."}<//>
        `}
        ${layout && html`
          <div class="row" style=${{ gap: 12, flexWrap: "wrap", fontSize: 11, color: "var(--text2)", padding: "0 2px" }}>
            <${Legend} c="#f87171" l=${`Issue ≥${layout.issueThreshold ?? DASH}`} />
            <${Legend} c="#f59e0b" l=${`Signal ≥${layout.noiseThreshold ?? DASH}`} />
            <${Legend} c="#6f7387" l="Noise" />
            <span style=${{ flex: 1 }} />
            <span class="mono" style=${{ color: "var(--muted)" }}>${layout.nodeCount} nodes · ${layout.edgeCount} edges</span>
          </div>
        `}

        <div style=${{ background: "var(--surface2)", borderRadius: 10, padding: "11px 12px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div class="row" style=${{ alignItems: "baseline", gap: 8 }}>
            <span class="kicker2">Coverage</span>
            <span style=${{ flex: 1 }} />
            <span class="mono" style=${{ fontSize: 15, fontWeight: 500, color: covFg }}>${svcPct == null ? DASH : round1(svcPct) + "%"}</span>
          </div>
          <div style=${{ height: 6, borderRadius: 99, background: "var(--accent-tint2)", overflow: "hidden", display: "flex" }}>
            <span style=${{ width: (svcPct ?? 0) + "%", background: covFg, display: "block" }} />
          </div>
          <span class="pretty" style=${{ fontSize: 11, lineHeight: 1.45, color: "var(--muted)" }}>
            ${svcPct != null
              ? "Share of this tenant's services mapped in the service graph. An unmapped service cannot be correlated, so coverage is the ceiling on early warning."
              : "The server did not report service coverage for this tenant."}
          </span>
          ${evPct != null && html`
            <div class="row" style=${{ alignItems: "baseline", gap: 8, borderTop: "1px solid var(--line2)", paddingTop: 6, marginTop: 2 }}>
              <span style=${{ fontSize: 11, color: "var(--text2)" }}>Event coverage</span>
              <span style=${{ flex: 1 }} />
              <span class="mono" style=${{ fontSize: 12, color: evPct >= 80 ? "#4ade80" : "#f59e0b" }}>${round1(evPct)}%</span>
            </div>
          `}
        </div>
      `}

      <div class="row" style=${{ gap: 8, paddingTop: 6 }}>
        <span class="kicker2">Applications</span>
        <span style=${{ flex: 1 }} />
        ${apps && html`
          <span class="row" style=${{ gap: 9, fontSize: 12, color: "var(--text2)" }}>
            <span>${rows.length}</span>
            <${Legend} c="#4ade80" l=${String(ready)} />
            ${degraded > 0 && html`<${Legend} c="#f59e0b" l=${String(degraded)} />`}
            <${Legend} c="#ef4444" l=${String(down)} />
          </span>
        `}
      </div>
      <div class="col" style=${{ gap: 6 }}>
        ${rows.map(a => html`
          <${Tap} key=${a.key} bg onClick=${() => navigate({ screen: "svc", svcName: a.svc || a.name })}
            style=${{ background: "var(--surface2)", borderRadius: 8, padding: "9px 11px", display: "flex", alignItems: "center", gap: 9, minHeight: 44 }}>
            <span style=${{ width: 7, height: 7, borderRadius: 99, background: stColor(a.st), display: "block", flexShrink: 0 }} />
            <div class="grow col" style=${{ gap: 3 }}>
              <div class="row" style=${{ gap: 5, minWidth: 0 }}>
                <span class="ellip" style=${{ fontSize: 12, fontWeight: 500 }}>${a.name}</span>
                ${a.tags.map(t => html`<span key=${t} style=${{ fontSize: 8.5, padding: "1px 5px", borderRadius: 99, background: "var(--accent-tint2)", color: "var(--accent)", flexShrink: 0 }}>${t}</span>`)}
              </div>
              ${a.svc && a.svc !== a.name && html`<span class="mono ellip" style=${{ fontSize: 11, color: "var(--muted)" }}>service ${a.svc}</span>`}
            </div>
            <div class="col" style=${{ alignItems: "flex-end", gap: 3, flexShrink: 0 }}>
              <span style=${{ fontSize: 11, color: "var(--muted)" }}>${a.comp}</span>
              <span style=${{ fontSize: 11, padding: "2px 7px", borderRadius: 99, background: stBg(a.st), color: stColor(a.st) }}>${a.st}</span>
            </div>
          <//>
        `)}
        ${apps && !rows.length && html`<span style=${{ fontSize: 12.5, color: "var(--muted)" }}>No applications reported for this tenant.</span>`}
        ${snap && !apps && html`<span style=${{ fontSize: 12.5, color: "var(--muted)" }}>Applications did not answer for this tenant.</span>`}
      </div>
    </main>
  `
}

function Legend({ c, l }) {
  return html`<span class="row" style=${{ gap: 4 }}><span style=${{ width: 6, height: 6, borderRadius: 99, background: c, display: "block" }} />${l}</span>`
}

function GraphView({ layout, onOpen }) {
  const [v, setV] = useState({ x: 0, y: 0, k: 1 })
  // { x, y, x0, y0, moved } while a pointer is down, else null.
  const drag = useRef(null)
  const box = useRef(null)
  const zoom = (f) => setV(p => ({ ...p, k: Math.max(0.5, Math.min(4, p.k * f)) }))
  // Screen px → viewBox units, so a drag follows the finger at any width.
  const scale = () => 360 / Math.max(1, box.current?.clientWidth ?? 340)
  // Preact binds events by their DOM names: React's onDoubleClick is the
  // native "dblclick" (onDblClick). React's root wheel listener is passive and
  // this handler never calls preventDefault, so the page still scrolls as there.
  return html`
    <div
      ref=${box}
      data-swipe="off"
      onPointerDown=${e => { drag.current = { x: e.clientX, y: e.clientY, x0: v.x, y0: v.y, moved: false } }}
      onPointerMove=${e => {
        const d = drag.current
        if (!d) return
        const dx = e.clientX - d.x, dy = e.clientY - d.y
        if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
        if (d.moved) setV(p => ({ ...p, x: d.x0 + dx * scale(), y: d.y0 + dy * scale() }))
      }}
      onPointerUp=${() => { setTimeout(() => { drag.current = null }, 0) }}
      onPointerLeave=${() => { drag.current = null }}
      onWheel=${e => zoom(e.deltaY < 0 ? 1.12 : 0.89)}
      onDblClick=${() => setV({ x: 0, y: 0, k: 1 })}
      style=${{ background: "var(--bg2)", borderRadius: 12, boxShadow: "inset 0 0 0 1px var(--line2)", position: "relative", height: 300, overflow: "hidden", cursor: "grab", touchAction: "none", userSelect: "none" }}
    >
      <svg viewBox="-30 0 360 220" preserveAspectRatio="xMidYMid meet" style=${{ width: "100%", height: "100%" }} role="img" aria-label="Service graph">
        <g transform=${`translate(${CX + v.x} ${CY + v.y}) scale(${v.k}) translate(${-CX} ${-CY})`}>
          ${layout.edges.map((e, i) => html`<path key=${i} d=${e.d} fill="none" stroke="#3a3d55" stroke-width=${0.7 / Math.sqrt(v.k)} />`)}
          ${layout.nodes.map(n => html`
            <g key=${n.name} style=${{ cursor: "pointer" }} onClick=${() => { if (!drag.current?.moved) onOpen(n.name) }}>
              <circle cx=${n.x} cy=${n.y} r=${Math.max(n.r, 7)} fill="transparent" />
              <circle cx=${n.x} cy=${n.y} r=${n.r} fill=${n.c}><title>${n.name}</title></circle>
            </g>
          `)}
          ${layout.nodes.filter(n => n.named).map(n => html`
            <text key=${n.name + "-l"} x=${n.lx} y=${n.ly} text-anchor=${n.anchor} font-size=${7 / Math.sqrt(v.k)} fill="var(--muted-b)"
              style=${{ pointerEvents: "none", fontFamily: "var(--mono)" }}>
              ${n.short}
            </text>
          `)}
        </g>
      </svg>
      <div class="row" style=${{ position: "absolute", right: 8, bottom: 8, gap: 5 }}>
        <${Tap} label="Zoom out" onClick=${() => zoom(0.8)} style=${{ width: 30, height: 30, borderRadius: 8, background: "var(--btn)", display: "flex", alignItems: "center", justifyContent: "center" }}><${Icon} name="minus" size=${13} color="#cfd3e5" /><//>
        <${Tap} label="Zoom in" onClick=${() => zoom(1.25)} style=${{ width: 30, height: 30, borderRadius: 8, background: "var(--btn)", display: "flex", alignItems: "center", justifyContent: "center" }}><${Icon} name="plus" size=${13} color="#cfd3e5" /><//>
        <${Tap} onClick=${() => setV({ x: 0, y: 0, k: 1 })} style=${{ height: 30, padding: "0 9px", borderRadius: 8, background: "var(--btn)", display: "flex", alignItems: "center", fontSize: 10.5, color: "#cfd3e5" }}>Reset<//>
      </div>
    </div>
  `
}

export function MemoryBars({ mem }) {
  if (!mem.kinds.length) return html`<span style=${{ fontSize: 12, color: "var(--muted)" }}>No memory items reported.</span>`
  const max = Math.max(1, ...mem.kinds.map(k => k.n))
  return html`
    <div class="col" style=${{ gap: 7, background: "var(--well2)", borderRadius: 10, padding: "10px 12px", boxShadow: "inset 0 0 0 1px var(--line2)" }}>
      ${mem.kinds.slice(0, 10).map(k => html`
        <div key=${k.label} class="col" style=${{ gap: 3 }}>
          <div class="row" style=${{ alignItems: "baseline", gap: 8 }}>
            <span class="row" style=${{ gap: 5, fontSize: 12, color: "var(--text-body)" }}>
              <span style=${{ width: 6, height: 6, borderRadius: 99, background: k.c, display: "block" }} />${k.label}
            </span>
            <span style=${{ flex: 1 }} />
            <span class="mono" style=${{ fontSize: 11.5, color: "var(--muted)" }}>${k.n}</span>
          </div>
          <span style=${{ height: 5, borderRadius: 99, background: "var(--surface2)", display: "block", overflow: "hidden" }}>
            <span style=${{ display: "block", height: 5, borderRadius: 99, background: k.c, width: (k.n / max) * 100 + "%", opacity: 0.85 }} />
          </span>
        </div>
      `)}
      ${mem.kinds.length > 10 && html`<span style=${{ fontSize: 11, color: "var(--muted)" }}>+${mem.kinds.length - 10} more kinds</span>`}
    </div>
  `
}
