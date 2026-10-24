import { html, useEffect, useState } from "../vendor/preact-htm.js"
import { SIGN_IN_URL } from "../api/client.js"
import { useStore } from "../state/store.js"
import { Icon } from "../components/Icon.js"

/**
 * Not signed in: no sample data, no preview — just the way in. Sign-in is a
 * full navigation to one of the core's SSO providers (/v2/auth/providers:
 * GitHub, and the accounts service over OIDC on a core with self-registered
 * tenants, ADR-090), which returns to / with the session cookie set on this
 * origin. Without the list, GitHub is offered, as before.
 */
const OIDC_URL = "/v2/auth/oidc"

function useProviders() {
  const [p, setP] = useState({ github: true, oidc: false, oidcName: "" })
  useEffect(() => {
    fetch("/v2/auth/providers", { credentials: "same-origin" })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (j && (j.github || j.oidc)) setP({ github: !!j.github, oidc: !!j.oidc, oidcName: j.oidcName || "Sign in" }) })
      .catch(() => { /* keep GitHub */ })
  }, [])
  return p
}

export function SignIn() {
  const auth = useStore(s => s.auth)
  const err = useStore(s => s.authError)
  const boot = useStore(s => s.boot)
  const providers = useProviders()
  const btn = { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, height: 44, borderRadius: 8, background: "#e9e9ed", color: "#161826", fontSize: 14, fontWeight: 500, textDecoration: "none" }
  const C = [2 * Math.PI * 68, 2 * Math.PI * 53, 2 * Math.PI * 38]
  return html`
    <main class="screen" style=${{ justifyContent: "center", alignItems: "center", gap: 22, padding: "calc(env(safe-area-inset-top, 0px) + 24px) 28px calc(env(safe-area-inset-bottom, 0px) + 28px)" }}>
      <svg viewBox="0 0 200 200" style=${{ width: 150, height: 150, transform: "rotate(-90deg)" }} aria-hidden="true">
        ${[68, 53, 38].map(r => html`<circle key=${r} cx="100" cy="100" r=${r} fill="none" stroke="#22262e" stroke-width="11" />`)}
        ${auth === "loading" && ["#8b8bf0", "#22d3ee", "#e879f9"].map((c, i) => html`
          <circle key=${c} cx="100" cy="100" r=${[68, 53, 38][i]} fill="none" stroke=${c} stroke-width="11" stroke-linecap="round" stroke-opacity="0.35"
            stroke-dasharray=${`${Math.round(C[i] * 0.12)} ${Math.round(C[i]) + 1}`}
            style=${{ transformOrigin: "100px 100px", animation: `${i === 1 ? "spinR" : "spin"} ${1.4 + i * 0.3}s linear infinite` }} />
        `)}
      </svg>
      <div class="col" style=${{ alignItems: "center", gap: 8, textAlign: "center" }}>
        <span style=${{ fontSize: 24, fontWeight: 500, letterSpacing: "-0.02em" }}>Triage</span>
      </div>

      ${auth === "error" && html`
        <div style=${{ background: "var(--bad-tint)", borderRadius: 8, padding: "10px 12px", display: "flex", gap: 9, alignItems: "flex-start", boxShadow: "inset 2px 0 0 var(--st-crit-soft)", maxWidth: 340, width: "100%" }}>
          <${Icon} name="warning-circle" size=${15} color="var(--st-crit-soft)" style=${{ flexShrink: 0, marginTop: 1 }} />
          <span class="pretty" style=${{ fontSize: 11.5, lineHeight: 1.45, color: "var(--bad-text)" }}>Could not reach the server to check your session: ${err}</span>
        </div>
      `}

      ${auth !== "loading" && html`
        <div class="col" style=${{ gap: 10, width: "100%", maxWidth: 340 }}>
          ${providers.oidc && html`
            <a href=${OIDC_URL} class="tap" style=${btn}>${providers.oidcName}</a>
          `}
          ${providers.github && html`
            <a href=${SIGN_IN_URL} class="tap" style=${btn}>
              <${Icon} name="github-logo" size=${18} weight="fill" />Sign in with GitHub
            </a>
          `}
          ${auth === "error" && html`
            <button type="button" class="tap" onClick=${() => void boot()}
              style=${{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, height: 38, borderRadius: 8, border: "1px solid var(--accent-line)", color: "var(--accent-strong)", fontSize: 12.5 }}>
              <${Icon} name="arrows-clockwise" size=${15} />Try again
            </button>
          `}
        </div>
      `}
    </main>
  `
}
