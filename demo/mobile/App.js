import { html, useEffect, useRef } from "./vendor/preact-htm.js"
import { useStore, current } from "./state/store.js"
import { TabBar, tabScreens } from "./components/TabBar.js"
import { inApp, onMessage as onAppMessage, send as toApp } from "./lib/native.js"
import { resyncDevicePush } from "./api/push.js"
import { syncMessengerPush } from "./api/messenger.js"
import { TenantSheet } from "./components/TenantSheet.js"
import { ScopeSheet } from "./components/ScopeSheet.js"
import { VoiceOverlay } from "./components/VoiceOverlay.js"
import { VerifySheet } from "./components/VerifySheet.js"
import { SignIn } from "./screens/SignIn.js"
import { Home } from "./screens/Home.js"
import { VitalDetail } from "./screens/VitalDetail.js"
import { GoalsScreen } from "./screens/Goals.js"
import { Issues } from "./screens/Issues.js"
import { IssueDetail } from "./screens/IssueDetail.js"
import { Events } from "./screens/Events.js"
import { EventDetail } from "./screens/EventDetail.js"
import { Trends } from "./screens/Trends.js"
import { Apps } from "./screens/Apps.js"
import { ServiceDetail } from "./screens/ServiceDetail.js"
import { Cost } from "./screens/Cost.js"
import { Secure } from "./screens/Secure.js"
import { Settings } from "./screens/Settings.js"
import { Chats } from "./screens/Chats.js"
import { Chat } from "./screens/Chat.js"
import { useMessenger } from "./state/messenger.js"
import { TriaChat } from "./screens/TriaChat.js"

const SWIPE_MIN_DX = 56
const SWIPE_MAX_MS = 900
const PULL_MIN_DY = 44

export function App() {
  const auth = useStore(s => s.auth)
  const boot = useStore(s => s.boot)
  const view = useStore(s => current(s))
  const shellRef = useRef(null)

  useEffect(() => { void boot() }, [boot])

  // Browser/hardware back mirrors the in-app history stack. The first entry is
  // left as the page loaded it (under Next.js, replacing it dropped Next's
  // marker and every back to Home reloaded the page). An entry without our
  // `hi` is index 0.
  useEffect(() => {
    const onPop = (e) => {
      const hi = typeof e.state?.hi === "number" ? e.state.hi : 0
      useStore.getState().onPopState(hi)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  // In the Android app a tapped notification opens its issue (in its tenant, when the
  // viewer can read it), or its messenger room. "ready" asks the app for a tap that launched it before this ran.
  useEffect(() => {
    if (!inApp) return
    const off = onAppMessage((m) => {
      if (m.type !== "open") return
      const s = useStore.getState()
      if (m.room) { s.navigate({ screen: "chat", roomId: m.room }); return }
      if (m.tenant && m.tenant !== s.tenant && s.readable.includes(m.tenant)) s.setTenant(m.tenant)
      s.navigate(m.id ? { screen: "issue", incId: m.id } : { screen: "home" })
    })
    toApp({ type: "ready" })
    return off
  }, [])

  // The app holds back a push for the room that is on screen: it is already being read.
  const roomOpen = view.screen === "chat" ? view.roomId ?? "" : ""
  useEffect(() => {
    if (inApp) toApp({ type: "viewing", room: roomOpen })
  }, [roomOpen])

  // Signed in, in the app, alerts on: the core hears about this install again.
  useEffect(() => {
    if (auth !== "signedIn") return
    void resyncDevicePush().catch(() => {})
    void syncMessengerPush().catch(() => {})
  }, [auth])

  // On Pro the messenger's stream runs from sign-in (or from switching Pro
  // on), so the Chats badge is live.
  const pro = useStore(s => s.pro)
  useEffect(() => {
    if (auth === "signedIn" && pro) useMessenger.getState().start()
  }, [auth, pro])

  // Refresh when the tab comes back to the foreground after a while.
  useEffect(() => {
    const onVis = () => {
      const s = useStore.getState()
      if (document.visibilityState === "visible" && s.auth === "signedIn" && (!s.lastLiveAt || Date.now() - s.lastLiveAt > 30_000)) void s.refresh()
    }
    document.addEventListener("visibilitychange", onVis)
    return () => document.removeEventListener("visibilitychange", onVis)
  }, [])

  // Swipe: horizontal walks the tab bar on a main panel and is history
  // back/forward on a sub panel. On Home only, a pull up from the
  // bottom (scrolled to its end, or starting on the tab bar) changes tenant:
  // with two or three readable tenants it flips to the next one, with more it
  // opens the tenant list. With two or three, a pull down from the top
  // flips to the previous one, so both pulls walk the same carousel and wrap;
  // with more, a pull down dismisses the list. Elements marked
  // data-swipe="off" (charts, the graph, the sheet) opt out; data-swipe="x"
  // (the rings) opts out of the sideways swipe only, so a pull may start there.
  useEffect(() => {
    const el = shellRef.current
    if (!el) return
    let start = null
    const blocked = (t) => !!(t instanceof Element && t.closest('[data-swipe="off"], input, textarea'))
    const atBottom = (t) => {
      if (t instanceof Element && t.closest(".tabbar")) return true
      const sc = t instanceof Element ? t.closest(".screen") : null
      return !sc || sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2
    }
    const atTop = (t) => {
      const sc = t instanceof Element ? t.closest(".screen") : null
      return !sc || sc.scrollTop <= 0
    }
    const begin = (x, y, target) => {
      const noX = target instanceof Element && !!target.closest('[data-swipe="x"]')
      start = blocked(target) ? null : { x, y, t: Date.now(), bottom: atBottom(target), top: atTop(target), noX }
    }
    const end = (x, y) => {
      const sw = start
      start = null
      if (!sw) return
      const dx = x - sw.x, dy = y - sw.y
      if (Date.now() - sw.t > SWIPE_MAX_MS) return
      const s = useStore.getState()
      if (Math.abs(dy) > PULL_MIN_DY && Math.abs(dy) > Math.abs(dx)) {
        const n = s.readable.length, at = s.readable.indexOf(s.tenant ?? "")
        if (dy > 0) {
          if (s.tsheet) s.set({ tsheet: false })
          else if (sw.top && current(s).screen === "home" && n > 1 && n <= 3) s.setTenant(s.readable[(at - 1 + n) % n])
        }
        else if (!s.tsheet && sw.bottom && current(s).screen === "home" && n > 1) {
          if (n > 3) s.set({ tsheet: true })
          else s.setTenant(s.readable[(at + 1) % n])
        }
        return
      }
      if (sw.noX) return
      if (Math.abs(dx) < SWIPE_MIN_DX || Math.abs(dy) > Math.abs(dx) * 0.8) return
      // On a main panel the swipe walks the tab bar; on a sub panel it is
      // history back/forward.
      const tabs = tabScreens(s.pro)
      const at = tabs.indexOf(current(s).screen)
      if (at >= 0) {
        const to = tabs[at + (dx > 0 ? -1 : 1)]
        if (to) s.navigate({ screen: to })
        return
      }
      if (dx > 0) s.back()
      else s.forward()
    }
    const ts = (e) => { const p = e.touches[0]; if (p) begin(p.clientX, p.clientY, e.target) }
    const te = (e) => { const p = e.changedTouches[0]; if (p) end(p.clientX, p.clientY) }
    const md = (e) => { if (e.button === 0) begin(e.clientX, e.clientY, e.target) }
    const mu = (e) => end(e.clientX, e.clientY)
    el.addEventListener("touchstart", ts, { passive: true })
    el.addEventListener("touchend", te, { passive: true })
    el.addEventListener("mousedown", md)
    el.addEventListener("mouseup", mu)
    return () => {
      el.removeEventListener("touchstart", ts)
      el.removeEventListener("touchend", te)
      el.removeEventListener("mousedown", md)
      el.removeEventListener("mouseup", mu)
    }
  }, [auth])

  if (auth !== "signedIn") {
    return html`
      <div class="shell">
        <${SignIn} />
      </div>
    `
  }

  return html`
    <div class="shell" ref=${shellRef}>
      <${Route} screen=${view.screen} key=${view.screen + (view.incId ?? "") + (view.svcName ?? "") + (view.evKey ?? "") + (view.metric ?? "") + (view.roomId ?? "")} />
      <${VoiceOverlay} />
      <${TabBar} />
      <${TenantSheet} />
      <${VerifySheet} />
      <${ScopeSheet} />
    </div>
  `
}

function Route({ screen }) {
  switch (screen) {
    case "detail": return html`<${VitalDetail} />`
    case "goals": return html`<${GoalsScreen} />`
    case "issues": return html`<${Issues} />`
    case "issue": return html`<${IssueDetail} />`
    case "stream": return html`<${Events} />`
    case "event": return html`<${EventDetail} />`
    case "predict": return html`<${Trends} />`
    case "graph": return html`<${Apps} />`
    case "svc": return html`<${ServiceDetail} />`
    case "cost": return html`<${Cost} />`
    case "secure": return html`<${Secure} />`
    case "settings": return html`<${Settings} />`
    case "chats": return html`<${Chats} />`
    case "chat": return html`<${Chat} />`
    case "tria": return html`<${TriaChat} />`
    default: return html`<${Home} />`
  }
}
