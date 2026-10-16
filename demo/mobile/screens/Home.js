import { html, useMemo } from "../vendor/preact-htm.js"
import { buildVitals } from "../model/vitals.js"
import { fleetCounts } from "../model/service.js"
import { scopeApps, scopeIssues } from "../model/scope.js"
import { bubbleTone, rankedPredictions } from "../model/trends.js"
import { useStore } from "../state/store.js"
import { Avatar, ConnBanner, SourcePill, Tap } from "../components/ui.js"
import { LiveIssueCard, VitalsHero, VitalTiles } from "../components/vitals.js"
import { Icon } from "../components/Icon.js"

export function Home() {
  const snap = useStore(s => s.snap)
  const goals = useStore(s => s.goals)
  const insightOff = useStore(s => s.insightOff)
  const set = useStore(s => s.set)
  const navigate = useStore(s => s.navigate)
  const tenant = useStore(s => s.tenant)
  const cluster = useStore(s => s.cluster)
  const ns = useStore(s => s.ns)
  const scoped = useStore(s => s.scoped)
  const cycleScope = useStore(s => s.cycleScope)
  const now = snap?.fetchedAt ?? Date.now()
  const health = scoped?.key === [tenant, cluster, ns].join("|") ? scoped.body : null
  const m = useMemo(() => buildVitals(snap, goals, now, { cluster, ns, health }), [snap, goals, now, cluster, ns, health])
  const zTotal = m.zones?.total

  return html`
    <main class="screen">
      <div class="row" style=${{ gap: 8, minWidth: 0 }}>
        <!-- The tenant is named, not picked, here: a pull up from the bottom switches it. -->
        <${Tap} label="Cluster and namespace" onClick=${() => set({ ssheet: true })} style=${{ flexShrink: 1, minWidth: 0 }}>
          <span class="kicker ellip">${[tenant, cluster, ns].filter(Boolean).join(" · ")}</span>
        <//>
        <span style=${{ flex: 1 }} />
        <div class="row" style=${{ gap: 7, flexShrink: 0 }}>
          <${SourcePill} />
          <${Avatar} size=${28} />
        </div>
      </div>

      <${ConnBanner} />

      <${VitalsHero} m=${m} onSwipe=${cycleScope} />

      <div class="col" style=${{ alignItems: "center", gap: 7, marginTop: 6 }}>
        <${Tap}
          className="kicker"
          onClick=${() => navigate({ screen: "issues" })}
          style=${{ color: snap ? m.bandFg : "var(--muted)" }}
        >
          ${snap ? m.band : "—"}
        <//>
      </div>

      <${Tap} onClick=${() => navigate({ screen: "goals" })} style=${{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: -4 }}>
        <span class="kicker">Your goals</span>
        <span style=${{ flex: 1 }} />
        <span style=${{ fontSize: 11, color: "var(--muted)" }}>${m.goalsMet}</span>
      <//>

      <${VitalTiles} m=${m} goals=${goals} />

      <${FleetSummary} signals=${m.fleetSignals} scope=${{ cluster, ns }} />

      <${BreakRow} />

      ${snap && !insightOff && html`
        <div class="note">
          <${Icon} name="lightbulb" size=${16} color="var(--accent)" style=${{ flexShrink: 0, marginTop: 2 }} />
          <p class="grow pretty" style=${{ fontSize: 13.5, lineHeight: 1.45, color: "var(--text-body)" }}>${m.insight}</p>
          <${Tap} label="Dismiss" onClick=${() => set({ insightOff: true })} style=${{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 999, flexShrink: 0, margin: "-2px -3px 0 0" }}>
            <${Icon} name="x" size=${13} color="var(--muted-b)" />
          <//>
        </div>
      `}

      ${snap && m.openCount > 0 && html`
        <div class="col" style=${{ gap: 7 }}>
          <div class="row" style=${{ gap: 7 }}>
            <span style=${{ width: 7, height: 7, borderRadius: 99, background: "#ef4444", display: "block", animation: "vlisten 1.6s ease-in-out infinite" }} />
            <span style=${{ fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase", color: "#fca5a5" }}>
              ${m.openCount === 1 ? "1 open issue" : m.openCount + " open issues"}
            </span>
          </div>
          ${m.liveIssues.map(i => html`<${LiveIssueCard} key=${i.id} i=${i} />`)}
        </div>
      `}

      ${snap && m.openCount === 0 && html`
        <div style=${{ background: "var(--ok-tint)", borderRadius: 10, padding: "12px 13px", display: "flex", gap: 10, alignItems: "center", boxShadow: "inset 2px 0 0 #4ade80" }}>
          <${Icon} name="check-circle" size=${18} weight="fill" color="#4ade80" style=${{ flexShrink: 0 }} />
          <div class="grow col" style=${{ gap: 2 }}>
            <span style=${{ fontSize: 13.5, fontWeight: 500, color: "var(--ok-text)" }}>${m.degraded > 0 ? "No issues open" : "Nothing open"}</span>
            <span style=${{ fontSize: 11, lineHeight: 1.4, color: "var(--ok-text2)" }}>
              ${zTotal == null
                ? "No event figures reported for this tenant yet."
                : m.degraded > 0
                  ? `${zTotal.toLocaleString("en-US")} events triaged with no issue open — but ${m.degraded} workload${m.degraded === 1 ? " is" : "s are"} not ready.`
                  : `${zTotal.toLocaleString("en-US")} events triaged and none of them needs you now.`}
            </span>
          </div>
        </div>
      `}
    </main>
  `
}

/** Fleet summary: the tenant's applications by readiness and open issues, and the fleet's signal legend. */
function FleetSummary({ signals, scope }) {
  const apps = useStore(s => s.snap?.apps?.applications)
  const issues = useStore(s => s.snap?.issues?.issues)
  const navigate = useStore(s => s.navigate)
  if (!apps) return null
  const scopedApps = scopeApps(apps, scope)
  const { ready, degraded, down } = fleetCounts(scopedApps, scopeIssues(issues, apps, scope))
  const total = ready + degraded + down
  const parts = [
    { n: ready, c: "#4ade80", label: "ready" },
    { n: degraded, c: "#f59e0b", label: "degraded" },
    { n: down, c: "#ef4444", label: "error" },
  ]
  return html`
    <${Tap} bg onClick=${() => navigate({ screen: "graph" })} style=${{ background: "var(--surface2)", borderRadius: 10, padding: "11px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
      <span class="row" style=${{ alignItems: "baseline", gap: 8 }}>
        <span class="kicker2" style=${{ fontSize: 11.5 }}>Event zones</span>
        <span style=${{ flex: 1 }} />
        <span style=${{ fontSize: 12, color: "var(--text2)" }}>${scopedApps.length} ${scopedApps.length === 1 ? "application" : "applications"}</span>
      </span>
      <!-- One bar, three segments in proportion; an empty share draws nothing. -->
      <span style=${{ display: "flex", gap: 2, height: 8, borderRadius: 99, overflow: "hidden", background: "var(--line2)" }} aria-hidden="true">
        ${total > 0 && parts.filter(p => p.n > 0).map(p => html`
          <span key=${p.label} style=${{ flex: p.n, background: p.c, minWidth: 4 }} />
        `)}
      </span>
      <span class="row" style=${{ justifyContent: "space-between", fontSize: 12, color: "var(--text2)" }}>
        ${parts.map(p => html`
          <span key=${p.label}>
            <span class="mono" style=${{ color: p.c, fontWeight: 500 }}>${p.n}</span> ${p.label}
          </span>
        `)}
      </span>
      <span class="row" style=${{ gap: 12, fontSize: 11.5, color: "var(--muted)", flexWrap: "wrap", justifyContent: "space-between", borderTop: "1px solid var(--line2)", paddingTop: 8 }}>
        ${signals.map(s => html`
          <span key=${s.k} style=${{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style=${{ width: 6, height: 6, borderRadius: 99, background: s.c, display: "block" }} />
            ${s.k}
            <span class="mono" style=${{ color: "var(--text-body)" }}>${s.v}</span>
          </span>
        `)}
      </span>
    <//>
  `
}

/** What is about to break: the ranked precursor matches as small bubbles, in the TUI palette. */
function BreakRow() {
  const analytics = useStore(s => s.snap?.analytics ?? null)
  const navigate = useStore(s => s.navigate)
  const preds = useMemo(() => rankedPredictions(analytics), [analytics])
  if (!preds.length) return null
  return html`
    <${Tap} bg onClick=${() => navigate({ screen: "predict" })} style=${{ background: "var(--surface2)", borderRadius: 10, padding: "11px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
      <span class="row" style=${{ alignItems: "baseline", gap: 8 }}>
        <span class="kicker2" style=${{ fontSize: 11.5 }}>What is about to break</span>
        <span style=${{ flex: 1 }} />
        <span style=${{ fontSize: 12, color: "var(--text2)" }}>${preds.length > 6 ? `6 of ${preds.length}` : preds.length} ranked</span>
      </span>
      <span class="row" style=${{ gap: 6, flexWrap: "wrap" }}>
        ${preds.slice(0, 6).map(p => {
          const [, fill, ring] = bubbleTone(p.p)
          return html`
            <span key=${p.key} style=${{ width: 46, height: 46, borderRadius: 999, border: `1.5px solid ${ring}`, background: fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <span style=${{ fontSize: 12, fontWeight: 600, color: "#fff", lineHeight: 1.1 }}>${p.p}%</span>
              <span class="ellip" style=${{ fontSize: 8.5, color: "#fff", maxWidth: "86%", lineHeight: 1.1 }}>${p.svc}</span>
            </span>
          `
        })}
      </span>
    <//>
  `
}
