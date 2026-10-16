import { html, useMemo } from "../vendor/preact-htm.js"
import { issueRow, rankIssues } from "../model/vitals.js"
import { useStore } from "../state/store.js"
import { Avatar, ConnBanner, Header, Tap } from "../components/ui.js"

export function Issues() {
  const snap = useStore(s => s.snap)
  const fil = useStore(s => s.sevFilter)
  const set = useStore(s => s.set)
  const navigate = useStore(s => s.navigate)
  const now = snap?.fetchedAt ?? Date.now()
  const all = useMemo(
    () => rankIssues(snap?.issues?.issues ?? []).map(i => ({ inc: i, row: issueRow(i, snap?.graph, now) })),
    [snap, now],
  )
  const match = (x) => fil === "all" ? true
    : fil === "repeat" ? !!x.inc.reopenCount
    : x.row.sevKey === fil
  const shown = all.filter(match)
  const open = all.filter(x => x.row.open).length
  const chips = [["all", "All"], ["critical", "Critical"], ["warning", "Warning"], ["repeat", "Reopened"]]
  const note = fil === "all" ? `${all.length} in window` : `${shown.length} of ${all.length} · ${fil === "repeat" ? "reopened" : fil}`

  return html`
    <main class="screen">
      <${Header}
        back=${false}
        title="Issues"
        right=${html`
          <${Avatar} />
          <span style=${{ fontSize: 12, color: "var(--muted)" }}>${snap?.issues ? `${all.length} · ${open} open` : "—"}</span>
        `}
      />
      <${ConnBanner} />
      <div class="row" style=${{ gap: 6, flexWrap: "wrap" }}>
        ${chips.map(([k, label]) => html`
          <${Tap} key=${k} className="chip" pressed=${fil === k} onClick=${() => set({ sevFilter: k })}>${label}<//>
        `)}
      </div>
      <span class="mono" style=${{ fontSize: 11, color: "var(--muted)", marginTop: -6 }}>${snap?.issues ? note : "issues not reported"}</span>

      <div class="col" style=${{ gap: 9 }}>
        ${shown.map(({ row }) => html`
          <${Tap}
            key=${row.id}
            onClick=${() => navigate({ screen: "issue", incId: row.id })}
            style=${{ background: "var(--surface)", borderRadius: 10, padding: 13, display: "flex", flexDirection: "column", gap: 7, boxShadow: `inset 2px 0 0 ${row.color}` }}
          >
            <div class="row" style=${{ gap: 8, width: "100%" }}>
              <span style=${{ fontSize: 11.5, letterSpacing: ".1em", textTransform: "uppercase", color: row.color }}>${row.sev}</span>
              ${row.repeat && html`<span class="mono" style=${{ fontSize: 11.5, color: "var(--accent-strong)" }}>${row.repeat}</span>`}
              <span style=${{ flex: 1 }} />
              <span style=${{ fontSize: 12, color: "var(--muted)" }}>${row.when}</span>
            </div>
            <div class="row" style=${{ gap: 7, width: "100%", minWidth: 0 }}>
              <span class="ellip" style=${{ fontSize: 13.5, fontWeight: 500 }}>${row.svc}</span>
              ${row.env && html`<span class="mono ellip" style=${{ fontSize: 11.5, color: "var(--muted)" }}>${row.env}</span>`}
            </div>
            <span class="pretty" style=${{ fontSize: 13, lineHeight: 1.4 }}>${row.summary}</span>
            ${row.context && html`
              <span class="clamp2 pretty" style=${{ fontSize: 11.5, lineHeight: 1.45, color: "var(--muted)" }}>${row.context.replace(/\s+/g, " ")}</span>
            `}
            <div class="row" style=${{ gap: 6, flexWrap: "wrap" }}>
              <span class="mono" style=${{ fontSize: 11.5, color: "var(--muted)" }}>${row.meta}</span>
              <span style=${{ height: 18, padding: "0 7px", borderRadius: 4, fontSize: 11.5, display: "inline-flex", alignItems: "center", background: row.open ? "var(--tint-warn)" : "rgba(34,197,94,.16)", color: row.open ? "var(--on-warn)" : "#4ade80" }}>
                ${row.status}
              </span>
            </div>
          <//>
        `)}
        ${snap?.issues && !shown.length && html`
          <span style=${{ fontSize: 12.5, color: "var(--muted)", padding: "4px 2px" }}>
            ${all.length ? "Nothing matches this filter." : "No issues for this tenant in the window."}
          </span>
        `}
      </div>
    </main>
  `
}
