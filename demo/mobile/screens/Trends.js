import { html, useMemo, useState } from "../vendor/preact-htm.js"
import { bubbleTone, heatGrid, periodSeries, prognosisRows, rankedPredictions } from "../model/trends.js"
import { buildVitals } from "../model/vitals.js"
import { ageShort, fmtDur, DASH } from "../model/format.js"
import { useStore } from "../state/store.js"
import { Avatar, ConnBanner, Empty, Header, Kicker, SourcePill, Tap } from "../components/ui.js"
import { Icon } from "../components/Icon.js"

const cell = (v) => v === 0 ? { bg: "var(--heat0)", fg: "transparent" }
  : v >= 20 ? { bg: "var(--heat4)", fg: "var(--heat-fg4)" }
  : v >= 10 ? { bg: "var(--heat3)", fg: "var(--heat-fg3)" }
  : v >= 4 ? { bg: "var(--heat2)", fg: "var(--heat-fg2)" }
  : { bg: "var(--heat1)", fg: "var(--heat-fg1)" }

/** Newest verdicts shown; the rest stay on the desktop Prognosis card. */
const PROG_MAX = 5

export function Trends() {
  const snap = useStore(s => s.snap)
  const goals = useStore(s => s.goals)
  const period = useStore(s => s.period)
  const set = useStore(s => s.set)
  const navigate = useStore(s => s.navigate)
  const now = snap?.fetchedAt ?? Date.now()
  const analytics = snap?.analytics ?? null
  const preds = useMemo(() => rankedPredictions(analytics), [analytics])
  const series = useMemo(() => periodSeries(analytics, now, period), [analytics, now, period])
  const heat = useMemo(() => heatGrid(analytics, now), [analytics, now])
  const m = useMemo(() => buildVitals(snap, goals, now), [snap, goals, now])
  const prog = useMemo(() => prognosisRows(snap?.awareness ?? null, snap?.tenant ?? ""), [snap?.awareness, snap?.tenant])
  const [openId, setOpenId] = useState(null)
  const max = Math.max(1, ...series.cols.map(c => c.n))
  const unit = period === "week" ? "week" : period === "month" ? "month" : "quarter"
  const caption = series.hasHistory ? `${series.total} across ${series.cols.length} ${unit}${series.cols.length === 1 ? "" : "s"}` : "no history"
  const seg = (p, label) => html`
    <${Tap} key=${p} onClick=${() => set({ period: p })} pressed=${period === p}
      style=${{ flex: 1, textAlign: "center", fontSize: 11.5, padding: "6px 0", borderRadius: 6, background: period === p ? "#423a6a" : "transparent", color: period === p ? "var(--text)" : "var(--text2)" }}>
      ${label}
    <//>
  `

  return html`
    <main class="screen">
      <${Header}
        back=${false}
        size=${19}
        icon=${html`<${Icon} name="chart-bar" size=${17} color="var(--accent)" />`}
        title="Trends"
        right=${html`<${SourcePill} /><${Avatar} />`}
      />
      <${ConnBanner} />

      <${Kicker} right=${html`<span style=${{ fontSize: 11.5, color: "var(--muted)" }}>${preds.length ? `${preds.length} service${preds.length === 1 ? "" : "s"} ranked` : "no precursor matches"}</span>`}>
        What is about to break
      <//>
      ${snap && !preds.length && html`
        <${Empty} icon=${html`<${Icon} name="check-circle" size=${15} color="#4ade80" style=${{ flexShrink: 0, marginTop: 1 }} />`}>
          ${analytics ? "No precursor matches for this tenant — nothing is currently trending toward an issue. Predictions appear once the analytics loop has matched a pattern." : "Analytics did not answer for this tenant."}
        <//>
      `}
      ${preds.length > 0 && html`
        <div class="row" style=${{ flexWrap: "wrap", gap: 10, justifyContent: "center", padding: "2px 0" }}>
          ${preds.slice(0, 6).map(p => {
            const size = Math.round(58 + p.p * 0.92)
            const [, fill, ring] = bubbleTone(p.p)
            return html`
              <${Tap} key=${p.key} onClick=${() => navigate({ screen: "svc", svcName: p.svc })}
                style=${{ width: size, height: size, borderRadius: 999, border: `1.5px solid ${ring}`, background: fill, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, flexShrink: 0 }}>
                <span style=${{ fontSize: p.p >= 40 ? 20 : 15, fontWeight: 500, color: "#fff" }}>${p.p}%</span>
                <span class="ellip" style=${{ fontSize: 11, color: "#fff", maxWidth: "88%" }}>${p.svc}</span>
              <//>
            `
          })}
        </div>
        <span class="pretty" style=${{ fontSize: 12, lineHeight: 1.45, color: "var(--muted)", textAlign: "center", padding: "0 4px" }}>
          ${preds[0].svc}${preds[0].env ? " · " + preds[0].env : ""} — ${preds[0].why}${preds[0].rate ? ` · ${preds[0].rate} historically` : ""}
        </span>
      `}

      <div class="col" style=${{ gap: 8, paddingTop: 4 }}>
        <${Kicker} right=${html`<span style=${{ fontSize: 11.5, color: "var(--muted)" }}>${snap?.awareness ? (prog.length > PROG_MAX ? `${PROG_MAX} of ${prog.length}` : prog.length) : DASH}</span>`}>Prognosis<//>
        ${snap && !prog.length ? html`
          <${Empty} icon=${html`<${Icon} name="compass" size=${15} color="var(--muted)" style=${{ flexShrink: 0, marginTop: 1 }} />`}>
            ${snap.awareness ? "No active prognosis yet — the knowledge pass writes one verdict per service it has an opinion on." : "The core did not answer the prognosis read."}
          <//>
        ` : html`
          <div class="col" style=${{ gap: 1 }}>
            ${prog.slice(0, PROG_MAX).map(r => {
              const open = openId === r.id
              return html`
                <div key=${r.id} class="hair col">
                  <${Tap} onClick=${() => setOpenId(open ? null : r.id)} style=${{ display: "flex", alignItems: "center", gap: 8, padding: "9px 0" }}>
                    <${Icon} name="caret-right" size=${11} color="var(--muted)" style=${{ flexShrink: 0, transform: open ? "rotate(90deg)" : undefined, transition: "transform .15s" }} />
                    <span class="grow ellip" style=${{ fontSize: 13, textAlign: "left" }}>${r.title}</span>
                    ${r.confidence && html`<span class="mono" style=${{ fontSize: 10, color: "var(--text2)", flexShrink: 0 }}>${r.confidence}</span>`}
                  <//>
                  <span style=${{ fontSize: 10.5, color: "var(--muted)", paddingLeft: 19, paddingBottom: open ? 4 : 8 }}>
                    updated ${ageShort(r.updatedAt, now) || DASH} ago
                  </span>
                  ${open && html`
                    <div class="col" style=${{ gap: 6, padding: "0 0 10px 19px" }}>
                      <p class="pretty" style=${{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--text2)", whiteSpace: "pre-line" }}>${r.content}</p>
                      ${r.svc && html`<${Tap} onClick=${() => navigate({ screen: "svc", svcName: r.svc })} style=${{ fontSize: 11.5, color: "var(--accent)", alignSelf: "flex-start" }}>Open ${r.svc} →<//>`}
                    </div>
                  `}
                </div>
              `
            })}
          </div>
        `}
      </div>

      <div class="col" style=${{ gap: 9, paddingTop: 4 }}>
        <${Kicker} right=${html`<span style=${{ fontSize: 11.5, color: "var(--muted)" }}>${caption}</span>`}>Issues over time<//>
        <div class="row" style=${{ background: "var(--surface3)", borderRadius: 8, padding: 3, gap: 3 }}>
          ${seg("week", "Week")}${seg("month", "Month")}${seg("quarter", "Quarter")}
        </div>
        ${series.hasHistory ? html`
          <div class="col" style=${{ gap: 5 }} data-swipe="off">
            <div class="row" style=${{ alignItems: "flex-end", gap: series.cols.length > 8 ? 3 : 5, height: 80 }}>
              ${series.cols.map((b, i) => html`
                <span key=${i} class="col" style=${{ flex: 1, justifyContent: "flex-end", alignItems: "center", gap: 3, height: "100%" }}>
                  <span class="mono" style=${{ fontSize: 9, color: "var(--text2)" }}>${b.n || ""}</span>
                  <span style=${{ width: "100%", borderRadius: 3, display: "block", height: Math.max(4, Math.round((b.n / max) * 100)) + "%", background: b.n === 0 ? "#262838" : b.n === max ? "#f59e0b" : "#5d5294" }} />
                </span>
              `)}
            </div>
            <div class="row" style=${{ gap: series.cols.length > 8 ? 3 : 5 }}>
              ${series.cols.map((b, i) => html`<span key=${i} style=${{ flex: 1, textAlign: "center", fontSize: 9, color: "var(--muted)" }}>${b.t}</span>`)}
            </div>
          </div>
        ` : snap && html`
          <${Empty} icon=${html`<${Icon} name="clock-counter-clockwise" size=${15} color="var(--muted)" style=${{ flexShrink: 0, marginTop: 1 }} />`}>
            No weekly issue history for this tenant yet — service baselines appear once issues have been resolved.
          <//>
        `}
      </div>

      <div class="col" style=${{ gap: 8, paddingTop: 4 }}>
        <${Kicker} light>Vitals now<//>
        <div class="col" style=${{ gap: 1 }}>
          ${[
            { k: "Infra fitness", c: "#4ade80", v: m.infra.score == null ? DASH : String(m.infra.score) },
            { k: "Awareness", c: "#8b8bf0", v: m.awarenessPct == null ? DASH : Math.round(m.awarenessPct * 10) / 10 + "%" },
            { k: "Early warning", c: "#22d3ee", v: fmtDur(m.warnSec) },
            { k: "Recovery", c: "#e879f9", v: fmtDur(m.mttrSec) },
          ].map(r => html`
            <div key=${r.k} class="hair" style=${{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0" }}>
              <span style=${{ width: 7, height: 7, borderRadius: 99, background: r.c, display: "block" }} />
              <span class="grow" style=${{ fontSize: 13 }}>${r.k}</span>
              <span class="mono" style=${{ fontSize: 12, color: "var(--text-body)" }}>${r.v}</span>
            </div>
          `)}
        </div>
        <span class="pretty" style=${{ fontSize: 11, color: "var(--muted-b)" }}>The core reports each vital as a current figure only — there is no per-vital history to draw a sparkline from.</span>
      </div>

      <${Kicker} light right=${html`<span style=${{ fontSize: 11.5, color: "var(--muted)" }}>top ${heat.rows.length} · 8 weeks</span>`}>Issue history<//>
      ${heat.rows.length ? html`
        <div style=${{ background: "var(--surface2)", borderRadius: 10, padding: "11px 12px 12px", display: "flex", flexDirection: "column", gap: 5 }} data-swipe="off">
          <div class="row" style=${{ gap: 3, paddingLeft: 96 }}>
            ${heat.weeks.map(w => html`<span key=${w} style=${{ flex: 1, textAlign: "center", fontSize: 8.5, color: "var(--muted)" }}>${w}</span>`)}
            <span style=${{ width: 22, textAlign: "right", fontSize: 8.5, color: "var(--muted)" }}>Σ</span>
          </div>
          ${heat.rows.map(r => html`
            <${Tap} key=${r.n} onClick=${() => navigate({ screen: "svc", svcName: r.n })} style=${{ display: "flex", alignItems: "center", gap: 3 }}>
              <span class="ellip" style=${{ width: 93, flexShrink: 0, paddingRight: 3, textAlign: "right", fontSize: 11.5, color: "var(--text-body)" }}>${r.n}</span>
              ${r.v.map((v, i) => html`
                <span key=${i} style=${{ flex: 1, height: 19, borderRadius: 4, background: cell(v).bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: cell(v).fg }}>${v || ""}</span>
              `)}
              <span class="mono" style=${{ width: 22, textAlign: "right", fontSize: 11, color: "var(--text2)" }}>${r.total}</span>
            <//>
          `)}
          <div class="row" style=${{ gap: 9, paddingTop: 4, fontSize: 9, color: "var(--muted)" }}>
            ${[["var(--heat1)", "1–3"], ["var(--heat2)", "4–9"], ["var(--heat3)", "10–19"], ["var(--heat4)", "20+"]].map(([c, l]) => html`
              <span key=${l} class="row" style=${{ gap: 4 }}><span style=${{ width: 9, height: 9, borderRadius: 3, background: c, display: "block" }} />${l}</span>
            `)}
          </div>
        </div>
      ` : snap && html`
        <${Empty} icon=${html`<${Icon} name="clock-counter-clockwise" size=${15} color="var(--muted)" style=${{ flexShrink: 0, marginTop: 1 }} />`}>
          No per-service issue history in the last 8 weeks — this tenant has no service baselines in that window.
        <//>
      `}
    </main>
  `
}
