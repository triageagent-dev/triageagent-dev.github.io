import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js"
import { fmtClock, fmtDurShort } from "../model/format.js"
import { disablePush, enablePush, pushLevel, pushState, setPushLevel, storedPushLevel } from "../api/push.js"
import { useStore } from "../state/store.js"
import { tenantLabel } from "../model/tenancy.js"
import { Header, Kicker, Tap, useSource } from "../components/ui.js"
import { Icon } from "../components/Icon.js"
import { Photo } from "../components/Photo.js"
import { useMessenger } from "../state/messenger.js"

import { UI_VERSION } from "../lib/ui-version.js"
import { useE2EE } from "../state/e2ee.js"
import { e2ee } from "../state/e2ee-app.js"

/** The Android app's version: its WebView user agent ends in TriageAndroid/<version>. Empty in a browser. */
const APP_VERSION = typeof navigator !== "undefined" ? /TriageAndroid\/(\S+)/.exec(navigator.userAgent)?.[1] ?? "" : ""

export function Settings() {
  const s = useStore()
  const src = useSource()
  // My photo: the messenger keeps it (GitHub's until I choose or remove one).
  const photo = useMessenger(m => m.myPhoto)
  const photoRef = useRef(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoErr, setPhotoErr] = useState("")
  useEffect(() => { void useMessenger.getState().loadMe() }, [])
  const onPhoto = async (e) => {
    const f = e.currentTarget.files?.[0]
    e.currentTarget.value = ""
    if (!f) return
    setPhotoBusy(true); setPhotoErr("")
    try { await useMessenger.getState().setPhoto(f) } catch (err) { setPhotoErr(err.message) } finally { setPhotoBusy(false) }
  }
  const dropPhoto = async () => {
    setPhotoBusy(true); setPhotoErr("")
    try { await useMessenger.getState().dropPhoto() } catch (err) { setPhotoErr(err.message) } finally { setPhotoBusy(false) }
  }
  const role = s.grants.admin ? "admin" : Object.entries(s.grants.byTenant).filter(([t]) => t !== "*").map(([t, b]) => `${t}:${b}`).join(", ") || "no grants"
  // /v2/agent/status carries no version; the core serves it (tenant-free) at /v2/version.
  const [coreVersion, setCoreVersion] = useState(s.snap?.status?.serverVersion?.version)
  useEffect(() => {
    let live = true
    fetch("/v2/version").then(r => (r.ok ? r.json() : null)).then(v => { if (live && typeof v?.version === "string") setCoreVersion(v.version) }).catch(() => {})
    return () => { live = false }
  }, [])
  // PushState | "busy" | null
  const [push, setPush] = useState(null)
  const [pushErr, setPushErr] = useState("")
  const [level, setLevel] = useState(pushLevel())
  useEffect(() => {
    void pushState().then(st => { setPush(st); if (st === "on") void storedPushLevel().then(setLevel).catch(() => {}) }).catch(() => setPush("off"))
  }, [])
  const togglePush = async () => {
    const was = push
    setPush("busy"); setPushErr("")
    try { setPush(was === "on" ? await disablePush() : await enablePush(level)) }
    catch (e) { setPushErr(e instanceof Error ? e.message : String(e)); setPush(was === "busy" || was == null ? "off" : was) }
  }
  const chooseLevel = async (l) => {
    if (l === level) return
    const was = level
    setLevel(l); setPushErr("")
    try { await setPushLevel(l) }
    catch (e) { setPushErr(e instanceof Error ? e.message : String(e)); setLevel(was) }
  }
  const e2 = useE2EE()
  const e2Line = e2.status === "failed" ? `could not start: ${e2.error}`
    : e2.status !== "ready" ? "setting up…"
    : e2.trusted ? "this device is verified" : "this device is not verified yet"
  const retry = s.nextRetryAt ? Math.max(0, Math.round((s.nextRetryAt - Date.now()) / 1000)) : null

  return html`
    <main class="screen" style=${{ gap: 16 }}>
      <${Header} title="Account" size=${19} />

      <div class="row" style=${{ gap: 12, padding: "2px 2px 0" }}>
        <${Tap} label="Change photo" onClick=${() => photoRef.current?.click()} style=${{ position: "relative", flexShrink: 0, borderRadius: 999 }}>
          <${Photo} src=${photo} name=${s.username} size=${56} color="var(--avatar-bg)" style=${{ boxShadow: "0 0 0 1px var(--avatar-ring)" }} />
          <span style=${{ position: "absolute", right: -2, bottom: -2, width: 22, height: 22, borderRadius: 999, background: "var(--surface3)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 0 2px var(--bg)" }}>
            <${Icon} name="camera" size=${13} color="var(--text-body)" />
          </span>
        <//>
        <div class="grow col" style=${{ gap: 2 }}>
          <span class="ellip" style=${{ fontSize: 15, fontWeight: 500 }}>${s.username || "signed in"}</span>
          <span class="ellip" style=${{ fontSize: 11, color: "var(--muted)" }}>GitHub · ${role}</span>
          <span class="mono ellip" style=${{ fontSize: 12, color: "var(--muted)" }}>tenant ${s.tenant ? tenantLabel(s.labels, s.tenant) : "—"}</span>
          <div class="row" style=${{ gap: 12, marginTop: 3 }}>
            <${Tap} onClick=${() => photoRef.current?.click()} style=${{ fontSize: 12, color: "var(--accent)" }}>${photoBusy ? "Saving…" : photo ? "Change photo" : "Set photo"}<//>
            ${photo && !photoBusy && html`<${Tap} onClick=${() => void dropPhoto()} style=${{ fontSize: 12, color: "var(--muted)" }}>Remove<//>`}
          </div>
          ${photoErr && html`<span style=${{ fontSize: 11.5, color: "var(--bad-text)" }}>${photoErr}</span>`}
        </div>
        <input ref=${photoRef} type="file" accept="image/*" style=${{ display: "none" }} onChange=${onPhoto} />
      </div>

      ${s.readable.length > 1 && html`
        <${Tap} bg onClick=${() => s.set({ tsheet: true })} style=${{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface2)", borderRadius: 10, padding: "12px 13px" }}>
          <${Icon} name="buildings" size=${16} color="var(--accent)" />
          <span class="grow" style=${{ fontSize: 13.5 }}>Switch tenant</span>
          <span style=${{ fontSize: 11, color: "var(--muted)" }}>${s.readable.length} readable</span>
          <${Icon} name="caret-right" size=${13} color="#595d6c" />
        <//>
      `}

      ${e2.status !== "off" && html`
        <div class="row" style=${{ gap: 10, background: "var(--surface2)", borderRadius: 10, padding: "12px 13px" }}>
          <${Icon} name=${e2.trusted ? "shield-check" : "lock"} size=${16} color=${e2.trusted ? "var(--ok-text)" : "var(--accent)"} />
          <div class="grow col" style=${{ gap: 2, minWidth: 0 }}>
            <span style=${{ fontSize: 13.5 }}>Encrypted chats</span>
            <span class="ellip" style=${{ fontSize: 11.5, color: "var(--muted)" }}>${e2Line}${e2.device ? ` · ${e2.device}` : ""}</span>
          </div>
          ${e2.status === "ready" && e2.trusted === false && html`<${Tap} onClick=${() => { e2ee.verifySelf().catch(() => {}) }} style=${{ fontSize: 12.5, color: "var(--accent)", fontWeight: 500 }}>Verify<//>`}
        </div>
      `}

      <div class="row" style=${{ gap: 12, background: "var(--surface2)", borderRadius: 10, padding: "12px 13px" }}>
        <span style=${{ width: 38, height: 38, borderRadius: 999, background: "var(--accent-tint2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <${Icon} name="heartbeat" size=${19} weight="fill" color="var(--accent)" />
        </span>
        <div class="grow col" style=${{ gap: 2 }}>
          <span style=${{ fontSize: 14, fontWeight: 500 }}>Triage</span>
          <span class="mono" style=${{ fontSize: 12, color: "var(--muted)", display: "flex", flexDirection: "column", gap: 1, overflowWrap: "anywhere" }}>
            ${APP_VERSION && html`<span>app ${APP_VERSION}</span>`}
            <span>ui ${UI_VERSION}</span>
            <span>core ${coreVersion ?? "—"}</span>
          </span>
        </div>
      </div>

      <p class="pretty" style=${{ fontSize: 13.5, lineHeight: 1.55, color: "var(--text2)" }}>
        Triage turns raw platform noise into a small number of things worth your attention. It deduplicates every event, ranks what is left against the service graph, promotes only what crosses the issue threshold — and scores itself on how well it does that. This app is the score.
      </p>

      <div class="col" style=${{ gap: 8 }}>
        <${Kicker} light right=${html`
          <span class="row" style=${{ gap: 5, fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase", color: src.fg }}>
            <span style=${{ width: 6, height: 6, borderRadius: 99, background: src.fg, display: "block" }} />${src.label}
          </span>
        `}>Core server<//>
        <div class="col" style=${{ gap: 1 }}>
          <${KV} k="Address" v=${window.location.origin + " (same origin)"} />
          <${KV} k="Session" v="GitHub SSO cookie" />
          <${KV} k="Last update" v=${s.lastLiveAt ? fmtClock(new Date(s.lastLiveAt).toISOString()) : "—"} />
          <${KV} k=${s.conn === "failed" ? "Retry in" : "Next poll"} v=${retry != null ? fmtDurShort(retry) : "—"} />
        </div>
        ${s.connMsg && html`<span class="mono" style=${{ fontSize: 12, lineHeight: 1.4, color: "#f59e0b", wordBreak: "break-word" }}>${s.connMsg}</span>`}
        ${s.snap?.failed.length ? html`
          <div class="col" style=${{ gap: 3 }}>
            <span style=${{ fontSize: 11.5, color: "var(--muted)" }}>Partial answer — these did not respond:</span>
            ${s.snap.failed.map(f => html`
              <span key=${f.key} class="mono" style=${{ fontSize: 11.5, color: "#f59e0b", wordBreak: "break-word" }}>${f.key}: ${f.status ? f.status + " · " : ""}${f.message}</span>
            `)}
          </div>
        ` : null}
        <${Tap} onClick=${() => void s.refresh()} style=${{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, height: 38, borderRadius: 8, border: "1px solid var(--accent-line)", color: "var(--accent-strong)", fontSize: 12 }}>
          <${Icon} name="arrows-clockwise" size=${15} />Refresh now
        <//>
        <span class="pretty" style=${{ fontSize: 11.5, lineHeight: 1.5, color: "var(--muted)" }}>
          Served from the same origin as the core, so your GitHub sign-in is the session — no token to paste. Refreshes every 30 s, backing off when the server does not answer.
        </span>
      </div>

      <div class="col" style=${{ gap: 8 }}>
        <${Kicker} light>Preferences<//>
        <div class="col" style=${{ gap: 1 }}>
          <${Tap} onClick=${() => s.navigate({ screen: "goals" })} className="hair" style=${{ display: "flex", alignItems: "center", gap: 10, padding: "11px 0" }}>
            <${Icon} name="target" size=${15} color="var(--accent)" />
            <span class="grow" style=${{ fontSize: 13.5 }}>Ring goals</span>
            <span style=${{ fontSize: 11, color: "var(--muted)" }}>USE ${s.goals.use} · RED ${s.goals.red} · SIG ${s.goals.sig} · INC ≤ ${s.goals.inc}/wk</span>
            <${Icon} name="caret-right" size=${13} color="#595d6c" />
          <//>
          <div class="col hair" style=${{ gap: 4, padding: "11px 0" }}>
            <div class="row" style=${{ gap: 10 }}>
              <${Icon} name="bell-ringing" size=${15} color="var(--accent)" />
              <span class="grow" style=${{ fontSize: 13.5 }}>Alerts on this device</span>
              ${push === "unsupported" || push === "denied" ? html`
                <span style=${{ fontSize: 11, color: "var(--muted)" }}>${push === "denied" ? "blocked in browser settings" : "not supported here"}</span>
              ` : html`
                <button type="button" role="switch" aria-checked=${push === "on"} aria-label="Alerts on this device" disabled=${push == null || push === "busy"} onClick=${() => void togglePush()}
                  style=${{ width: 44, height: 26, borderRadius: 999, background: push === "on" ? "#9184d9" : "#3a3d4c", position: "relative", flexShrink: 0, transition: "background .15s", opacity: push == null || push === "busy" ? 0.6 : 1 }}>
                  <span style=${{ position: "absolute", top: 3, left: push === "on" ? 21 : 3, width: 20, height: 20, borderRadius: 999, background: "#e9e9ed", display: "block", transition: "left .15s" }} />
                </button>
              `}
            </div>
            ${push === "on" && html`
              <div class="row" role="radiogroup" aria-label="What to send" style=${{ gap: 6, paddingLeft: 25, paddingTop: 2 }}>
                ${[["issues", "Issues & critical"], ["all", "All"]].map(([l, label]) => html`
                  <button key=${l} type="button" role="radio" aria-checked=${level === l} onClick=${() => void chooseLevel(l)}
                    style=${{ fontSize: 11.5, padding: "4px 10px", borderRadius: 999, border: "1px solid", borderColor: level === l ? "#9184d9" : "#3a3d4c", background: level === l ? "rgba(145,132,217,.18)" : "transparent", color: level === l ? "#e9e9ed" : "var(--muted)" }}>
                    ${label}
                  </button>
                `)}
              </div>
            `}
            <span class="pretty" style=${{ fontSize: 11.5, lineHeight: 1.5, color: pushErr ? "#f59e0b" : "var(--muted)", paddingLeft: 25 }}>
              ${pushErr || (push === "unsupported" ? "On iPhone, add this app to the Home Screen first, then open it from there."
                : level === "all" ? "Every notice the core sends: issues opened and resolved, risk predictions, observations."
                : "New and resolved issues, plus anything critical.")}
            </span>
          </div>
          <div class="row hair" style=${{ gap: 10, padding: "11px 0" }}>
            <${Icon} name="microphone" size=${15} color="var(--accent)" />
            <span class="grow" style=${{ fontSize: 13.5 }}>Voice agent</span>
            <span style=${{ fontSize: 11, color: "var(--muted)" }}>Hold the triage icon to start · tap it to end</span>
          </div>
        </div>
      </div>

      <div class="col" style=${{ gap: 8 }}>
        <${Kicker} light>Plan<//>
        <div class="row" style=${{ background: "var(--surface2)", borderRadius: 10, padding: "12px 13px", gap: 11 }}>
          <span style=${{ width: 38, height: 38, borderRadius: 999, background: "var(--accent-tint2)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <${Icon} name="crown-simple" size=${18} weight="fill" color="var(--accent)" />
          </span>
          <div class="grow col" style=${{ gap: 2 }}>
            <span style=${{ fontSize: 14, fontWeight: 500 }}>Full subscription</span>
            <span style=${{ fontSize: 11.5, color: "var(--muted)" }}>${s.pro ? "Pro · Cost and Chats tabs" : "Free · Issues and Events tabs"}</span>
          </div>
          <button type="button" role="switch" aria-checked=${s.pro} aria-label="Pro" onClick=${s.togglePro}
            style=${{ width: 44, height: 26, borderRadius: 999, background: s.pro ? "#9184d9" : "#3a3d4c", position: "relative", flexShrink: 0, transition: "background .15s" }}>
            <span style=${{ position: "absolute", top: 3, left: s.pro ? 21 : 3, width: 20, height: 20, borderRadius: 999, background: "#e9e9ed", display: "block", transition: "left .15s" }} />
          </button>
        </div>
        <span class="pretty" style=${{ fontSize: 11.5, lineHeight: 1.5, color: "var(--muted)" }}>
          The Pro toggle swaps the last two tabs for Cost and Chats; Events and Secure then open from Home. It is a local preference in this browser, not a billing change.
        </span>
      </div>



      <${Tap} bg onClick=${() => void s.signOut()} style=${{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "var(--surface2)", borderRadius: 8, padding: 12 }}>
        <${Icon} name="sign-out" size=${15} color="#f87171" />
        <span style=${{ fontSize: 13.5, color: "#f87171" }}>Sign out</span>
      <//>

      <span style=${{ fontSize: 11.5, color: "var(--muted)", textAlign: "center", paddingTop: 2 }}>Triage ${UI_VERSION} · core ${coreVersion ?? "v2 API"}</span>
    </main>
  `
}

function KV({ k, v }) {
  return html`
    <div class="row hair" style=${{ gap: 10, padding: "8px 0" }}>
      <span style=${{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--muted)", width: 96, flexShrink: 0 }}>${k}</span>
      <span class="mono grow ellip" style=${{ fontSize: 12, color: "var(--text-body)" }}>${v}</span>
    </div>
  `
}
