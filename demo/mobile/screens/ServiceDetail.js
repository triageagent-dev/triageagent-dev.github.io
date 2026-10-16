import { html, useMemo } from "../vendor/preact-htm.js"
import { buildService, depGeometry } from "../model/service.js"
import { DASH, fmtDurShort } from "../model/format.js"
import { current, useStore } from "../state/store.js"
import { Kicker, Tap } from "../components/ui.js"
import { Bars } from "../components/vitals.js"
import { Icon } from "../components/Icon.js"

const CR = 2 * Math.PI * 30

export function ServiceDetail() {
  const name = useStore(s => current(s).svcName ?? "")
  const snap = useStore(s => s.snap)
  const back = useStore(s => s.back)
  const hi = useStore(s => s.hi)
  const navigate = useStore(s => s.navigate)
  const now = snap?.fetchedAt ?? Date.now()
  const d = useMemo(() => buildService(snap, name, now), [snap, name, now])
  const dg = useMemo(() => depGeometry(d.up, d.down), [d.up, d.down])
  const bandFg = d.score == null ? "var(--muted)" : d.score >= 80 ? "#4ade80" : d.score >= 60 ? "#d2cefd" : "#f59e0b"
  const sit = d.situation
  const golden = d.app?.golden
  const issues = (snap?.issues?.issues ?? []).filter(i => (i.source ?? "").split("/").pop()?.startsWith(name))

  // [key, value] rows.
  const live = [
    ...(sit ? [
      ["status", `${sit.ready === false ? "not ready" : "ready"}${sit.components ? " " + sit.components : ""}`],
      ...(sit.reasons?.length ? [["why listed", sit.reasons.join(", ")]] : []),
      ...(sit.memPct != null ? [["memory", `${Math.round(sit.memPct)}% of limit${sit.memAboveFor ? " · above for " + sit.memAboveFor : ""}`]] : []),
      ...(sit.p99Ms != null ? [["p99", `${Math.round(sit.p99Ms * 10) / 10} ms`]] : []),
      ...(sit.errPct != null ? [["errors", `${Math.round(sit.errPct * 10) / 10}%`]] : []),
      ...Object.entries(sit.anomalies ?? {}).map(([k, a]) => [k + " anomalies", `${a.last1h ?? 0} in 1 h · ${a.last24h ?? 0} in 24 h`]),
      ...(sit.matched ? [["shared with", sit.matched]] : []),
    ] : []),
    ...(!sit && golden?.memPct != null ? [["memory", `${Math.round(golden.memPct)}% of limit`]] : []),
    // Service ledger (core ADR-061): every event counted against the service.
    ...d.ledger.flatMap(row => Object.entries(row.families).map(([fam, c]) => [
      `${fam} events${d.ledger.length > 1 && row.instance ? " · " + row.instance : ""}`,
      `${c.last1h} in 1 h · ${c.last24h} in 24 h${c.runSince ? " · firing for " + fmtDurShort((now - Date.parse(c.runSince)) / 1000) : ""}`,
    ])),
    ...(!sit && golden?.p99Ms != null ? [["p99", `${Math.round(golden.p99Ms * 10) / 10} ms`]] : []),
  ]

  return html`
    <main class="screen">
      <div class="row" style=${{ gap: 9 }}>
        <${Tap} bg label="Back" onClick=${() => (hi > 0 ? back() : navigate({ screen: "graph" }))}
          style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 999, background: "var(--surface3)", flexShrink: 0 }}>
          <${Icon} name="arrow-left" size=${15} color="var(--text-body)" />
        <//>
        <div class="grow col" style=${{ gap: 1 }}>
          <span class="ellip" style=${{ fontSize: 18, fontWeight: 500, letterSpacing: "-0.01em" }}>${name || DASH}</span>
          <span style=${{ fontSize: 12, color: "var(--muted)" }}>${d.domain} · team ${d.team}</span>
          <span class="mono ellip" style=${{ fontSize: 10.5, color: "var(--muted2)" }}>${d.version}</span>
        </div>
      </div>

      ${!d.found && snap && html`
        <span style=${{ fontSize: 12.5, color: "var(--muted)" }}>This service is not in the tenant's service graph or application list.</span>
      `}

      <div class="row" style=${{ gap: 16 }}>
        <div style=${{ position: "relative", width: 82, height: 82, flexShrink: 0 }}>
          <svg viewBox="0 0 82 82" style=${{ width: 82, height: 82, transform: "rotate(-90deg)" }}>
            <circle cx="41" cy="41" r="30" fill="none" stroke="#2b2741" stroke-width="9" />
            ${d.score != null && html`<circle cx="41" cy="41" r="30" fill="none" stroke=${bandFg} stroke-width="9" stroke-linecap="round" stroke-dasharray=${`${(d.score / 100) * CR} ${CR}`} />`}
          </svg>
          <div class="col" style=${{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}>
            <span style=${{ fontSize: 22, fontWeight: 500, letterSpacing: "-0.02em" }}>${d.score ?? DASH}</span>
            <span style=${{ fontSize: 7.5, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>health</span>
          </div>
        </div>
        <div class="grow col" style=${{ gap: 7 }}>
          <span style=${{ fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: bandFg }}>${d.band}</span>
          <div class="row" style=${{ gap: 14, flexWrap: "wrap" }}>
            <${Stat} k="Blast" v=${d.blast} />
            ${d.severity && html`<${Stat} k="Severity" v=${d.severity} />`}
            <${Stat} k="Depends on" v=${String(d.down.length)} />
            <${Stat} k="Depended on" v=${String(d.up.length)} />
          </div>
        </div>
      </div>
      <span style=${{ fontSize: 10.5, color: "var(--muted2)", marginTop: -6 }}>health = client-side summary of blast radius, weekly issue rate, reopen rate and readiness</span>

      ${d.about && html`<p class="pretty" style=${{ fontSize: 13.5, lineHeight: 1.5, color: "var(--text2)" }}>${d.about}</p>`}

      ${d.envs.length > 0 && html`
        <div class="col" style=${{ gap: 6 }}>
          ${d.envs.map(e => {
            const fg = e.st === "Ready" ? "var(--st-ok)" : e.st === "Degraded" ? "var(--st-warn)" : "var(--muted)"
            const bg = e.st === "Ready" ? "var(--tint-ok)" : e.st === "Degraded" ? "var(--tint-warn)" : "var(--surface3)"
            return html`
              <div key=${e.n} class="row" style=${{ background: "var(--surface2)", borderRadius: 8, padding: "9px 11px", gap: 9 }}>
                <span style=${{ width: 7, height: 7, borderRadius: 99, background: fg, display: "block", flexShrink: 0 }} />
                <span class="grow ellip mono" style=${{ fontSize: 12 }}>${e.n}</span>
                <span style=${{ fontSize: 11, color: "var(--muted)" }}>${e.comp}</span>
                <span style=${{ fontSize: 11, padding: "2px 7px", borderRadius: 99, background: bg, color: fg }}>${e.st}</span>
              </div>
            `
          })}
        </div>
      `}

      ${(d.up.length > 0 || d.down.length > 0) && html`
        <div class="col" style=${{ gap: 8 }}>
          <${Kicker} light>Dependencies<//>
          <div style=${{ background: "var(--surface)", borderRadius: 10, padding: "8px 6px", boxShadow: "inset 0 0 0 1px var(--line2)" }} data-swipe="off">
            <svg viewBox="0 0 340 236" style=${{ width: "100%" }} role="img" aria-label="Dependency map">
              ${dg.edges.map((e, i) => html`<line key=${i} x1=${e.x1} y1=${e.y1} x2=${e.x2} y2=${e.y2} stroke="#5d5294" stroke-width="0.8" stroke-opacity="0.55" />`)}
              <circle cx=${dg.cx} cy=${dg.cy} r="26" fill="none" stroke="#423a6a" stroke-width="1" />
              <circle cx=${dg.cx} cy=${dg.cy} r="15" fill="#3a3363" stroke="#b5abfc" stroke-width="1.5" />
              <text x=${dg.cx} y=${dg.cy + 38} text-anchor="middle" font-size="11" fill="#e9e9ed">${name.length > 22 ? name.slice(0, 21) + "…" : name}</text>
              ${dg.ups.map(u => html`
                <g key=${"u" + u.full} style=${{ cursor: "pointer" }} onClick=${() => navigate({ screen: "svc", svcName: u.full })}>
                  <circle cx=${u.x} cy=${u.y} r="6" fill="#20222f" stroke="#796cbf" stroke-width="1.2" />
                  <text x=${u.x} y=${u.y - 11} text-anchor="middle" font-size="9" fill="#c6cadb">${u.n}</text>
                </g>
              `)}
              ${dg.downs.map(u => html`
                <g key=${"d" + u.full} style=${{ cursor: "pointer" }} onClick=${() => navigate({ screen: "svc", svcName: u.full })}>
                  <circle cx=${u.x} cy=${u.y} r="6" fill="#20222f" stroke="#4a4e60" stroke-width="1.2" />
                  <text x=${u.x} y=${u.y + 18} text-anchor="middle" font-size="9" fill="#a4a8bb">${u.n}</text>
                </g>
              `)}
            </svg>
          </div>
          <div class="row" style=${{ gap: 14, fontSize: 11, color: "var(--text2)", padding: "0 2px", flexWrap: "wrap" }}>
            <span class="row" style=${{ gap: 5 }}><span style=${{ width: 7, height: 7, borderRadius: 99, border: "1.2px solid #796cbf", display: "block" }} />depends on ${name}</span>
            <span class="row" style=${{ gap: 5 }}><span style=${{ width: 7, height: 7, borderRadius: 99, border: "1.2px solid #4a4e60", display: "block" }} />${name} depends on</span>
          </div>
        </div>
      `}

      <div class="col" style=${{ gap: 8 }}>
        <${Kicker} light right=${html`<span style=${{ fontSize: 11.5, color: "var(--muted)" }}>${snap?.situation?.builtAt ? "situation frame" : ""}</span>`}>Live signals<//>
        ${live.length ? html`
          <div class="col" style=${{ gap: 1 }}>
            ${live.map(([k, v]) => html`
              <div key=${k} class="row hair" style=${{ gap: 10, padding: "8px 0", alignItems: "baseline" }}>
                <span style=${{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--muted)", width: 96, flexShrink: 0 }}>${k}</span>
                <span class="mono grow" style=${{ fontSize: 12, color: "var(--text-body)", overflowWrap: "anywhere" }}>${v}</span>
              </div>
            `)}
          </div>
        ` : html`<span style=${{ fontSize: 12, color: "var(--muted)" }}>Nothing notable reported for this service right now.</span>`}
        ${issues.length > 0 && html`
          <${Tap} onClick=${() => navigate({ screen: "issue", incId: issues[0].id })} style=${{ fontSize: 12, color: "var(--accent)" }}>
            ${issues.length} issue${issues.length === 1 ? "" : "s"} on record · latest ${issues[0].id}
          <//>
        `}
      </div>

      <div class="col" style=${{ gap: 9 }}>
        <${Kicker} light right=${html`<span style=${{ fontSize: 11.5, color: "var(--muted)" }}>tenant-wide · 5 h · 5 m buckets</span>`}>Signals<//>
        ${d.collectors.map(c => html`
          <div key=${c.k} style=${{ background: "var(--surface2)", borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7 }}>
            <div class="row" style=${{ alignItems: "baseline", gap: 7 }}>
              <span style=${{ width: 7, height: 7, borderRadius: 99, background: c.c, display: "block", alignSelf: "center" }} />
              <span style=${{ fontSize: 12, fontWeight: 500 }}>${c.k}</span>
              <span style=${{ fontSize: 11.5, color: "var(--muted)" }}>${c.label}</span>
              <span style=${{ flex: 1 }} />
              <span class="mono" style=${{ fontSize: 14, color: "var(--text)" }}>${c.v}</span>
            </div>
            ${c.bars.length > 0 && c.bars.some(Boolean) && html`<${Bars} values=${c.bars.slice(-30)} color=${c.c} />`}
          </div>
        `)}
      </div>

      <div class="col" style=${{ gap: 8 }}>
        <${Kicker} light right=${html`<span style=${{ fontSize: 11.5, color: "var(--muted)" }}>tenant-wide</span>`}>Value scorecard<//>
        <div class="col" style=${{ gap: 1 }}>
          ${d.scorecard.map(v => html`
            <div key=${v.k} class="row hair" style=${{ alignItems: "baseline", gap: 10, padding: "9px 0" }}>
              <span style=${{ fontSize: 13.5, width: 104, flexShrink: 0 }}>${v.k}</span>
              <span class="mono" style=${{ fontSize: 13, color: "var(--accent-strong)", width: 52, flexShrink: 0 }}>${v.v}</span>
              <span class="grow" style=${{ fontSize: 12, color: "var(--muted)" }}>${v.note}</span>
            </div>
          `)}
        </div>
      </div>
    </main>
  `
}

function Stat({ k, v }) {
  return html`
    <div class="col" style=${{ gap: 2 }}>
      <span style=${{ fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>${k}</span>
      <span class="mono" style=${{ fontSize: 14, color: "var(--text)" }}>${v}</span>
    </div>
  `
}
