import { html } from "../vendor/preact-htm.js"
import { useStore } from "../state/store.js"
import { clustersOf, namespacesOf } from "../model/scope.js"
import { stop } from "./ui.js"

/**
 * Bottom sheet for Home's scope, the TUI's cluster and namespace filters: one
 * row of chips for each, "all" first. The namespaces are those of the picked
 * cluster. Swiping the rings walks the clusters and their namespaces; this picks either directly.
 */
export function ScopeSheet() {
  const open = useStore(s => s.ssheet)
  const set = useStore(s => s.set)
  const setScope = useStore(s => s.setScope)
  const cluster = useStore(s => s.cluster)
  const ns = useStore(s => s.ns)
  const apps = useStore(s => s.snap?.apps?.applications)
  if (!open) return null
  const clusters = clustersOf(apps)
  const namespaces = namespacesOf(apps, cluster)
  const close = () => set({ ssheet: false })
  const row = (title, all, items, on, pick) => html`
    <div class="col" style=${{ gap: 7 }}>
      <span class="kicker2" style=${{ fontSize: 11.5 }}>${title}</span>
      <div class="row" style=${{ gap: 6, flexWrap: "wrap" }}>
        ${[["", all], ...items.map(v => [v, v])].map(([v, label]) => html`
          <button
            type="button"
            key=${v || "all"}
            class="tap"
            aria-pressed=${on === v}
            onClick=${() => pick(v)}
            style=${{ borderRadius: 999, padding: "7px 13px", fontSize: 13, background: on === v ? "#2b2547" : "var(--surface2)", color: on === v ? "#d2cefd" : "var(--text-body)", boxShadow: on === v ? "inset 0 0 0 1px #4d4482" : "none" }}
          >${label}</button>
        `)}
      </div>
    </div>
  `
  return html`
    <div
      onClick=${close}
      style=${{ position: "absolute", inset: 0, zIndex: 30, background: "rgba(5,6,10,.62)", display: "flex", flexDirection: "column", justifyContent: "flex-end", animation: "fadeIn .15s ease" }}
    >
      <div
        role="dialog"
        aria-label="Cluster and namespace"
        data-swipe="off"
        onClick=${stop}
        style=${{
          maxHeight: "76%", background: "var(--surface)", borderRadius: "20px 20px 0 0", boxShadow: "0 -20px 44px rgba(0,0,0,.55)",
          padding: "10px 16px calc(30px + env(safe-area-inset-bottom, 0px))", display: "flex", flexDirection: "column", gap: 14, minHeight: 0, overflow: "auto",
          animation: "sheetUp .18s ease",
        }}
      >
        <span style=${{ width: 34, height: 4, borderRadius: 99, background: "#3a3d4c", alignSelf: "center", flexShrink: 0 }} />
        <span style=${{ fontSize: 15, fontWeight: 500, color: "var(--text)" }}>Cluster and namespace</span>
        ${clusters.length > 0 && row("Cluster", "all clusters", clusters, cluster, c => setScope(c, ""))}
        ${namespaces.length > 0 && row("Namespace", "all namespaces", namespaces, ns, n => setScope(cluster, n))}
      </div>
    </div>
  `
}
