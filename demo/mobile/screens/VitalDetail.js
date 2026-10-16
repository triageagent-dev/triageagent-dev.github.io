import { html, useMemo } from "../vendor/preact-htm.js"
import { buildVitals } from "../model/vitals.js"
import { armRows, healthOf } from "../model/health.js"
import { pct } from "../model/format.js"
import { current, useStore } from "../state/store.js"
import { Header, Kicker, Tap } from "../components/ui.js"
import { Icon } from "../components/Icon.js"

const CO = 2 * Math.PI * 42, CI = 2 * Math.PI * 29

const DEFS = {
  use: {
    title: "USE · saturation",
    definition: "How close your services are to their resource limits: memory, pressure stalls and OOM kills. 100 means nothing is under pressure. Higher is better.",
    unit: "saturation",
  },
  red: {
    title: "RED · errors and latency",
    definition: "Request errors and p99 latency combined, errors weighing a little more (0.3 errors, 0.25 latency). 100 means every service answers cleanly and fast. Higher is better.",
    unit: "errors and latency",
  },
  sig: {
    title: "SIG · traffic",
    definition: "Each service's traffic against its own baseline. A service that has gone quiet or fallen away scores low. Higher is better. Older cores do not report it.",
    unit: "traffic",
  },
}

export function VitalDetail() {
  const metric = useStore(s => (current(s).metric ?? "use"))
  const snap = useStore(s => s.snap)
  const goals = useStore(s => s.goals)
  const navigate = useStore(s => s.navigate)
  const now = snap?.fetchedAt ?? Date.now()
  const m = useMemo(() => buildVitals(snap, goals, now), [snap, goals, now])
  const def = DEFS[metric]
  const card = m.infra[metric]
  const goal = goals[metric]
  const fill = card.fill
  const met = card.met === true
  const fg = fill == null ? "var(--muted)" : met ? "#4ade80" : "#f59e0b"
  const h = healthOf(snap)
  const rows = useMemo(() => armRows(h, metric), [h, metric])
  const listed = h?.services ? "every scored service" : "the worst services the core listed"

  const note = fill == null
    ? `No ${def.unit} figure reported for this tenant yet — the ring stays empty rather than guessing.`
    : met
      ? `Closed. ${def.title.split(" · ")[0]} is ${card.now} against a goal of ${goal}.`
      : `Short. ${def.title.split(" · ")[0]} is ${card.now} against a goal of ${goal} — ${pct(fill)} of the way there. ${card.caption === "all services ok" ? "" : "Start with " + card.caption + "."}`.trim()

  return html`
    <main class="screen" style=${{ gap: 16 }}>
      <${Header}
        title=${def.title}
        size=${17}
        right=${html`
          <${Tap} bg onClick=${() => navigate({ screen: "goals" })} style=${{ display: "inline-flex", alignItems: "center", gap: 5, height: 26, padding: "0 10px", borderRadius: 999, background: "var(--surface3)", fontSize: 11, color: "var(--text-body)" }}>
            goal ${goal}
          <//>
        `}
      />

      <div class="row" style=${{ gap: 18 }}>
        <div class="col" style=${{ width: 112, flexShrink: 0, alignItems: "center", gap: 7 }}>
          <svg viewBox="0 0 100 100" style=${{ width: 104, height: 104, transform: "rotate(-90deg)" }}>
            <circle cx="50" cy="50" r="42" fill="none" stroke="#262838" stroke-width="9" />
            ${fill != null && html`<circle cx="50" cy="50" r="42" fill="none" stroke=${fg} stroke-width="9" stroke-linecap="round" stroke-dasharray=${`${Math.max(3, Math.round(fill * CO))} ${Math.round(CO) + 1}`} />`}
            <circle cx="50" cy="50" r="29" fill="none" stroke="#262838" stroke-width="5" />
            <circle cx="50" cy="50" r="29" fill="none" stroke="#9184d9" stroke-width="5" stroke-linecap="round" stroke-dasharray=${`${Math.round(CI)} ${Math.round(CI) + 1}`} />
          </svg>
          <div class="col" style=${{ gap: 3, width: "100%" }}>
            <span class="row" style=${{ gap: 5, fontSize: 11, color: "var(--text2)" }}><span style=${{ width: 7, height: 7, borderRadius: 99, background: fg, display: "block", flexShrink: 0 }} />now ${card.now}</span>
            <span class="row" style=${{ gap: 5, fontSize: 11, color: "var(--text2)" }}><span style=${{ width: 7, height: 7, borderRadius: 99, background: "#9184d9", display: "block", flexShrink: 0 }} />goal ${goal} · full</span>
          </div>
        </div>
        <div class="col" style=${{ minWidth: 0, gap: 4 }}>
          <span style=${{ fontSize: 34, fontWeight: 500, letterSpacing: "-0.02em", lineHeight: 1 }}>${card.now}</span>
          <span style=${{ fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase", color: fg }}>${fill == null ? "no data" : met ? "Goal met" : pct(fill) + " of goal"}</span>
          <span class="pretty" style=${{ fontSize: 12, color: "var(--text2)" }}>${card.caption}</span>
          <span style=${{ fontSize: 11.5, color: "var(--muted)" }}>tenant fitness ${m.infra.score ?? "—"}</span>
        </div>
      </div>

      <p class="pretty" style=${{ fontSize: 13, lineHeight: 1.55, color: "var(--text3)" }}>${def.definition}</p>

      <div class="col" style=${{ gap: 8 }}>
        <${Kicker} right=${html`<span style=${{ fontSize: 11.5, color: "var(--muted)" }}>lowest first</span>`}>Services<//>
        ${rows.length ? html`
          <div class="col" style=${{ gap: 1 }}>
            ${rows.map(r => html`
              <${Tap} key=${r.service} onClick=${() => navigate({ screen: "svc", svcName: r.service })} className="hair" style=${{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0" }}>
                <span class="grow col" style=${{ gap: 2, minWidth: 0 }}>
                  <span class="ellip" style=${{ fontSize: 13.5, color: "var(--text-body)" }}>${r.service}${r.stale ? " · stale" : ""}</span>
                  <span class="pretty" style=${{ fontSize: 11.5, color: "var(--muted)" }}>${r.reasons.length ? r.reasons.join(" · ") : "no reasons reported"}</span>
                </span>
                <span class="col" style=${{ alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                  <span class="mono" style=${{ fontSize: 12.5, color: "var(--text-body)" }}>${Math.round(r.value)}%</span>
                  <span class="mono" style=${{ fontSize: 11, color: "var(--muted)" }}>score ${r.score}</span>
                </span>
              <//>
            `)}
          </div>
        ` : html`<span style=${{ fontSize: 12, color: "var(--muted)" }}>No service reports ${def.unit} for this tenant.</span>`}
        ${rows.length > 0 && html`<span style=${{ fontSize: 11, color: "var(--muted-b)" }}>Showing ${listed}.</span>`}
      </div>

      <div class="note">
        <${Icon} name="lightbulb" size=${16} color="var(--accent)" style=${{ flexShrink: 0, marginTop: 2 }} />
        <p class="pretty" style=${{ fontSize: 13.5, lineHeight: 1.45, color: "var(--text-body)" }}>${note}</p>
      </div>
    </main>
  `
}
