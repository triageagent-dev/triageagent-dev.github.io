import { html, useMemo } from "../vendor/preact-htm.js"
import { groupEvents, tenantEvents, ZONES, zoneColor, CLS_WHY, ZONE_LABEL } from "../model/events.js"
import { zonesOf, tenantEntry } from "../model/vitals.js"
import { fmtClock } from "../model/format.js"
import { current, useStore } from "../state/store.js"
import { Avatar, ConnBanner, Header, Tap, useSource } from "../components/ui.js"

export function Events() {
  const zone = useStore(s => current(s).zone ?? null)
  const snap = useStore(s => s.snap)
  const navigate = useStore(s => s.navigate)
  const src = useSource()
  const events = useMemo(() => tenantEvents(snap), [snap])
  const rows = useMemo(() => groupEvents(events, zone), [events, zone])
  const z = zonesOf(tenantEntry(snap))
  const now = snap?.fetchedAt ?? Date.now()
  const setZone = (v) => () => navigate({ screen: "stream", zone: v })
  const label = (k) => ZONE_LABEL[k]
  const caption = zone
    ? `${z ? z[zone].toLocaleString("en-US") + " " + ZONE_LABEL[zone].toLowerCase() + " events cumulative · " : ""}${rows.length} group${rows.length === 1 ? "" : "s"} in the last ${events.length} received`
    : `${z ? z.total.toLocaleString("en-US") + " events cumulative · " : ""}last ${events.length} received, ${rows.length} group${rows.length === 1 ? "" : "s"}`

  return html`
    <main class="screen">
      <${Header}
        back=${false}
        title="Events"
        right=${html`
          <${Avatar} />
          <span class="row" style=${{ gap: 5, fontSize: 11, color: "var(--text2)" }}>
            <span style=${{ width: 6, height: 6, borderRadius: 99, background: src.fg, display: "block" }} />${src.label.toLowerCase()}
          </span>
        `}
      />
      <${ConnBanner} />
      <div class="row" style=${{ gap: 6, flexWrap: "wrap" }}>
        <${Tap} className="chip" pressed=${!zone} onClick=${setZone(null)} style=${{ height: 28, padding: "0 11px", fontSize: 11.5 }}>All<//>
        ${ZONES.map(k => html`
          <${Tap} key=${k} className="chip" pressed=${zone === k} onClick=${setZone(k)} style=${{ height: 28, padding: "0 11px", fontSize: 11.5 }}>${label(k)}<//>
        `)}
      </div>
      <span style=${{ fontSize: 11, color: "var(--muted)" }}>${caption}</span>

      <div class="col">
        ${rows.map(g => {
          const e = g.event
          const cls = g.zone
          return html`
            <${Tap} key=${g.key} onClick=${() => navigate({ screen: "event", evKey: g.key })} className="hair" style=${{ display: "flex", gap: 11, padding: "12px 0" }}>
              <span style=${{ width: 6, height: 6, borderRadius: 99, display: "block", marginTop: 6, flexShrink: 0, background: zoneColor(cls ?? undefined) }} />
              <div class="grow col" style=${{ gap: 5 }}>
                <div class="row" style=${{ gap: 6, flexWrap: "wrap" }}>
                  <span style=${{ fontSize: 13.5, fontWeight: 500 }}>${e.type || "event"}</span>
                  <span class="mono" style=${{ height: 17, padding: "0 6px", borderRadius: 4, background: "var(--line2)", color: "var(--text2)", fontSize: 11, display: "inline-flex", alignItems: "center" }}>${cls ? ZONE_LABEL[cls].toLowerCase() : "unclassified"}</span>
                  <span style=${{ fontSize: 11, color: "var(--muted)" }}>×${g.count}</span>
                  <span style=${{ flex: 1 }} />
                  <span class="mono" style=${{ fontSize: 11, color: "var(--muted)" }}>${fmtClock(e.timestamp, now)}</span>
                </div>
                <span class="clamp2" style=${{ fontSize: 11.5, lineHeight: 1.4, color: "var(--text3)", overflowWrap: "anywhere" }}>${e.message || "—"}</span>
                <div class="row" style=${{ gap: 6, flexWrap: "wrap" }}>
                  ${e.service && html`
                    <span class="mono" style=${{ height: 16, padding: "0 6px", borderRadius: 4, background: "var(--accent-tint2)", color: "var(--accent)", fontSize: 10, display: "inline-flex", alignItems: "center", flexShrink: 0 }}>${e.service}</span>
                  `}
                  <span class="pretty" style=${{ fontSize: 10.5, lineHeight: 1.4, color: "var(--muted-b)" }}>${cls ? CLS_WHY[cls] : "not classified by the core"}</span>
                </div>
              </div>
            <//>
          `
        })}
        ${snap && !rows.length && html`
          <span style=${{ fontSize: 12.5, color: "var(--muted)", padding: "4px 2px" }}>
            ${events.length ? "Nothing in this zone among the recent events." : "No recent events reported for this tenant."}
          </span>
        `}
      </div>
    </main>
  `
}
