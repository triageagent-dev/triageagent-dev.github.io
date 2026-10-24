import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js"
import { useStore } from "../state/store.js"
import { Header, Tap } from "../components/ui.js"
import { Icon } from "../components/Icon.js"
import { saveInApp } from "../state/e2ee-app.js"
import { prepare } from "../api/chatfiles.js"
import { ask, confirm, loadOlder, reset, stop, subscribe, voiceEvent, warm } from "../api/chat.js"
import { useVoice } from "../voice/voice.js"
import { VoiceBar } from "../components/VoiceOverlay.js"
import { Md } from "../components/Md.js"

const TOOL_STATE = { ask: "asks", run: "running…", ok: "ok", error: "error", denied: "declined", stopped: "stopped" }

const argLine = (a) => {
  const s = Object.entries(a || {}).map(([k, v]) => k + "=" + (typeof v === "string" ? v : JSON.stringify(v))).join(" ")
  return s.length > 140 ? s.slice(0, 139) + "…" : s
}

/** A file of a question: a photo shows small, anything else as its name. */
function Attached({ file, onImage }) {
  const img = file.thumb && file.mime?.startsWith("image/")
  const box = { maxWidth: "86%", fontSize: 12.5, color: "var(--text2)", overflowWrap: "anywhere" }
  if (img) return html`<img src=${file.thumb} alt=${file.name} onClick=${() => onImage(file)} style=${{ display: "block", maxWidth: 220, maxHeight: 180, borderRadius: 10 }} />`
  return file.url
    ? html`<a href=${file.url + (file.url.startsWith("/") ? "&download=1" : "")} download=${file.name} onClick=${e => saveInApp(e, file.url, file.name, file.mime)} style=${box}>${file.name}</a>`
    : html`<span style=${box}>${file.name}</span>`
}

/**
 * The tools Tria called for one answer, as one quiet line that opens to the
 * list (and a tool's arguments on a second tap). A tool waiting for a confirm
 * is never folded: it is the one place the person has to answer.
 */
function ToolRun({ tools }) {
  const [open, setOpen] = useState(false)
  const [args, setArgs] = useState(-1)
  const asks = tools.filter(t => t.state === "ask")
  const rest = tools.filter(t => t.state !== "ask")
  const working = rest.some(t => t.state === "run")
  const failed = rest.filter(t => t.state === "error").length
  const n = rest.length
  const word = n === 1 ? "tool" : "tools"
  return html`
    <div class="col" style=${{ gap: 6 }}>
      ${n > 0 && html`
        <${Tap} onClick=${() => setOpen(!open)} style=${{ alignSelf: "flex-start", fontSize: 12, color: "var(--muted)", padding: "2px 0" }}>
          ${working ? `Working… ${n} ${word}` : `Used ${n} ${word}`}${failed > 0 && html` · <span style=${{ color: "var(--bad-text)" }}>${failed} failed</span>`} ${open ? "▾" : "▸"}
        <//>
        ${open && rest.map((t, k) => html`
          <div key=${k} class="col" style=${{ gap: 2, paddingLeft: 10 }}>
            <${Tap} onClick=${() => setArgs(args === k ? -1 : k)} style=${{ display: "flex", gap: 6, alignItems: "baseline" }}>
              <span class="mono" style=${{ fontSize: 11.5, color: "var(--text2)" }}>${t.name}</span>
              <span style=${{ fontSize: 11, color: t.state === "error" ? "var(--bad-text)" : "var(--muted)" }}>${TOOL_STATE[t.state] ?? t.state}</span>
            <//>
            ${args === k && html`<span class="mono" style=${{ fontSize: 11, color: "var(--muted)", overflowWrap: "anywhere" }}>${argLine(t.args) || "no arguments"}</span>`}
          </div>`)}`}
      ${asks.map(t => html`
        <div key=${t.id} class="col" style=${{ gap: 6, padding: "6px 0" }}>
          <div class="row" style=${{ gap: 6 }}>
            <span class="mono" style=${{ fontSize: 11.5, color: "var(--text2)" }}>${t.name}</span>
            <span style=${{ fontSize: 11, color: "#e0a030" }}>${TOOL_STATE.ask}</span>
          </div>
          <span class="mono" style=${{ fontSize: 11, color: "var(--muted)", overflowWrap: "anywhere" }}>${argLine(t.args)}</span>
          <div class="row" style=${{ gap: 8 }}>
            <${Tap} onClick=${() => confirm(t.id, true)} style=${{ height: 34, padding: "0 14px", borderRadius: 8, background: "var(--accent-deep)", color: "var(--text-strong)", fontSize: 12.5, display: "flex", alignItems: "center" }}>Run ${t.name}<//>
            <${Tap} onClick=${() => confirm(t.id, false)} style=${{ height: 34, padding: "0 14px", borderRadius: 8, background: "var(--btn)", color: "var(--text2)", fontSize: 12.5, display: "flex", alignItems: "center" }}>Decline<//>
          </div>
        </div>`)}
    </div>`
}

/** The private chat with Tria: her tools, the workspace in view, asks before any change. */
export function TriaChat() {
  const tenant = useStore(s => s.tenant)
  const [st, setSt] = useState(null)
  const [text, setText] = useState("")
  const [files, setFiles] = useState([])
  const [problem, setProblem] = useState("")
  const [viewer, setViewer] = useState(null)
  const endRef = useRef(null)
  const fileRef = useRef(null)

  useEffect(() => subscribe(setSt), [])
  useEffect(() => { warm(tenant) }, [tenant])
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }) }, [st?.items.at(-1), st?.items.at(-1)?.text])

  const voice = useVoice()
  const submit = async (e) => {
    e?.preventDefault?.()
    // While a voice session is open, typed words go into it: one conversation.
    const typed = text.trim()
    if (voice.live && typed && !files.length && await voice.sendText(typed)) {
      voiceEvent({ t: "typed", text: typed })
      setText("")
      return
    }
    if (ask(typed, tenant, files)) { setText(""); setFiles([]); setProblem("") }
  }
  const onFiles = async (e) => {
    const picked = [...(e.currentTarget.files ?? [])]
    e.currentTarget.value = ""
    try { setFiles([...files, ...await prepare(picked, files)]); setProblem("") } catch (err) { setProblem(err.message) }
  }
  const canSend = text.trim() || files.length
  const u = st?.usage

  return html`
    <main class="screen" style=${{ gap: 10 }}>
      <${Header} title="Tria" right=${html`
        <${Tap} onClick=${() => reset()} style=${{ fontSize: 12, color: "var(--accent)", padding: "4px 2px" }}>New<//>
      `} />
      ${u && u.limit > 0 && html`<span style=${{ fontSize: 11, color: "var(--muted)" }}>Chat today ${Math.round(u.used / 1000)}k of ${Math.round(u.limit / 1000)}k tokens</span>`}
      <div class="col" style=${{ gap: 12, flex: 1 }}>
        ${st && !st.items.length && html`<span class="pretty" style=${{ fontSize: 12.5, lineHeight: 1.5, color: "var(--muted)" }}>Ask about issues, services, events or memory. Tria calls the core's tools for this workspace and asks before any change.</span>`}
        ${st?.older && html`
          <${Tap} onClick=${() => loadOlder()} style=${{ alignSelf: "center", fontSize: 12, color: "var(--accent)", padding: "4px 8px" }}>${st.loadingOlder ? "Loading…" : "Older messages"}<//>`}
        ${(st?.items ?? []).map((it, i) => {
          if (it.k === "user") return html`
            <div key=${i} class="col" style=${{ alignItems: "flex-end", gap: 3 }}>
              ${it.files?.map(f => html`<${Attached} key=${f.url || f.name} file=${f} onImage=${setViewer} />`)}
              ${it.text && html`<span style=${{ maxWidth: "86%", padding: "8px 11px", borderRadius: 10, fontSize: 13.5, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere", textAlign: "justify", background: "var(--accent-tint)" }}>${it.text}</span>`}
            </div>`
          if (it.k === "bot") return html`
            <div key=${i} class="col" style=${{ gap: 3 }}>
              <span style=${{ fontSize: 11.5, fontWeight: 500, color: "var(--accent)" }}>Tria</span>
              <div class="pretty" style=${{ maxWidth: "92%", padding: "8px 11px", borderRadius: 10, fontSize: 13.5, lineHeight: 1.5, overflowWrap: "anywhere", textAlign: "justify", background: "var(--surface)" }}><${Md} text=${it.text} /></div>
            </div>`
          if (it.k === "tool") {
            if (st.items[i - 1]?.k === "tool") return null // drawn with the run it belongs to
            const run = []
            for (let j = i; st.items[j]?.k === "tool"; j++) run.push(st.items[j])
            return html`<${ToolRun} key=${i} tools=${run} />`
          }
          const color = it.k === "err" ? "var(--bad-text)" : "var(--muted)"
          return html`<span key=${i} class="pretty" style=${{ fontSize: 12, lineHeight: 1.45, color }}>${it.text}</span>`
        })}
        <div ref=${endRef} />
      </div>
      <${VoiceBar} />
      ${problem && html`<span style=${{ fontSize: 12, color: "var(--bad-text)" }}>${problem}</span>`}
      ${files.length > 0 && html`
        <div class="row" style=${{ gap: 6, flexWrap: "wrap" }}>
          ${files.map((f, i) => html`
            <${Tap} key=${i} label=${"Remove " + f.name} onClick=${() => setFiles(files.filter((_, j) => j !== i))} style=${{ fontSize: 12, padding: "4px 9px", borderRadius: 8, background: "var(--btn)", color: "var(--text2)", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${f.name} ×<//>`)}
        </div>`}
      <form onSubmit=${submit} class="row" style=${{ gap: 8, position: "sticky", bottom: 0, padding: "8px 0 2px", background: "var(--bg)" }}>
        ${st?.hello?.files && html`
          <${Tap} label="Attach" onClick=${() => fileRef.current?.click()} style=${{ height: 40, width: 36, display: "flex", alignItems: "center", justifyContent: "center" }}><${Icon} name="paperclip" size=${22} color="var(--text2)" /><//>
          <input ref=${fileRef} type="file" multiple accept="image/*,application/pdf,text/*,.json,.yaml,.yml,.csv,.log,.md" style=${{ display: "none" }} onChange=${onFiles} />`}
        <input
          value=${text}
          onInput=${e => setText(e.currentTarget.value)}
          placeholder="Ask Tria"
          enterkeyhint="send"
          style=${{ flex: 1, minWidth: 0, height: 40, padding: "0 12px", borderRadius: 10, border: "1px solid var(--input-line)", background: "var(--well)", color: "var(--text)", fontSize: 14 }}
        />
        ${st?.busy
          ? html`<${Tap} label="Stop" onClick=${() => stop()} style=${{ height: 40, padding: "0 14px", borderRadius: 10, background: "var(--btn)", color: "var(--bad-text)", fontSize: 13.5, display: "flex", alignItems: "center" }}>Stop<//>`
          : html`<${Tap} label="Send" onClick=${submit} style=${{ height: 40, padding: "0 14px", borderRadius: 10, background: "var(--btn)", color: "var(--accent)", fontSize: 13.5, display: "flex", alignItems: "center", opacity: canSend ? 1 : 0.5 }}>Send<//>`}
      </form>
      ${viewer && html`
        <div class="cs-viewer" style=${{ position: "fixed", zIndex: 60 }} onClick=${() => setViewer(null)}>
          <div class="row" style=${{ padding: "calc(env(safe-area-inset-top, 0px) + 10px) 12px 10px", gap: 10 }} onClick=${e => e.stopPropagation()}>
            <${Tap} label="Close" onClick=${() => setViewer(null)} style=${{ padding: 6 }}><${Icon} name="x" size=${22} color="#fff" /><//>
            <span class="grow ellip" style=${{ color: "#ddd", fontSize: 13 }}>${viewer.name}</span>
          </div>
          <div class="grow" style=${{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
            <img src=${viewer.url} alt=${viewer.name} style=${{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          </div>
        </div>
      `}
    </main>
  `
}
