import { html, useMemo } from "../vendor/preact-htm.js"
import { buildVitals, CRITICAL_WEIGHT } from "../model/vitals.js"
import { stepGoal } from "../../tui/rings.js"
import { clamp, pct } from "../model/format.js"
import { useStore } from "../state/store.js"
import { Header, Kicker, Tap } from "../components/ui.js"
import { Icon } from "../components/Icon.js"

export function GoalsScreen() {
  const snap = useStore(s => s.snap)
  const goals = useStore(s => s.goals)
  const source = useStore(s => s.goalSource)
  const setGoals = useStore(s => s.setGoals)
  const resetGoals = useStore(s => s.resetGoals)
  const navigate = useStore(s => s.navigate)
  const now = snap?.fetchedAt ?? Date.now()
  const m = useMemo(() => buildVitals(snap, goals, now), [snap, goals, now])
  const g = goals
  // A goal changed here becomes the viewer's own; the rest follow the tenant's.
  const put = (p) => setGoals(p)
  const SRC = { own: "yours", tenant: "tenant", default: "default" }
  const anyOwn = Object.values(source).includes("own")

  const { use, red, sig } = m.infra
  const step = (k, d) => put({ [k]: stepGoal(k, g[k], d) })
  const stepInc = (d) => step("inc", d)
  const iw = m.incWeek

  const arms = [use, red, sig]
  const canAdopt = arms.some(a => a.value != null)
  const adopt = () => {
    if (!canAdopt) return
    const from = (a, cur) => (a.value != null ? clamp(Math.floor(a.value), 50, 100) : cur)
    put({ use: from(use, g.use), red: from(red, g.red), sig: from(sig, g.sig) })
  }
  const nowOf = (a) => a.now
  const baselineNote = canAdopt
    ? `Tap to set USE ${nowOf(use)}, RED ${nowOf(red)} and SIG ${nowOf(sig)} — this tenant's current numbers. Then tighten one at a time.`
    : "This tenant has not reported any infra health yet, so there is nothing to start from."

  const cards = [
    { id: "use", k: "Saturation", dot: "#22d3ee", what: "Saturation: memory against its limit, CPU, memory and I/O pressure stalls, and OOM kills across your services. 100 means nothing is under pressure.", now: nowOf(use), val: String(g.use), down: () => step("use", -1), up: () => step("use", 1) },
    { id: "red", k: "Reliability", dot: "#e879f9", what: "Request errors and p99 latency combined, errors weighing a little more. 100 means every service answers cleanly and fast.", now: nowOf(red), val: String(g.red), down: () => step("red", -1), up: () => step("red", 1) },
    { id: "sig", k: "Traffic", dot: "#8b8bf0", what: "Traffic against each service's own baseline. 100 means no service has gone quiet or fallen away.", now: nowOf(sig), val: String(g.sig), down: () => step("sig", -1), up: () => step("sig", 1) },
    { id: "inc", k: "Readiness", dot: "#fbbf24", what: iw?.critical != null
      ? `Your goal ÷ issues opened this week, up to 100%. This week: ${iw.thisWeek} issues, ${iw.critical} critical; a critical counts as ${CRITICAL_WEIGHT}, so ${iw.weighted} against a goal of ${m.incGoal}${m.deployments > 1 ? ` (${m.deployments} deployments × ${g.inc})` : ""}.`
      : `Your goal ÷ issues opened this week, up to 100%. A critical counts as ${CRITICAL_WEIGHT}.`,
    now: pct(m.fills.inc), val: "≤ " + g.inc + "/wk" + (m.deployments > 1 ? " × " + m.deployments : ""), down: () => stepInc(-1), up: () => stepInc(1) },
  ]
  const btn = { width: 40, height: 40, borderRadius: 8, background: "var(--line2)", display: "flex", alignItems: "center", justifyContent: "center" }

  return html`
    <main class="screen" style=${{ gap: 18 }}>
      <${Header}
        title="Goals"
        right=${html`
          <${Tap} bg onClick=${() => navigate({ screen: "predict" })} style=${{ display: "inline-flex", alignItems: "center", gap: 5, height: 28, padding: "0 10px", borderRadius: 999, background: "var(--surface3)", fontSize: 11, color: "var(--text-body)" }}>
            <${Icon} name="chart-line-up" size=${14} color="var(--accent)" />Trends
          <//>
        `}
      />
      <div class="col" style=${{ gap: 8 }}>
        <${Kicker} light>USE · RED · Signals framework<//>
        <div class="col" style=${{ gap: 1 }}>
          ${TERMS.map(t => html`
            <div key=${t.k} class="col hair" style=${{ gap: 2, padding: "9px 0" }}>
              <span style=${{ fontSize: 13.5 }}>${t.k} <span style=${{ color: "var(--muted)" }}>· ${t.means}</span></span>
              <span class="pretty" style=${{ fontSize: 11.5, lineHeight: 1.5, color: "var(--muted)" }}>${t.note}</span>
            </div>
          `)}
        </div>
      </div>

      <p class="pretty" style=${{ fontSize: 13, lineHeight: 1.55, color: "var(--text2)" }}>
        A ring closes when its arm of infra health meets the goal. These are the promises you make to the people you serve — not defaults from us. The word under the rings is separate: it only reflects what is open or degraded right now.
      </p>

      <${Tap} onClick=${adopt} className="note" style=${{ opacity: canAdopt ? 1 : 0.6 }}>
        <${Icon} name="magic-wand" size=${16} color="var(--accent)" style=${{ flexShrink: 0, marginTop: 2 }} />
        <span class="grow col" style=${{ gap: 2 }}>
          <span style=${{ fontSize: 13.5, color: "var(--text)" }}>Start from what you do today</span>
          <span class="pretty" style=${{ fontSize: 11, lineHeight: 1.4, color: "var(--text2)" }}>${baselineNote}</span>
        </span>
      <//>

      <div class="col" style=${{ gap: 10 }}>
        ${cards.map(c => html`
          <div key=${c.k} class="card col" style=${{ padding: 14, gap: 10 }}>
            <div class="row" style=${{ gap: 8 }}>
              <span style=${{ width: 8, height: 8, borderRadius: 99, background: c.dot, display: "block" }} />
              <span style=${{ fontSize: 13.5 }}>${c.k}</span>
              <span style=${{ flex: 1 }} />
              <span style=${{ fontSize: 11, color: "var(--muted)" }}>${SRC[source[c.id]]} · now ${c.now}</span>
            </div>
            <div class="row" style=${{ gap: 14 }}>
              <${Tap} bg label=${"Lower " + c.k + " goal"} onClick=${c.down} style=${btn}><${Icon} name="minus" size=${15} color="var(--text-body)" /><//>
              <span class="mono" style=${{ flex: 1, textAlign: "center", fontSize: 22, fontWeight: 500 }}>${c.val}</span>
              <${Tap} bg label=${"Raise " + c.k + " goal"} onClick=${c.up} style=${btn}><${Icon} name="plus" size=${15} color="var(--text-body)" /><//>
            </div>
            <span class="pretty" style=${{ fontSize: 11, lineHeight: 1.4, color: "var(--text2)" }}>${c.what}</span>
          </div>
        `)}
      </div>

      <div class="note" style=${{ alignItems: "center", gap: 12, padding: 13 }}>
        <span style=${{ fontSize: 30, fontWeight: 500, letterSpacing: "-0.02em" }}>${m.attainPct}</span>
        <div class="grow col" style=${{ gap: 2 }}>
          <span style=${{ fontSize: 12, color: "var(--text-body)" }}>At these goals · ${m.goalsMet}</span>
          <span style=${{ fontSize: 11, color: "var(--muted)" }}>${m.attainMath}</span>
        </div>
      </div>
      ${anyOwn
        ? html`<${Tap} onClick=${resetGoals} style=${{ fontSize: 11, color: "var(--muted-b)", textAlign: "left" }}>The goals you set are stored in this browser. Tap to go back to the tenant's.<//>`
        : html`<span style=${{ fontSize: 11, color: "var(--muted-b)" }}>These are the tenant's goals. One you change becomes yours, stored in this browser.</span>`}
    </main>
  `
}

const TERMS = [
  { k: "USE", means: "utilisation · saturation · errors", note: "A method for resources such as CPU, memory and disks: how busy each is, how much work is queued behind it, and how often it fails." },
  { k: "RED", means: "rate · errors · duration", note: "A method for services: requests per second, how many of them fail, and how long they take." },
  { k: "Golden signals", means: "latency · traffic · errors · saturation", note: "The four signals to watch on any service: response time, demand, failure rate, and how full the service is." },
]
