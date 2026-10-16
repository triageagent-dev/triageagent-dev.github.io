import { html, useMemo } from "../vendor/preact-htm.js"
import { CLS_NOTE, ZONE_LABEL, feedSpan, groupEvents, occurrences, rawScore, relatedIssue, sourceParts, tenantEvents, zoneColor } from "../model/events.js"
import { fmtClock, fmtDurShort, firstLine } from "../model/format.js"
import { current, useStore } from "../state/store.js"
import { Header, Kicker, Tap } from "../components/ui.js"
import { Bars } from "../components/vitals.js"
import { Icon } from "../components/Icon.js"

export function EventDetail() {
  const key = useStore(s => current(s).evKey ?? "")
  const snap = useStore(s => s.snap)
  const navigate = useStore(s => s.navigate)
  const events = useMemo(() => tenantEvents(snap), [snap])
  const group = useMemo(() => groupEvents(events, null).find(g => g.key === key) ?? null, [events, key])
  const now = snap?.fetchedAt ?? Date.now()

  if (!group) {
    return html`
      <main class="screen">
        <${Header} title="Event" size=${15} />
        <span style=${{ fontSize: 12.5, color: "var(--muted)" }}>
          ${snap ? "This event has rolled out of the recent feed." : "Loading…"}
        </span>
      </main>
    `
  }
  const e = group.event
  const span = feedSpan(events)
  const occ = span ? occurrences(group.times, span.from, span.to) : []
  const related = relatedIssue(snap?.issues?.issues, e.id)
  const graph = rawScore(e.raw, ["graphScore", "graph_score", "blastRadius", "blast_radius", "score"])
  const vector = rawScore(e.raw, ["vectorScore", "vector_score", "similarity", "embeddingScore"])
  const conf = typeof e.mark_confidence === "number" ? String(Math.round(e.mark_confidence * 100) / 100) : null
  const parts = sourceParts(e.source)
  const extra = [
    ...(e.service ? [["service", e.service]] : []),
    ...(e.severity ? [["severity", e.severity]] : []),
    ...(e.state_signal ? [["state", e.state_signal]] : []),
    ...(e.relation ? [["relation", e.relation]] : []),
  ]

  return html`
    <main class="screen">
      <${Header}
        title=${html`<span class="row" style=${{ gap: 10 }}>
          <span style=${{ fontSize: 15, fontWeight: 500 }}>${e.type || "event"}</span>
          <span class="mono" style=${{ height: 19, padding: "0 7px", borderRadius: 4, background: "var(--line2)", fontSize: 11.5, display: "inline-flex", alignItems: "center", color: zoneColor(group.zone ?? undefined), letterSpacing: 0 }}>${group.zone ? ZONE_LABEL[group.zone].toLowerCase() : "unclassified"}</span>
        </span>`}
        right=${html`<span class="mono" style=${{ fontSize: 12, color: "var(--muted)" }}>${fmtClock(e.timestamp, now)}</span>`}
      />

      <div class="mono" style=${{ background: "var(--well)", borderRadius: 10, padding: 12, fontSize: 11.5, lineHeight: 1.5, color: "var(--text-body)", overflowWrap: "anywhere", maxHeight: 220, overflow: "auto" }}>
        ${e.message || "—"}
      </div>

      <div class="col" style=${{ gap: 1 }}>
        <${Row} k="source" v=${e.source || "—"} dim />
        ${parts.concat(extra).map(([k, v]) => html`<${Row} key=${k} k=${k} v=${v} />`)}
      </div>

      <div class="row" style=${{ gap: 8 }}>
        <${Tile} k=${graph ? "Graph score" : "Confidence"} v=${graph ?? conf ?? "—"} />
        <${Tile} k="Vector score" v=${vector ?? "—"} />
        <${Tile} k="Seen" v=${"×" + group.count} />
      </div>

      ${span && occ.some(Boolean) && html`
        <div class="col" style=${{ gap: 7 }}>
          <${Kicker}>Occurrences · across the feed (${fmtDurShort((span.to - span.from) / 1000)})<//>
          <${Bars} values=${occ} height=${44} />
        </div>
      `}

      ${related && html`
        <${Tap} onClick=${() => navigate({ screen: "issue", incId: related.id })} style=${{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface)", borderRadius: 10, padding: 12, boxShadow: "inset 2px 0 0 #9184d9" }}>
          <${Icon} name="warning" size=${16} color="var(--accent)" />
          <span class="grow col" style=${{ gap: 2 }}>
            <span style=${{ fontSize: 11.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text2)" }}>Related issue</span>
            <span class="ellip" style=${{ fontSize: 12, color: "var(--text-body)" }}>${firstLine(related.summary) || related.id}</span>
          </span>
          <${Icon} name="caret-right" size=${13} color="var(--muted)" />
        <//>
      `}

      <p class="pretty" style=${{ fontSize: 13.5, lineHeight: 1.5, color: "var(--text2)" }}>
        ${group.zone ? CLS_NOTE[group.zone] : "The core has not classified this event."}
      </p>
    </main>
  `
}

function Row({ k, v, dim }) {
  return html`
    <div class="row hair" style=${{ gap: 10, padding: "8px 0" }}>
      <span style=${{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--muted)", width: 64, flexShrink: 0 }}>${k}</span>
      <span class="mono grow" style=${{ fontSize: 12, color: dim ? "var(--text2)" : "var(--text-body)", overflowWrap: "anywhere" }}>${v}</span>
    </div>
  `
}

function Tile({ k, v }) {
  return html`
    <div class="col" style=${{ flex: 1, background: "var(--surface3)", borderRadius: 8, padding: "10px 11px", gap: 2, minWidth: 0 }}>
      <span class="ellip" style=${{ fontSize: 11.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--text2)" }}>${k}</span>
      <span class="mono" style=${{ fontSize: 17, fontWeight: 500 }}>${v}</span>
    </div>
  `
}
