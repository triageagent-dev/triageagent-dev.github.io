// Panel 6's top section — agent approvals: triagectl's onboard step 5
// (ui/onboard_approve.go). Pending join requests and approved agents from
// GET /v2/agents/pending and GET /v2/agents; enter stages approve (pending)
// or revoke (approved) behind a y/n confirm that names the cluster and
// fingerprint. A pending request for a cluster already approved with another
// key carries `replaces`; its confirm says so and sends replace, which hands
// the cluster to the new key and revokes the old one. Needs an admin session: a 401/403 hides the section, any
// other error shows the core's message.
import { ago, arr, HttpError, requestJSON } from "./api.js";
import { esc, kv, sub } from "./ui.js";

let C = null; // { S, render, flash }
const O = {
  agents: [], loaded: false, loading: false, error: "", denied: false, sel: 0,
  confirm: null,           // { action, cluster, fingerprint, replace, lines }
  running: false, output: null, // { text, isErr }
};
export function initApprovals(ctx) { C = ctx; }
export const confirming = () => !!O.confirm;

export async function loadAgents() {
  if (O.loading) return;
  O.loading = true;
  C.render();
  try {
    const [p, a] = await Promise.all([requestJSON("GET", "/v2/agents/pending"), requestJSON("GET", "/v2/agents")]);
    const items = [];
    arr(p.pending).forEach((x) => items.push({ cluster: x.cluster, fingerprint: x.fingerprint, tenants: arr(x.tenants), status: "pending", since: x.firstSeen, replaces: x.replaces || "" }));
    arr(a.agents).forEach((x) => items.push({ cluster: x.cluster, fingerprint: x.fingerprint, tenants: arr(x.tenants), status: "approved", since: x.approvedAt, notAfter: x.notAfter, by: x.approvedBy }));
    O.agents = items; O.error = ""; O.denied = false; O.loaded = true;
    if (O.sel >= items.length) O.sel = Math.max(0, items.length - 1);
  } catch (e) {
    O.error = errText(e);
    O.denied = e instanceof HttpError && (e.status === 401 || e.status === 403);
  } finally {
    O.loading = false;
    C.render();
  }
}
const errText = (e) => (e instanceof HttpError && (e.status === 401 || e.status === 403))
  ? `the core refused (${e.status}): ${e.coreMessage || e.message}`
  : String((e && (e.coreMessage || e.message)) || e);

function stage() {
  const it = O.agents[O.sel];
  if (!it) return;
  O.confirm = it.status === "approved"
    ? { action: "revoke", cluster: it.cluster, fingerprint: it.fingerprint, lines: ["revoke agent " + it.cluster + "?", "fingerprint " + it.fingerprint, "its sessions end at the next reconnect and it must be approved again"] }
    : it.replaces
      ? { action: "replace", cluster: it.cluster, fingerprint: it.fingerprint, replace: true, lines: ["replace agent " + it.cluster + "?", "new fingerprint " + it.fingerprint, "replaces " + it.replaces, "tenants " + it.tenants.join(", "), "the cluster is already approved with that key: approving hands it to the new key and revokes the old one", "check it matches the agent's `join pending` log line"] }
      : { action: "approve", cluster: it.cluster, fingerprint: it.fingerprint, lines: ["approve agent " + it.cluster + "?", "fingerprint " + it.fingerprint, "tenants " + it.tenants.join(", "), "check it matches the agent's `join pending` log line"] };
  O.output = null;
  C.render();
}
async function confirmYes() {
  const c = O.confirm;
  if (!c) return;
  O.confirm = null; O.running = true;
  C.render();
  try {
    if (c.action === "revoke") {
      await requestJSON("POST", "/v2/agents/revoke", { cluster: c.cluster });
      O.output = { text: "revoked " + c.cluster, isErr: false };
    } else {
      const body = { cluster: c.cluster, fingerprint: c.fingerprint };
      if (c.replace) body.replace = true;
      const a = await requestJSON("POST", "/v2/agents/approve", body);
      O.output = { text: `${c.replace ? "replaced" : "approved"} ${a.cluster || c.cluster} for tenants ${arr(a.tenants).join(", ")}; the agent gets its certificate on its next retry`, isErr: false };
    }
  } catch (e) {
    O.output = { text: "error: " + errText(e), isErr: true };
  } finally {
    O.running = false;
    C.render();
  }
  loadAgents();
}
function confirmNo() { O.confirm = null; C.flash("cancelled"); C.render(); }

const fullTime = (t) => (t && new Date(t).getTime() > 0 ? new Date(t).toLocaleString() : null);

// Only what a row cannot say: the confirm prompt, a running action or its result.
function detail(it) {
  if (!it) return "";
  if (O.confirm) {
    const c = O.confirm;
    return `<div class="confirm">${c.lines.map((l, i) => `<div class="${i === 0 ? "fg-strong b" : "fg-text"}">${esc(l)}</div>`).join("")}
      <div class="btnrow" style="padding-top:6px"><button type="button" class="btn primary" data-act="apv-yes">y — ${esc(c.action)}</button><button type="button" class="btn" data-act="apv-no">n — cancel</button></div>
      <span class="fg-faint">y runs it against ${esc(location.host)} · any other key cancels</span></div>`;
  }
  if (O.running) return `<span class="fg-dim">running…</span>`;
  if (O.output) return `<p class="para ${O.output.isErr ? "fg-crit" : "fg-ok"}">${esc(O.output.text)}</p>`;
  return "";
}

// "" for a caller who may not see agents, so the panel shows signals only.
export const approvalsShown = () => !O.denied;

export function approvalsSection() {
  if (!O.loaded && !O.loading && !O.error) setTimeout(loadAgents, 0);
  if (O.denied) return "";
  const pending = O.agents.filter((x) => x.status === "pending").length;
  const now = Date.now();
  const rows = O.agents.map((it, i) => {
    const on = i === O.sel;
    const fp = String(it.fingerprint || "").replace(/^SHA256:/, "").slice(0, 12);
    const when = it.status === "approved"
      ? (it.notAfter && new Date(it.notAfter).getTime() > 0 ? "cert until " + new Date(it.notAfter).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "cert not issued yet")
      : "waiting " + ago(it.since, now) + (it.replaces ? " · replaces " + String(it.replaces).replace(/^SHA256:/, "").slice(0, 12) : "");
    return `<div class="tr${on ? " sel" : ""}" data-act="sel" data-list="agent" data-i="${i}" title="${esc(it.fingerprint || "")}">
      <span class="mark">${on ? "&#9654;" : ""}</span>
      <span class="c ${it.status === "approved" ? "fg-ok" : it.replaces ? "fg-crit" : "fg-warn"}" style="width:5.54em">${esc(it.status)}</span>
      <span class="c fg-violet" style="width:7.38em">${esc(it.cluster)}</span>
      <span class="c fg-dim opt" style="width:8.31em">${esc(fp)}</span>
      <span class="c flex fg-label">${esc(it.tenants.join(","))}</span>
      <span class="c fg-faint opt">${esc(when)}</span>
      ${on ? `<span class="c fg-faint opt">&#183; enter ${it.status === "approved" ? "revokes" : it.replaces ? "replaces" : "approves"}</span>` : ""}
    </div>`;
  }).join("");
  const empty = O.error ? `<p class="para fg-crit">${esc(O.error)}</p>`
    : `<div class="empty">${O.loading || !O.loaded ? "reading agents…" : "no agents: none approved, none waiting"}</div>`;
  return sub(`agents(${O.agents.length})${pending ? ` · ${pending} pending` : ""}`, ' data-sec="1"') + `<div class="col">
      <div class="th"><span class="mark"></span><span class="c" style="width:5.54em">STATUS</span><span class="c" style="width:7.38em">CLUSTER</span><span class="c opt" style="width:8.31em">FINGERPRINT</span><span class="c flex">TENANTS</span></div>
      <div class="rows" data-scroll="agent">${O.agents.length ? rows : empty}</div>
      ${detail(O.agents[O.sel])}
    </div>`;
}

export function approvalsHandleKey(k) {
  if (O.confirm) {
    if (k === "y" || k === "Y") confirmYes(); else confirmNo();
    return true;
  }
  switch (k) {
    case "j": case "ArrowDown": if (O.agents.length) { O.sel = Math.min(O.agents.length - 1, O.sel + 1); O.output = null; C.render(); } return true;
    case "k": case "ArrowUp": if (O.agents.length) { O.sel = Math.max(0, O.sel - 1); O.output = null; C.render(); } return true;
    case "Enter": stage(); return true;
    default: return false;
  }
}
export function approvalsClick(act) {
  if (act === "apv-yes") { confirmYes(); return true; }
  if (act === "apv-no") { confirmNo(); return true; }
  return false;
}
export function approvalsSelect(i, dbl) {
  O.sel = i; O.output = null;
  if (dbl) stage(); else C.render();
}
export function approvalsEscape() {
  if (O.confirm) { confirmNo(); return true; }
  return false;
}
