import { html, useRef } from "../vendor/preact-htm.js"
import { tenantRows, useStore } from "../state/store.js"
import { Icon } from "./Icon.js"
import { stop } from "./ui.js"

const CLOSE_DY = 80

/**
 * Bottom-sheet tenant switcher. Every surface is scoped to one tenant;
 * picking one writes it into the persisted config (triage.cfg), closes the
 * sheet and re-queries the core. Search appears only above six tenants.
 * Dragging the sheet down follows the finger and closes it past CLOSE_DY;
 * a drag that starts in the list while it is scrolled, or in the search
 * box, is left to them.
 */
export function TenantSheet() {
  const open = useStore(s => s.tsheet)
  const tq = useStore(s => s.tq)
  const tenant = useStore(s => s.tenant)
  const set = useStore(s => s.set)
  const setTenant = useStore(s => s.setTenant)
  const readable = useStore(s => s.readable)
  const details = useStore(s => s.details)
  const snap = useStore(s => s.snap)
  const drag = useRef(null)
  if (!open) return null
  const close = () => set({ tsheet: false, tq: "" })
  const onTouchStart = (e) => {
    const t = e.target, p = e.touches[0]
    const list = t instanceof Element ? t.closest("[data-sheet-list]") : null
    if (!p || (t instanceof Element && t.closest("input")) || (list && list.scrollTop > 0)) { drag.current = null; return }
    drag.current = { y: p.clientY, dy: 0 }
  }
  const onTouchMove = (e) => {
    const d = drag.current, p = e.touches[0]
    if (!d || !p) return
    d.dy = Math.max(0, p.clientY - d.y)
    const el = e.currentTarget
    el.style.animation = "none"
    el.style.transition = "none"
    el.style.transform = `translateY(${d.dy}px)`
  }
  const onTouchEnd = (e) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.dy > CLOSE_DY) { close(); return }
    const el = e.currentTarget
    el.style.transition = "transform .15s ease"
    el.style.transform = ""
  }
  const all = tenantRows({ readable, details, snap })
  const q = tq.trim().toLowerCase()
  const shown = q ? all.filter(t => t.id.toLowerCase().includes(q)) : all
  const fmt = (n) => n.toLocaleString("en-US")

  return html`
    <div
      onClick=${close}
      style=${{ position: "absolute", inset: 0, zIndex: 30, background: "rgba(5,6,10,.62)", display: "flex", flexDirection: "column", justifyContent: "flex-end", animation: "fadeIn .15s ease" }}
    >
      <div
        role="dialog"
        aria-label="Switch tenant"
        data-swipe="off"
        onClick=${stop}
        onTouchStart=${onTouchStart}
        onTouchMove=${onTouchMove}
        onTouchEnd=${onTouchEnd}
        onTouchCancel=${onTouchEnd}
        style=${{
          maxHeight: "76%", background: "var(--surface)", borderRadius: "20px 20px 0 0", boxShadow: "0 -20px 44px rgba(0,0,0,.55)",
          padding: "10px 16px calc(30px + env(safe-area-inset-bottom, 0px))", display: "flex", flexDirection: "column", gap: 10, minHeight: 0,
          animation: "sheetUp .18s ease",
        }}
      >
        <span style=${{ width: 34, height: 4, borderRadius: 99, background: "#3a3d4c", alignSelf: "center", flexShrink: 0 }} />
        <div class="row" style=${{ alignItems: "baseline", gap: 8, flexShrink: 0 }}>
          <span style=${{ fontSize: 15, fontWeight: 500, color: "var(--text)" }}>Switch tenant</span>
          <span style=${{ flex: 1 }} />
          <span style=${{ fontSize: 11, color: "var(--muted-b)" }}>${q ? `${shown.length} of ${all.length}` : `${all.length} tenants`}</span>
        </div>
        ${all.length > 6 && html`
          <input
            value=${tq}
            onInput=${e => set({ tq: e.currentTarget.value })}
            placeholder="Find a tenant"
            aria-label="Find a tenant"
            style=${{ flexShrink: 0, background: "var(--bg)", border: "1px solid var(--input-line)", borderRadius: 999, padding: "8px 13px", fontSize: 12.5, color: "var(--text)", outline: "none" }}
          />
        `}
        <div style=${{ height: 1, background: "var(--line2)", flexShrink: 0 }} />
        <div data-sheet-list style=${{ flex: 1, minHeight: 0, overflow: "auto", overscrollBehavior: "contain", display: "flex", flexDirection: "column", gap: 5 }}>
          ${shown.map(t => {
            const on = t.id === tenant
            return html`
              <button
                type="button"
                key=${t.id}
                class="tap"
                onClick=${() => setTenant(t.id)}
                aria-pressed=${on}
                style=${{ display: "flex", alignItems: "center", gap: 10, borderRadius: 12, padding: "9px 11px", background: on ? "#2b2547" : "var(--surface2)", minHeight: 48 }}
              >
                <span style=${{ width: 30, height: 30, borderRadius: 999, background: on ? "#4d4482" : "#2f3345", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12.5, fontWeight: 500, color: "var(--text)", flexShrink: 0 }}>
                  ${t.id.slice(0, 1).toUpperCase()}
                </span>
                <span class="grow col" style=${{ gap: 2 }}>
                  <span class="ellip" style=${{ fontSize: 13.5, fontWeight: 500, color: on ? "#d2cefd" : "var(--text-body)" }}>${t.id}</span>
                  <span class="mono" style=${{ fontSize: 11, color: "var(--muted)" }}>
                    ${t.events == null ? "no figures reported" : t.events ? `${fmt(t.events)} events · ${t.issues == null ? "—" : fmt(t.issues)} issues` : "no events in window"}
                  </span>
                </span>
                <span style=${{ fontSize: 10.5, color: "var(--muted-b)", flexShrink: 0 }}>${t.coverage != null ? Math.round(t.coverage) + "% mapped" : "coverage —"}</span>
                <${Icon} name="check" size=${15} color=${on ? "#b5abfc" : "transparent"} />
              </button>
            `
          })}
          ${q && !shown.length && html`<span style=${{ fontSize: 12, color: "var(--muted-b)", padding: "8px 2px" }}>No tenant matches that name.</span>`}
        </div>
        <span class="pretty" style=${{ fontSize: 11, lineHeight: 1.45, color: "var(--muted-b)", flexShrink: 0 }}>
          Every surface is scoped to one tenant · scoping re-queries the core server and changes every surface.
        </span>
      </div>
    </div>
  `
}
