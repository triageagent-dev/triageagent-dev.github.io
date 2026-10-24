import { html } from "../vendor/preact-htm.js"
import { buildCost } from "../model/cost.js"
import { compact, count, DASH } from "../model/format.js"
import { useStore, useTenantName } from "../state/store.js"
import { ConnBanner, Empty, Header, Kicker } from "../components/ui.js"

/**
 * Cost (Pro). The core has no billing or cloud-spend API, so there are no
 * dollar figures here — only the LLM and voice token usage the core does
 * report for this tenant.
 */
export function Cost() {
  const snap = useStore(s => s.snap)
  const tenant = useStore(s => s.tenant)
  const tenantName = useTenantName(tenant)
  const c = buildCost(snap)
  const usedPct = c?.tenantToday != null && c.tenantCap ? Math.min(100, (c.tenantToday / c.tenantCap) * 100) : null

  return html`
    <main class="screen">
      <${Header} back=${false} title="Cost" right=${html`<span style=${{ fontSize: 12, color: "var(--muted)" }}>${tenantName}</span>`} />
      <${ConnBanner} />

      <div style=${{ background: "var(--surface)", borderRadius: 12, padding: 15, display: "flex", flexDirection: "column", gap: 7, boxShadow: "inset 0 0 0 1px var(--line2)" }}>
        <span class="kicker">Spend</span>
        <div class="row" style=${{ alignItems: "baseline", gap: 9 }}>
          <span style=${{ fontSize: 34, fontWeight: 500, letterSpacing: "-0.03em", lineHeight: 1, color: "var(--muted)" }}>${DASH}</span>
        </div>
        <span class="pretty" style=${{ fontSize: 12, color: "var(--muted)" }}>Cloud spend is not available from this core — it reports no billing data, so no dollar figure is shown.</span>
      </div>

      ${c && html`
        <div class="col" style=${{ gap: 9 }}>
          <${Kicker} light>Event processing<//>
          <div class="col" style=${{ gap: 1 }}>
            <${Stat} k="Events" v=${count(c.events)} />
            <${Stat} k="LLM tokens" v=${compact(c.lifetimeTokens)} />
            <${Stat} k="Guard rails"
              v=${c.guardCalls == null ? DASH : html`${count(c.guardCalls)}<span style=${{ color: "#ef4444", marginLeft: 6 }}>${count(c.guardRejected)}</span>`} />
            <${Stat} k="Voice sessions" v=${count(c.voiceCalls)} />
            <${Stat} k="Embedding calls" v=${compact(c.embeddingCalls)} />
          </div>
          <span class="pretty" style=${{ fontSize: 11, color: "var(--muted-b)" }}>Events and LLM tokens are this tenant's. Guard rails (passed to the model, then rejected in red), voice sessions and embedding calls count the whole instance.</span>
        </div>
      `}

      <div class="col" style=${{ gap: 9 }}>
        <${Kicker} light right=${html`<span style=${{ fontSize: 11.5, color: "var(--muted)" }}>resets 00:00 UTC</span>`}>LLM tokens today<//>
        ${c ? html`
          <div class="card col" style=${{ padding: 13, gap: 9 }}>
            <div class="row" style=${{ alignItems: "baseline", gap: 8 }}>
              <span style=${{ fontSize: 26, fontWeight: 500, letterSpacing: "-0.02em" }}>${compact(c.tenantToday)}</span>
              <span style=${{ fontSize: 12, color: "var(--muted)" }}>of ${c.tenantCap != null ? compact(c.tenantCap) + " tenant cap" : "no tenant cap"}</span>
            </div>
            ${usedPct != null && html`
              <span style=${{ height: 6, borderRadius: 99, background: "var(--surface2)", display: "block", overflow: "hidden" }}>
                <span style=${{ display: "block", height: 6, borderRadius: 99, width: usedPct + "%", background: usedPct >= 90 ? "#ef4444" : usedPct >= 70 ? "#f59e0b" : "#9184d9" }} />
              </span>
            `}
            <${Row} k="Instance limit" v=${c.dailyLimit != null ? compact(c.dailyLimit) + " / day" : DASH} />
            <${Row} k="Voice today" v=${c.voiceToday != null ? compact(c.voiceToday) + (c.voiceLimit ? " of " + compact(c.voiceLimit) : "") : DASH} />
          </div>
        ` : snap ? html`<${Empty}>Status did not answer for this tenant.<//>` : null}
      </div>

      ${c && html`
        <div class="col" style=${{ gap: 9 }}>
          <${Kicker} light>Lifetime · this tenant<//>
          <div class="col" style=${{ gap: 1 }}>
            <${Row} k="Prompt / completion" v=${`${compact(c.promptTokens)} / ${compact(c.completionTokens)}`} hair />
            <${Row} k="Calls" v=${c.calls == null ? DASH : c.calls.toLocaleString("en-US")} hair />
          </div>
        </div>
      `}
    </main>
  `
}

function Stat({ k, v }) {
  return html`
    <div class="row hair" style=${{ gap: 10, padding: "10px 0" }}>
      <span class="grow" style=${{ fontSize: 13, color: "var(--text-body)" }}>${k}</span>
      <span class="mono" style=${{ fontSize: 12.5, color: "var(--text)" }}>${v}</span>
    </div>
  `
}

function Row({ k, v, hair }) {
  return html`
    <div class=${"row" + (hair ? " hair" : "")} style=${{ gap: 10, padding: hair ? "10px 0" : 0 }}>
      <span class="grow" style=${{ fontSize: 13, color: "var(--text-body)" }}>${k}</span>
      <span class="mono" style=${{ fontSize: 12, color: "var(--text2)" }}>${v}</span>
    </div>
  `
}
