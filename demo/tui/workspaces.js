// Workspaces, the ws section of the workspaces panel (?, also Shift+W; core ADR-090). The caller's
// workspaces from GET /v2/tenants (an admin sees all); `n` creates one in an
// org from GET /v2/auth/me `orgs` (POST /v2/tenants); enter mints an
// enrolment key for the selected one (POST /v2/tenants/{id}/keys), whose
// install commands are shown once in copyable blocks; tab moves between the
// workspaces and their unspent keys, `r` revokes a key (DELETE
// /v2/tenants/{id}/keys/{keyId}). A key and an agent's binding carry the
// namespaces the workspace sees (empty = all); `e` on the agents list edits
// them (POST /v2/agents/{cluster}/bindings {tenant, namespaces}) and `r`
// revokes the agent behind a y/n confirm (DELETE /v2/agents/{cluster}; the
// core asks write and exec on every workspace it serves). Agents bound
// to the workspace come from GET /v2/tenants/{id}/agents and make the
// licences used. Admin only: `t` steps a trial out +7d/+14d/+30d (PATCH
// /v2/tenants/{id} {trialEnds}). `i` names the workspace's spot (its teammate agent), the
// name people see and write to in the messenger (PATCH /v2/tenants/{id}
// {spotName}; the owner or an admin; empty = "<workspace>-spot"). The danger zone under them deletes the
// workspace: `d` opens it and the workspace's name must be typed to confirm
// (DELETE /v2/tenants/{id}; its owner or an admin, purged after 30 days,
// restored only by an operator).
// The notifications list (core ADR-091) holds the workspace's own webhook
// channels (GET /v2/tenants/{id}/notify/channels): `a` adds one, `e` edits
// its severity, rate or URL, `m` mutes or unmutes it, `t` sends a test, `d`
// deletes it. The core never returns a webhook URL; it says only whether one is stored.
import { ago, arr, formatCount, requestJSON } from "./api.js";
import { copyText, esc, sub } from "./ui.js";

let C = null; // { S, render, flash }
const O = {
  items: [], loaded: false, loading: false, error: "", sel: 0,
  orgs: [], orgsFull: [], admin: false, // orgs = where `n` may create: an org at its trial limit (core orgsFull) only for an admin
  agents: {},              // workspace id -> agents bound to it
  keys: [], ksel: 0, asel: 0, focus: "ws", // the selected workspace's unspent keys and agents; which list j/k moves ("ws" | "key" | "agent" | "chan")
  view: "ws",              // the section drawing the panel: "ws" (keys, agents) or "notify" (channels)
  chans: [], csel: 0, meta: { types: [], max: 5 }, chanError: "", // the selected workspace's notification channels, the types the core allows and its channel cap
  detailError: "",
  form: null,              // { type: "create" | "key" | "agent" | "chan" | "chanedit", text, ns, field, error, i, focus } — i = index into orgs / KINDS / the channel types / SEVERITIES; field = the box that has the caret ("text" | "ns")
  confirm: null,           // { action, id, keyId, chan, lines }
  edit: null,              // { id, i } — index into TRIAL_STEPS
  minted: null,            // { ws, label, kind, blocks: [{ name, text }], ca } — shown once
  running: false, output: null, // { text, isErr }
  spots: {},               // workspace id -> its spot as the messenger shows it: { name, state, stats }
};
export function initWorkspaces(ctx) {
  C = ctx;
  // A spot's figures move while the panel is open: read them again from time to time.
  setInterval(() => { if (O.loaded && document.visibilityState === "visible" && document.querySelector('[data-scroll="ws"]')) loadSpots(); }, SPOT_EVERY);
}
// Drop the one-time key (leaving the workspaces panel, signing out), and any webhook URL being typed.
export function clearSecrets() {
  O.minted = null;
  if (O.form && (O.form.type === "chan" || O.form.type === "chanedit")) O.form = null;
}
// A form, confirm or step editor owns every key until it closes.
export const modal = () => !!(O.form || O.confirm || O.edit);

const SPOT_EVERY = 20000;
const KINDS = ["cluster", "otlp", "host"];
const TRIAL_STEPS = [7, 14, 30];
const SEVERITIES = ["info", "warning", "critical"];
const CHAN_TYPES = ["discord", "opsgenie", "slack", "teams"]; // until the core's own list arrives
const DAY = 86400000;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const errText = (e) => String((e && (e.coreMessage || e.message)) || e);
const listOf = (r, k) => (Array.isArray(r) ? r : arr(r && r[k]));
const at = (t) => { const ms = new Date(t).getTime(); return ms > 0 ? ms : 0; };
const day = (t) => new Date(t).toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" });
const ws = () => O.items[O.sel] || null;
// "a, b c" -> { list: ["a","b","c"] }, or { error } for the first name that is no DNS label.
const parseNs = (text) => {
  const list = [...new Set(String(text || "").split(/[\s,]+/).filter(Boolean))];
  const bad = list.find((n) => n.length > 63 || !DNS_LABEL.test(n));
  return bad ? { error: "namespace " + bad + " is not a DNS label (a-z, 0-9, -; at most 63; starts and ends with a letter or digit)" } : { list };
};
// The namespaces an agent serves for workspace id; none = every one.
// GET /v2/tenants/{id}/agents gives the workspace's own `binding`;
// GET /v2/agents gives every `bindings` entry.
const nsOf = (a, id) => {
  const b = (a && a.binding && a.binding.tenant === id) ? a.binding
    : arr(a && a.bindings).find((x) => x && x.tenant === id);
  return arr(b && b.namespaces).filter((n) => n !== "*");
};
const agentName = (a) => a.cluster || a.name || a.id;
const chanTypes = () => (O.meta.types.length ? O.meta.types : CHAN_TYPES);
const chanPath = (id, name) => "/v2/tenants/" + encodeURIComponent(id) + "/notify/channels" + (name ? "/" + encodeURIComponent(name) : "");
const chan = () => O.chans[O.csel] || null;
const isAdmin = (grants) => {
  const star = String(grants || "").split(",").map((p) => p.trim()).find((p) => p.startsWith("*:"));
  return !!star && [..."rwxivo"].every((b) => star.slice(2).includes(b));
};
// The licences a workspace holds: a bare number, or an object that carries the total.
const licTotal = (w) => {
  const l = w.licences;
  if (typeof l === "number") return l;
  if (l && typeof l === "object") for (const k of ["total", "max", "limit", "licences"]) if (typeof l[k] === "number") return l[k];
  return null;
};
// The agents bound to a workspace, by name; blank until they are read, a dash for none.
const agentsCell = (w) => {
  const list = O.agents[w.id];
  if (!list) return "";
  return list.length ? list.map(agentName).join(", ") : "–";
};
// A column as wide as its longest value (min 8, max 30 characters, 0.615em each), so a long name is shown whole.
const fitEm = (texts) => (Math.min(30, Math.max(8, ...texts.map((t) => String(t).length + 1))) * 0.615).toFixed(2) + "em";
const spotOf = (w) => w.spotName || w.name + "-spot";
const licCell = (w) => {
  const used = O.agents[w.id], total = licTotal(w);
  if (!used) return total == null ? "" : "–/" + total;
  return used.length + (total == null ? "" : "/" + total);
};

export async function loadWorkspaces() {
  if (O.loading) return;
  O.loading = true;
  C.render();
  try {
    const keep = ws() && ws().id;
    const [me, r] = await Promise.all([requestJSON("GET", "/v2/auth/me").catch(() => null), requestJSON("GET", "/v2/tenants")]);
    O.admin = isAdmin(me && me.grants);
    const full = arr(me && me.orgsFull).map(String);
    const orgs = arr(me && me.orgs).map((o) => (typeof o === "string" ? o : (o && (o.name || o.id)) || "")).filter(Boolean);
    O.orgsFull = O.admin ? [] : orgs.filter((o) => full.includes(o));
    O.orgs = orgs.filter((o) => !O.orgsFull.includes(o));
    O.items = listOf(r, "tenants").map((x) => ({ ...x, id: x.id || x.name, name: x.name || x.id }));
    O.error = ""; O.loaded = true;
    const at0 = O.items.findIndex((x) => x.id === keep);
    O.sel = at0 >= 0 ? at0 : Math.min(O.sel, Math.max(0, O.items.length - 1));
  } catch (e) {
    O.error = errText(e);
  } finally {
    O.loading = false;
    C.render();
  }
  loadDetail();
}
// Every workspace's spot (GET /v2/messenger/rooms, `spot` of a workspace room): who is up, its
// status line and the stats it reports. A core without the messenger has none.
async function loadSpots() {
  try {
    const r = await requestJSON("GET", "/v2/messenger/rooms");
    const m = {};
    arr(r && r.rooms).forEach((x) => { if (x.kind === "workspace" && x.workspace) m[x.workspace] = x.spot || null; });
    O.spots = m;
    C.render();
  } catch (e) { /* no messenger on this core, or it is down: no spot section */ }
}
// The selected workspace's keys and agents; the other workspaces' agents too
// while there are few, so every row can show its licences used.
async function loadDetail() {
  const w = ws();
  if (!w) { O.keys = []; O.agents = {}; O.chans = []; C.render(); return; }
  const id = w.id;
  const agentsOf = async (x) => {
    try { O.agents[x.id] = listOf(await requestJSON("GET", "/v2/tenants/" + encodeURIComponent(x.id) + "/agents"), "agents"); } catch (e) { if (x.id === id) O.detailError = errText(e); }
  };
  O.detailError = "";
  loadSpots();
  await Promise.all([
    (async () => { try { O.keys = listOf(await requestJSON("GET", "/v2/tenants/" + encodeURIComponent(id) + "/keys"), "keys"); } catch (e) { O.keys = []; O.detailError = errText(e); } })(),
    ...(O.items.length <= 20 ? O.items : [w]).map(agentsOf),
    (async () => {
      try {
        const r = await requestJSON("GET", chanPath(id));
        if (!ws() || ws().id !== id) return;
        O.chans = listOf(r, "channels"); O.chanError = "";
        O.meta = { types: arr(r && r.types), max: Number(r && r.maxChannels) || 5 };
      } catch (e) {
        if (!ws() || ws().id !== id) return;
        O.chans = [];
        O.chanError = e.status === 404 || e.status === 405 ? "this core has no notification channels yet" : errText(e);
      }
    })(),
  ]);
  if (ws() && ws().id === id) {
    O.csel = Math.min(O.csel, Math.max(0, O.chans.length - 1));
    O.ksel = Math.min(O.ksel, Math.max(0, O.keys.length - 1));
    O.asel = Math.min(O.asel, Math.max(0, arr(O.agents[id]).length - 1));
    C.render();
  }
}

function pick(i) {
  if (i === O.sel) return;
  O.sel = i; O.ksel = 0; O.asel = 0; O.csel = 0; O.keys = []; O.chans = []; O.chanError = ""; O.focus = "ws"; O.output = null; O.minted = null; O.form = null; O.confirm = null; O.edit = null;
  loadDetail();
  C.render();
}

function startCreate() {
  O.output = null; O.minted = null;
  if (!O.orgs.length) { C.flash(O.orgsFull.length ? "your org already has its trial workspace" : "you are in no org that may create workspaces"); C.render(); return; }
  O.form = { type: "create", text: "", i: 0, focus: true };
  C.render();
}
function startSpotName() {
  const w = ws();
  if (!w) { C.flash("pick a workspace"); return; }
  O.output = null; O.minted = null;
  O.form = { type: "spotname", id: w.id, name: w.name, text: w.spotName || "", field: "text", error: "", i: 0, focus: true };
  C.render();
}
function startKey() {
  const w = ws();
  if (!w) { C.flash("pick a workspace"); return; }
  O.output = null; O.minted = null;
  O.form = { type: "key", text: "", ns: "", field: "text", error: "", i: 0, focus: true };
  C.render();
}
function startAgent() {
  const w = ws(), a = arr(w && O.agents[w.id])[O.asel];
  if (!a) return;
  O.output = null; O.minted = null;
  O.form = { type: "agent", cluster: agentName(a), ns: nsOf(a, w.id).join(", "), field: "ns", error: "", i: 0, focus: true };
  C.render();
}
function startChan() {
  const w = ws();
  if (!w) { C.flash("pick a workspace"); return; }
  if (O.chans.length >= O.meta.max) { C.flash("a workspace holds at most " + O.meta.max + " channels"); return; }
  O.output = null; O.minted = null;
  O.form = { type: "chan", text: "", ns: "", field: "text", error: "", i: 0, focus: true };
  C.render();
}
function startChanEdit() {
  const c = chan();
  if (!c) return;
  O.output = null; O.minted = null;
  O.form = { type: "chanedit", name: c.name, text: String(c.maxPerMinute || ""), ns: "", field: "ns", error: "", i: Math.max(0, SEVERITIES.indexOf(c.minSeverity)), focus: true };
  C.render();
}
// What a channel is saved as: the PUT replaces every setting, so an edit sends the current ones back.
const chanBody = (c, over) => ({ type: c.type, minSeverity: c.minSeverity, events: c.events, maxPerMinute: c.maxPerMinute, enabled: c.enabled !== false, ...over });
async function chanCall(method, path, body, done) {
  O.running = true; O.output = null;
  C.render();
  try {
    await requestJSON(method, path, body);
    O.output = { text: done, isErr: false };
  } catch (e) {
    O.output = { text: "error: " + errText(e), isErr: true };
  } finally {
    O.running = false;
    C.render();
  }
  loadDetail();
}
// A webhook URL must be https; plain http only for a local test receiver.
const hookURLError = (u) => {
  let p;
  try { p = new URL(u); } catch (e) { return "the webhook URL is not a valid URL"; }
  if (p.protocol === "https:" || (p.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(p.hostname))) return "";
  return "the webhook URL must start with https://";
};
async function submitChan(f) {
  const w = ws(), url = (f.ns || "").trim();
  if (f.type === "chan") {
    const name = (f.text || "").trim().toLowerCase();
    if (!name) { C.flash("name the channel"); return; }
    if (!url) { f.error = "paste the webhook URL"; f.field = "ns"; f.focus = true; C.render(); return; }
    const bad = hookURLError(url);
    if (bad) { f.error = bad; f.field = "ns"; f.focus = true; C.render(); return; }
    O.form = null;
    await chanCall("PUT", chanPath(w.id, name), { type: chanTypes()[f.i], url }, "added channel " + name + "; press t to send a test");
    O.csel = Math.max(0, O.chans.findIndex((x) => x.name === name));
    return;
  }
  const c = O.chans.find((x) => x.name === f.name);
  if (!c) { O.form = null; C.render(); return; }
  const rate = Number((f.text || "").trim());
  if (!Number.isInteger(rate) || rate < 1 || rate > 30) { f.error = "the rate is 1 to 30 messages a minute"; f.field = "text"; f.focus = true; C.render(); return; }
  const bad = url && hookURLError(url);
  if (bad) { f.error = bad; f.field = "ns"; f.focus = true; C.render(); return; }
  O.form = null;
  await chanCall("PUT", chanPath(w.id, c.name), chanBody(c, { minSeverity: SEVERITIES[f.i], maxPerMinute: rate, ...(url ? { url } : {}) }), "saved channel " + c.name);
}
function muteChan() {
  const w = ws(), c = chan();
  if (!w || !c) return;
  const on = c.enabled === false;
  chanCall("PUT", chanPath(w.id, c.name), chanBody(c, { enabled: on }), (on ? "unmuted " : "muted ") + c.name);
}
function testChan() {
  const w = ws(), c = chan();
  if (!w || !c) return;
  chanCall("POST", chanPath(w.id, c.name) + "/test", undefined, "test message delivered to " + c.name);
}
function stageChanDelete() {
  const w = ws(), c = chan();
  if (!w || !c) return;
  O.output = null; O.minted = null;
  O.confirm = { action: "chandel", id: w.id, chan: c.name, lines: ["delete channel " + c.name + "?", "workspace " + w.name, "its webhook URL is removed with it"] };
  C.render();
}
// Up/down: the org, the kind, the channel type or the severity.
function formStep(d) {
  const f = O.form;
  if (f.type === "agent" || f.type === "delete" || f.type === "spotname") return;
  const n = f.type === "create" ? O.orgs.length : f.type === "chan" ? chanTypes().length : f.type === "chanedit" ? SEVERITIES.length : KINDS.length;
  f.i = (f.i + d + n) % n;
  C.render();
}
// Tab: the key form moves the caret between label and namespaces; the create form steps the org.
function formTab(d) {
  const f = O.form;
  if (f.type === "create") { formStep(d); return; }
  if (f.type === "key" || f.type === "chan" || f.type === "chanedit") { f.field = f.field === "ns" ? "text" : "ns"; f.focus = true; C.render(); }
}
async function submit() {
  const f = O.form;
  if (!f) return;
  if (f.type === "chan" || f.type === "chanedit") { await submitChan(f); return; }
  if (f.type === "delete") { await submitDelete(f); return; }
  if (f.type === "spotname") { await submitSpotName(f); return; }
  const text = (f.text || "").trim();
  if (f.type === "create" && !text) { C.flash("name the workspace"); return; }
  const ns = f.type === "create" ? { list: [] } : parseNs(f.ns);
  if (ns.error) { f.error = ns.error; f.field = "ns"; f.focus = true; C.render(); return; }
  O.form = null; O.running = true;
  C.render();
  try {
    if (f.type === "agent") {
      const w = ws();
      await requestJSON("POST", "/v2/agents/" + encodeURIComponent(f.cluster) + "/bindings", { tenant: w.id, namespaces: ns.list });
      O.output = { text: f.cluster + " serves " + (ns.list.length ? "namespaces " + ns.list.join(", ") : "all namespaces") + " of " + w.name, isErr: false };
      O.running = false;
      await loadDetail();
    } else if (f.type === "create") {
      const r = await requestJSON("POST", "/v2/tenants", { name: text, account: O.orgs[f.i] });
      O.output = { text: "created workspace " + ((r && r.name) || text) + " in " + O.orgs[f.i], isErr: false };
      O.running = false;
      await loadWorkspaces();
      if (C.refresh) C.refresh(); // the new workspace opens the other panels
      const j = O.items.findIndex((x) => x.id === (r && r.id) || x.name === text);
      if (j >= 0) { O.sel = j; O.ksel = 0; O.keys = []; loadDetail(); }
    } else {
      const w = ws();
      const r = await requestJSON("POST", "/v2/tenants/" + encodeURIComponent(w.id) + "/keys", { label: text, kind: KINDS[f.i], ...(ns.list.length ? { namespaces: ns.list } : {}) });
      O.minted = minted(w, text, KINDS[f.i], r);
      loadDetail();
    }
  } catch (e) {
    O.output = { text: "error: " + errText(e), isErr: true };
  } finally {
    O.running = false;
    C.render();
  }
}
// What the core accepts (tenantreg.CleanSpotName): 2 to 32 letters, digits, - _ or ., no spaces, never tria.
const SPOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;
async function submitSpotName(f) {
  const name = (f.text || "").trim();
  if (name && (!SPOT_NAME.test(name) || name.toLowerCase() === "tria")) {
    f.error = "2 to 32 letters, digits, - _ or ., no spaces, and not tria"; f.focus = true; C.render(); return;
  }
  O.form = null; O.running = true;
  C.render();
  try {
    await requestJSON("PATCH", "/v2/tenants/" + encodeURIComponent(f.id), { spotName: name });
    O.output = { text: name ? "the spot of " + f.name + " is now called " + name : "the spot of " + f.name + " goes by " + f.name + "-spot again", isErr: false };
  } catch (e) {
    O.output = { text: "error: " + errText(e), isErr: true };
  } finally {
    O.running = false;
    C.render();
  }
  await loadWorkspaces();
  if (C.refresh) C.refresh();
}
async function submitDelete(f) {
  if ((f.text || "").trim() !== f.name) { f.error = "type the workspace name exactly to delete it"; f.focus = true; C.render(); return; }
  O.form = null; O.running = true;
  C.render();
  try {
    await requestJSON("DELETE", "/v2/tenants/" + encodeURIComponent(f.id));
    O.output = { text: "deleted workspace " + f.name + ": purged in 30 days unless an operator restores it", isErr: false };
  } catch (e) {
    O.output = { text: "error: " + errText(e), isErr: true };
  } finally {
    O.running = false;
    C.render();
  }
  await loadWorkspaces();
  if (C.refresh) C.refresh();
}
// The install output as copyable blocks; the key itself when no command carries it.
function minted(w, label, kind, r) {
  const blocks = [];
  const inst = r.install || {};
  const names = ["helm", "annotate", "senders", "script"];
  [...names, ...Object.keys(inst).filter((k) => !names.includes(k))].forEach((k) => {
    const v = inst[k];
    if (v == null || v === "") return;
    blocks.push({ name: k, text: typeof v === "string" ? v : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2))).join("\n") : JSON.stringify(v, null, 2) });
  });
  if (r.key && !blocks.some((b) => b.text.includes(r.key))) blocks.unshift({ name: "key", text: r.key });
  return { ws: w.name, label: (r.keyInfo && r.keyInfo.label) || label, kind: (r.keyInfo && r.keyInfo.kind) || kind, blocks, ca: r.caFingerprint || "" };
}

// The danger zone's delete: a form, not a y/n, so a stray key cannot delete.
function startDelete() {
  const w = ws();
  if (!w || w.disabledAt) return;
  O.output = null; O.minted = null;
  O.form = { type: "delete", id: w.id, name: w.name, text: "", field: "text", error: "", i: 0, focus: true };
  C.render();
}
function stageAgentRevoke() {
  const w = ws(), a = arr(w && O.agents[w.id])[O.asel];
  if (!w || !a) return;
  O.output = null; O.minted = null;
  O.confirm = { action: "agentrevoke", id: w.id, cluster: agentName(a), lines: ["revoke agent " + agentName(a) + "?", "workspace " + w.name, "its sessions close now and it can join again only with a new key"] };
  C.render();
}
function stageRevoke() {
  const w = ws(), k = O.keys[O.ksel];
  if (!w || !k) return;
  const info = k.keyInfo || k;
  O.output = null; O.minted = null;
  O.confirm = { action: "revoke", id: w.id, keyId: info.id, lines: ["revoke key " + (info.label || info.id) + "?", "workspace " + w.name, "an agent that has not used it yet can no longer enrol with it"] };
  C.render();
}
async function confirmYes() {
  const c = O.confirm;
  if (!c) return;
  O.confirm = null; O.running = true;
  C.render();
  try {
    if (c.action === "chandel") {
      await requestJSON("DELETE", chanPath(c.id, c.chan));
      O.output = { text: "deleted channel " + c.chan, isErr: false };
    } else if (c.action === "agentrevoke") {
      await requestJSON("DELETE", "/v2/agents/" + encodeURIComponent(c.cluster));
      O.output = { text: "revoked agent " + c.cluster, isErr: false };
    } else {
      await requestJSON("DELETE", "/v2/tenants/" + encodeURIComponent(c.id) + "/keys/" + encodeURIComponent(c.keyId));
      O.output = { text: "revoked key " + c.keyId, isErr: false };
    }
  } catch (e) {
    O.output = { text: "error: " + errText(e), isErr: true };
  } finally {
    O.running = false;
    C.render();
  }
  loadDetail();
}
function confirmNo() { O.confirm = null; C.flash("cancelled"); C.render(); }

function startEdit() {
  const w = ws();
  if (!w) return;
  if (!O.admin) { C.flash("admin only"); return; }
  O.edit = { id: w.id, i: 1 };
  O.output = null; O.minted = null;
  C.render();
}
const trialTo = (w, i) => new Date(Math.max(Date.now(), at(w.trialEnds)) + TRIAL_STEPS[i] * DAY);
function editKey(k) {
  const e = O.edit;
  switch (k) {
    case "h": case "ArrowLeft": case "-": e.i = Math.max(0, e.i - 1); break;
    case "l": case "ArrowRight": case "+": case "=": e.i = Math.min(TRIAL_STEPS.length - 1, e.i + 1); break;
    case "Enter": saveEdit(); return;
    case "Escape": O.edit = null; C.flash("cancelled"); break;
  }
  C.render();
}
async function saveEdit() {
  const e = O.edit, w = ws();
  O.edit = null; O.running = true;
  C.render();
  const to = trialTo(w, e.i);
  try {
    await requestJSON("PATCH", "/v2/tenants/" + encodeURIComponent(e.id), { trialEnds: to.toISOString() });
    O.output = { text: w.name + " trial extended to " + day(to), isErr: false };
  } catch (err) {
    O.output = { text: "error: " + errText(err), isErr: true };
  } finally {
    O.running = false;
    C.render();
  }
  loadWorkspaces();
}

const copyAll = () => O.minted && copyText(O.minted.blocks.map((b) => b.text).join("\n\n")).then((ok) => C.flash(ok ? "copied the install commands" : "clipboard unavailable"));

function detail() {
  if (O.minted) {
    const m = O.minted;
    return `<div class="confirm"><div class="fg-strong b">key ${esc(m.label)} (${esc(m.kind)}) for ${esc(m.ws)}</div>
      <div class="fg-warn">shown once: copy it now, it will not be shown again</div>
      ${m.blocks.map((b, i) => `<div class="fg-faint">${esc(b.name)} <button type="button" class="chcopy" data-act="ws-copy" data-i="${i}">copy</button></div><pre class="chpre">${esc(b.text)}</pre>`).join("")}
      ${m.ca ? `<div class="fg-text">CA fingerprint ${esc(m.ca)}</div>` : ""}
      <span class="fg-faint">y copies all · esc closes</span></div>`;
  }
  if (O.form) {
    const f = O.form, w = ws();
    if (f.type === "chan" || f.type === "chanedit") return chanForm(f, w);
    if (f.type === "spotname") return `<div class="confirm"><div class="fg-strong b">name the spot of ${esc(f.name)}</div>
      <div class="fg-text">the name people see and write to in the messenger; empty goes back to ${esc(f.name)}-spot</div>
      <label class="dsearch"><input id="wsin" type="text" autocomplete="off" spellcheck="false" maxlength="32" placeholder="${esc(f.name)}-spot" value="${esc(f.text)}"></label>
      ${f.error ? `<div class="fg-crit">${esc(f.error)}</div>` : ""}
      <div class="btnrow" style="padding-top:6px"><button type="button" class="btn primary" data-act="ws-submit">save</button><button type="button" class="btn" data-act="ws-cancel">cancel</button></div>
      <span class="fg-faint">enter saves · esc cancels</span></div>`;
    if (f.type === "delete") return `<div class="confirm"><div class="fg-crit b">delete workspace ${esc(f.name)}?</div>
      <div class="fg-text">its keys are revoked and its agents cut off now; agents shared with another workspace keep that one</div>
      <div class="fg-text">its data is purged in 30 days; until then only an operator can restore it</div>
      <label class="dsearch"><input id="wsin" type="text" autocomplete="off" spellcheck="false" placeholder="type ${esc(f.name)} to confirm" value="${esc(f.text)}"></label>
      ${f.error ? `<div class="fg-crit">${esc(f.error)}</div>` : ""}
      <div class="btnrow" style="padding-top:6px"><button type="button" class="btn primary" data-act="ws-submit">delete</button><button type="button" class="btn" data-act="ws-cancel">cancel</button></div>
      <span class="fg-faint">enter deletes · esc cancels</span></div>`;
    const choices = f.type === "agent" ? "" : (f.type === "create" ? O.orgs : KINDS).map((x, i) => `<span class="${i === f.i ? "fg-label b" : "fg-dim"}" data-act="ws-pick" data-i="${i}" style="cursor:pointer">${i === f.i ? "[" + esc(x) + "]" : esc(x)}</span>`).join(" ");
    const title = f.type === "create" ? "new workspace" : f.type === "key" ? "new key for " + esc(w ? w.name : "") : "namespaces of " + esc(f.cluster) + " in " + esc(w ? w.name : "");
    const nsBox = `<label class="dsearch"><input id="wsns" type="text" autocomplete="off" spellcheck="false" placeholder="namespaces (empty = all)" value="${esc(f.ns)}"></label>`;
    return `<div class="confirm"><div class="fg-strong b">${title}</div>
      ${f.type === "agent" ? "" : `<div class="fg-text">${f.type === "create" ? "org" : "kind"} ${choices}</div>
      <label class="dsearch"><input id="wsin" type="text" autocomplete="off" spellcheck="false" placeholder="${f.type === "create" ? "name" : "label"}" value="${esc(f.text)}"></label>`}
      ${f.type === "create" ? "" : nsBox}
      ${f.error ? `<div class="fg-crit">${esc(f.error)}</div>` : ""}
      <div class="btnrow" style="padding-top:6px"><button type="button" class="btn primary" data-act="ws-submit">${f.type === "create" ? "create" : f.type === "key" ? "mint" : "save"}</button><button type="button" class="btn" data-act="ws-cancel">cancel</button></div>
      <span class="fg-faint">${f.type === "create" ? (O.orgs.length > 1 ? "tab org · " : "") + "enter creates" : f.type === "key" ? "tab namespaces · up/down kind · enter mints" : "enter saves"} · esc cancels</span></div>`;
  }
  if (O.confirm) {
    const c = O.confirm;
    return `<div class="confirm">${c.lines.map((l, i) => `<div class="${i === 0 ? "fg-strong b" : "fg-text"}">${esc(l)}</div>`).join("")}
      <div class="btnrow" style="padding-top:6px"><button type="button" class="btn primary" data-act="ws-yes">y — ${esc(c.action)}</button><button type="button" class="btn" data-act="ws-no">n — cancel</button></div>
      <span class="fg-faint">y runs it against ${esc(location.host)} · any other key cancels</span></div>`;
  }
  if (O.edit) {
    const e = O.edit, w = ws();
    return `<div class="confirm"><div class="fg-strong b">extend the trial of ${esc(w.name)}: <span class="fg-label">+${TRIAL_STEPS[e.i]}d</span></div>
      <div class="fg-text">ends ${esc(day(trialTo(w, e.i)))}</div>
      <span class="fg-faint">h/l step · enter saves · esc cancels</span></div>`;
  }
  if (O.running) return `<span class="fg-dim">running…</span>`;
  if (O.output) return `<p class="para ${O.output.isErr ? "fg-crit" : "fg-ok"}">${esc(O.output.text)}</p>`;
  return "";
}

// The add and edit forms of a notification channel. The URL box hides what is typed: it is a secret.
function chanForm(f, w) {
  const add = f.type === "chan", list = add ? chanTypes() : SEVERITIES;
  const choices = list.map((x, i) => `<span class="${i === f.i ? "fg-label b" : "fg-dim"}" data-act="ws-pick" data-i="${i}" style="cursor:pointer">${i === f.i ? "[" + esc(x) + "]" : esc(x)}</span>`).join(" ");
  return `<div class="confirm"><div class="fg-strong b">${add ? "new notification channel in " + esc(w ? w.name : "") : "channel " + esc(f.name) + " in " + esc(w ? w.name : "")}</div>
    <div class="fg-text">${add ? "type" : "severity from"} ${choices}</div>
    <label class="dsearch"><input id="wsin" type="text" autocomplete="off" spellcheck="false" placeholder="${add ? "name, e.g. oncall" : "messages a minute, 1 to 30"}" value="${esc(f.text)}"></label>
    <label class="dsearch"><input id="wsns" type="password" autocomplete="new-password" spellcheck="false" placeholder="${add ? "webhook URL" : "new webhook URL (empty keeps the stored one)"}"></label>
    ${f.error ? `<div class="fg-crit">${esc(f.error)}</div>` : ""}
    <div class="btnrow" style="padding-top:6px"><button type="button" class="btn primary" data-act="ws-submit">${add ? "add" : "save"}</button><button type="button" class="btn" data-act="ws-cancel">cancel</button></div>
    <span class="fg-faint">tab name/URL · up/down ${add ? "type" : "severity"} · enter saves · esc cancels</span></div>`;
}

const stateCls = (s) => /disabled|purg|suspend/i.test(s) ? "fg-crit" : /trial|pending/i.test(s) ? "fg-warn" : "fg-ok";

function trialCell(w, now) {
  if (w.disabledAt) return { cls: "fg-crit", text: w.purgeAfter ? "purge " + day(w.purgeAfter) : "" };
  if (!w.trialEnds || !at(w.trialEnds)) return { cls: "fg-faint", text: "" };
  return { cls: at(w.trialEnds) < now ? "fg-crit" : "fg-dim", text: day(w.trialEnds) };
}

// view "ws": workspaces, keys and agents; "notify": the selected workspace's notification channels.
export function workspacesPanel(view = "ws") {
  const notify = view === "notify";
  if (O.view !== view) { O.view = view; if (notify ? O.focus === "key" || O.focus === "agent" : O.focus === "chan") O.focus = "ws"; }
  if (!O.loaded && !O.loading && !O.error) setTimeout(loadWorkspaces, 0);
  const now = Date.now();
  const agentsW = fitEm(["AGENTS", ...O.items.map(agentsCell)]), spotW = fitEm(["SPOTS", ...O.items.map(spotOf)]);
  const rows = O.items.map((w, i) => {
    const on = i === O.sel, t = trialCell(w, now);
    return `<div class="tr${on ? " sel" : ""}" data-act="sel" data-list="ws" data-i="${i}">
      <span class="mark">${on ? "&#9654;" : ""}</span>
      <span class="c ${stateCls(w.state)}" style="width:6.46em">${esc(w.state)}</span>
      <span class="c fg-violet" style="width:11.08em">${esc(w.name)}</span>
      <span class="c fg-dim opt" style="width:${agentsW}">${esc(agentsCell(w))}</span>
      <span class="c fg-dim opt" style="width:${spotW}">${esc(spotOf(w))}</span>
      <span class="c flex fg-label">${esc(w.account)}</span>
      <span class="c fg-dim opt" style="width:6.46em">${esc(licCell(w))}</span>
      <span class="c ${t.cls} opt" style="width:9.23em">${esc(t.text)}</span>
    </div>`;
  }).join("");
  const empty = O.error ? `<p class="para fg-crit">${esc(O.error)}</p>`
    : `<div class="empty">${O.loading || !O.loaded ? "reading workspaces…" : "no workspaces"}</div>`;
  const noOrg = O.loaded && !O.orgs.length && !O.error ? `<span class="fg-dim">${O.orgsFull.length ? esc(O.orgsFull.join(", ")) + " already has its trial workspace: delete it in the danger zone to start another, or ask us for more" : "you are in no org that may create workspaces"}</span>` : "";
  const w = ws();
  const keys = O.keys.map((k, i) => {
    const info = k.keyInfo || k, on = O.focus === "key" && i === O.ksel;
    return `<div class="tr${on ? " sel" : ""}" data-act="sel" data-list="wskey" data-i="${i}">
      <span class="mark">${on ? "&#9654;" : ""}</span>
      <span class="c fg-violet" style="width:9.23em">${esc(info.label || info.id)}</span>
      <span class="c fg-label" style="width:5.54em">${esc(info.kind)}</span>
      <span class="c fg-faint flex">${info.expiresAt && at(info.expiresAt) ? (at(info.expiresAt) < now ? "expired " : "expires ") + esc(day(info.expiresAt)) : ""}</span>
      ${on ? `<span class="c fg-faint opt">&#183; r revokes</span>` : ""}
    </div>`;
  }).join("");
  const agList = arr(w && O.agents[w.id]);
  const aw = Math.min(30, Math.max(15, ...agList.map((a) => String(agentName(a)).length + 1))) * 0.615 + "em";
  const ags = agList.map((a, i) => {
    const on = O.focus === "agent" && i === O.asel, nss = nsOf(a, w.id);
    return `<div class="tr${on ? " sel" : ""}" data-act="sel" data-list="wsagent" data-i="${i}">
      <span class="mark">${on ? "&#9654;" : ""}</span>
      <span class="c fg-violet" style="width:${aw}">${esc(agentName(a))}</span>
      <span class="c fg-label" style="width:5.54em">${esc(a.kind)}</span>
      <span class="c ${nss.length ? "fg-text" : "fg-faint"} flex">${esc(nss.length ? nss.join(", ") : "all")}</span>
      <span class="c fg-faint opt" style="width:5.54em">${esc(a.boundAt || a.approvedAt || a.createdAt ? ago(a.boundAt || a.approvedAt || a.createdAt, now) : "")}</span>
      ${on ? `<span class="c fg-faint opt">&#183; e namespaces · r revokes</span>` : ""}
    </div>`;
  }).join("");
  const chs = O.chans.map((c, i) => {
    const on = O.focus === "chan" && i === O.csel;
    const st = c.enabled === false ? ["muted", "fg-warn"] : c.urlConfigured === false ? ["no url", "fg-crit"] : ["on", "fg-ok"];
    return `<div class="tr${on ? " sel" : ""}" data-act="sel" data-list="wschan" data-i="${i}">
      <span class="mark">${on ? "&#9654;" : ""}</span>
      <span class="c ${st[1]}" style="width:5.54em">${st[0]}</span>
      <span class="c fg-violet" style="width:11.08em">${esc(c.name)}</span>
      <span class="c fg-label" style="width:6.46em">${esc(c.type)}</span>
      <span class="c fg-text" style="width:7.38em">${esc(c.minSeverity)}+</span>
      <span class="c fg-dim opt" style="width:6.46em">${esc(c.maxPerMinute)}/min</span>
      <span class="c fg-faint flex">${esc(arr(c.events).join(", "))}${c.suppressed ? esc(" · " + c.suppressed + " dropped") : ""}</span>
      ${on ? `<span class="c fg-faint opt">&#183; e edit · m mute · t test · d delete</span>` : ""}
    </div>`;
  }).join("");
  return `<div class="col g6">
    <div class="tbar"><span class="t">workspaces</span><span class="fill"></span><span class="hint">${notify ? "j/k workspace · a channel · tab channels" : `j/k workspace${O.orgs.length ? " · n new" : ""} · i spot name · enter key · tab keys/agents · e agent namespaces · r revoke${O.admin ? " · t trial" : ""}`}</span></div>
    ${sub(`workspaces(${O.items.length})`, ' data-sec="1"')}
    <div class="col">
      <div class="th"><span class="mark"></span><span class="c" style="width:6.46em">STATE</span><span class="c" style="width:11.08em">NAME</span><span class="c opt" style="width:${agentsW}">AGENTS</span><span class="c opt" style="width:${spotW}">SPOTS</span><span class="c flex">ORG</span><span class="c opt" style="width:6.46em">LICENCES</span><span class="c opt" style="width:9.23em">TRIAL ENDS</span></div>
      <div class="rows" data-scroll="ws">${O.items.length ? rows : empty}</div>
      ${notify ? "" : noOrg}
      ${detail()}
    </div>
    ${w && notify ? `<div class="col">${sub(`notifications(${O.chans.length}/${O.meta.max}) · ${w.name}`, ' data-sec="1"')}${O.chanError ? `<p class="para fg-dim">${esc(O.chanError)}</p>` : O.chans.length ? `<div class="rows" data-scroll="wschan">${chs}</div>` : `<div class="empty">no channels · press a to add a Discord, Slack, Teams or Opsgenie webhook</div>`}</div>` : ""}
    ${w && !notify ? `<div class="grid">
      <div class="col">${sub(`keys(${O.keys.length})`, ' data-sec="1"')}${O.keys.length ? `<div class="rows" data-scroll="wskey">${keys}</div>` : `<div class="empty">no unspent keys</div>`}</div>
      <div class="col">${sub(`agents(${arr(O.agents[w.id]).length})`, ' data-sec="1"')}${ags ? `<div class="rows" data-scroll="wsagent">${ags}</div>` : `<div class="empty">no agents bound</div>`}</div>
    </div>${spotsSection()}${O.detailError ? `<p class="para fg-crit">${esc(O.detailError)}</p>` : ""}
    ${w.disabledAt ? "" : `<div class="col"><div class="sub" data-sec="1"><span style="color:var(--crit)">&#8212; danger zone</span></div>
      <div class="tr" data-act="ws-delete" style="cursor:pointer"><span class="mark"></span><span class="c fg-crit" style="width:11.08em">delete workspace</span><span class="c fg-faint flex">revokes its keys, cuts off its agents, purged after 30 days</span><span class="c fg-faint opt">d</span></div></div>`}` : ""}
  </div>`;
}

// "412K / 1.00M · 41%" for tokens spent of a cap; the spent alone without one.
const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : formatCount(n));
const spendText = (l) => (l.cap > 0 ? `${tok(l.spent)} / ${tok(l.cap)} · ${Math.round(l.spent / l.cap * 100)}%` : `${tok(l.spent)} · no cap`);
const inText = (ms, now) => {
  const s = Math.round((ms - now) / 1000);
  return s <= 0 ? "due" : s < 90 ? "in " + s + "s" : s < 5400 ? "in " + Math.round(s / 60) + "m" : "in " + Math.round(s / 3600) + "h";
};
// The spots of the listed workspaces, one row each: up or down, what the spot spent today of the core's
// cap for it, and the figures it reports about itself (turns, wakes by reason, context, next wake).
// Counts only; nothing it did. A workspace whose spot has never called this core shows as "no spot yet".
function spotsSection() {
  const items = O.items.slice(0, 20);
  if (!items.length) return "";
  const now = Date.now();
  const lim = ((((C.S || {}).raw || {}).status || {}).limits || {}).tenants || {};
  const known = items.filter((w) => O.spots[w.id]).length;
  const nameW = fitEm(["SPOT", ...items.map((w) => spotOf(w))]), wsW = fitEm(["WORKSPACE", ...items.map((w) => w.name)]);
  const cell = (cls, width, text) => `<span class="c ${cls} opt" style="width:${width}">${esc(text)}</span>`;
  const head = `<div class="th"><span class="mark"></span><span class="c" style="width:4.6em">STATE</span><span class="c" style="width:${nameW}">SPOT</span><span class="c opt" style="width:${wsW}">WORKSPACE</span><span class="c" style="width:17em">SPENT TODAY</span><span class="c opt" style="width:4.6em">TURNS</span><span class="c opt" style="width:10em">READ / OUT</span><span class="c opt" style="width:7em">CONTEXT</span><span class="c opt" style="width:12em">NEXT CHECK</span><span class="c opt" style="width:5.5em">VIA</span><span class="c flex opt">WAKES TODAY</span></div>`;
  const rows = items.map((w) => {
    const sp = O.spots[w.id], on = w === ws();
    const mark = `<span class="mark">${on ? "&#9654;" : ""}</span>`;
    if (!sp) {
      return `<div class="tr${on ? " sel" : ""}">${mark}<span class="c fg-faint" style="width:4.6em">&#8211;</span><span class="c fg-dim" style="width:${nameW}">${esc(spotOf(w))}</span>${cell("fg-faint", wsW, w.name)}<span class="c fg-faint flex">no spot yet</span></div>`;
    }
    const st = sp.stats || null, spend = (lim[w.id] || {}).spot;
    const up = sp.state === "up", capped = spend && spend.blockedBy === "spot";
    const wakes = st ? Object.entries(st.wakes || {}).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]).map(([k, n]) => k + " " + n).join(" · ") : "";
    const spendCell = spend
      ? `<span class="c ${capped ? "fg-crit" : spend.cap > 0 && spend.spent >= spend.cap * 0.8 ? "fg-warn" : "fg-text"}" style="width:17em">${esc(spendText(spend))}${capped ? " · capped" : ""}</span>`
      : `<span class="c fg-faint" style="width:17em">&#8211;</span>`;
    return `<div class="tr${on ? " sel" : ""}">
      ${mark}
      <span class="c ${up ? "fg-ok" : "fg-crit"}" style="width:4.6em">${up ? "up" : "down"}</span>
      <span class="c fg-violet" style="width:${nameW}">${esc(sp.name || spotOf(w))}</span>
      ${cell("fg-dim", wsW, w.name)}
      ${spendCell}
      ${cell("fg-text", "4.6em", st ? String(st.turns || 0) : "–")}
      ${cell("fg-dim", "10em", st && (st.cacheReadTokens || st.outputTokens) ? formatCount(st.cacheReadTokens || 0) + " / " + formatCount(st.outputTokens || 0) : "–")}
      ${cell("fg-dim", "7em", st && st.contextTokens ? formatCount(st.contextTokens) : "–")}
      ${cell("fg-dim", "12em", st && st.nextWake ? inText(st.nextWake, now) + (st.triggers === "stream" ? ", or on event" : "") : "–")}
      ${cell("fg-dim", "5.5em", st && st.triggers ? st.triggers : "–")}
      <span class="c fg-faint flex opt">${esc(wakes || (st ? "none yet" : "no report yet"))}${st && st.failures ? esc(" · " + st.failures + " failed in a row") : ""}</span>
    </div>`;
  }).join("");
  return `<div class="col">${sub(`spots(${known})`, ' data-sec="1"')}${head}<div class="rows">${rows}</div></div>`;
}

// Focus the text box a form has just opened.
export function afterRender(el) {
  if (!O.form) return;
  // The webhook URL is a secret: it is put back as the box's value, never written into the markup.
  if (O.form.type === "chan" || O.form.type === "chanedit") { const u = el.querySelector("#wsns"), v = O.form.ns || ""; if (u && u.value !== v) u.value = v; }
  if (!O.form.focus) return;
  O.form.focus = false;
  const n = el.querySelector(O.form.field === "ns" ? "#wsns" : "#wsin");
  if (n) n.focus();
}
export function onInput(ev) {
  if (!/^ws(in|ns)$/.test(ev.target.id) || !O.form) return false;
  if (ev.target.id === "wsns") { O.form.ns = ev.target.value; O.form.error = ""; } else O.form.text = ev.target.value;
  return true;
}
// Keys pressed inside the form's text box.
export function inputKeyDown(ev) {
  if (!O.form) return false;
  if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); submit(); return true; }
  if (ev.key === "Escape") { ev.preventDefault(); cancelForm(); return true; }
  if (ev.key === "Tab" || ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); (ev.key === "Tab" ? formTab : formStep)(ev.key === "ArrowUp" || (ev.key === "Tab" && ev.shiftKey) ? -1 : 1); return true; }
  return false;
}
function cancelForm() { O.form = null; C.flash("cancelled"); C.render(); }

export function workspacesHandleKey(k) {
  if (O.confirm) {
    if (k === "y" || k === "Y") confirmYes(); else confirmNo();
    return true;
  }
  if (O.edit) { editKey(k); return true; }
  if (O.form) {
    if (k === "Escape") cancelForm();
    else if (k === "Enter") submit();
    else if (k === "Tab") formTab(1);
    else if (k === "BackTab") formTab(-1);
    return true;
  }
  if (O.minted) {
    if (k === "y") { copyAll(); return true; }
    if (k === "Escape" || k === "Enter") { O.minted = null; C.render(); return true; }
  }
  const keys = O.focus === "key", agents = O.focus === "agent", chans = O.focus === "chan", notify = O.view === "notify";
  // The notify view knows only the channel keys; the ws view only the workspace, key and agent ones.
  if (notify && ["n", "Enter", "r"].includes(k)) return false;
  if (!notify && ["a", "m"].includes(k)) return false;
  switch (k) {
    case "n": startCreate(); return true;
    case "i": startSpotName(); return true;
    case "a": startChan(); return true;
    case "m": if (chans) muteChan(); else C.flash("tab to the channels, pick one"); return true;
    case "t": if (notify) { if (chans) testChan(); else C.flash("tab to the channels, pick one"); } else startEdit(); return true;
    case "d": if (notify) { if (chans) stageChanDelete(); else C.flash("tab to the channels, pick one"); } else startDelete(); return true;
    case "r": if (keys) stageRevoke(); else if (agents) stageAgentRevoke(); else C.flash("tab to a key or an agent, pick one"); return true;
    case "e": if (chans) startChanEdit(); else if (agents) startAgent(); else C.flash(notify ? "tab to the channels, pick one" : "tab to the agents, pick one"); return true;
    case "Tab": case "BackTab": {
      const stops = notify ? ["ws", ...(O.chans.length ? ["chan"] : [])] : ["ws", ...(O.keys.length ? ["key"] : []), ...(arr(ws() && O.agents[ws().id]).length ? ["agent"] : [])];
      O.focus = stops[(stops.indexOf(O.focus) + (k === "BackTab" ? -1 : 1) + stops.length) % stops.length] || "ws";
      C.render();
      return true;
    }
    case "Enter": startKey(); return true;
    case "j": case "ArrowDown":
      if (chans) { O.csel = Math.min(O.chans.length - 1, O.csel + 1); C.render(); } else if (agents) { O.asel = Math.min(arr(ws() && O.agents[ws().id]).length - 1, O.asel + 1); C.render(); } else if (keys) { O.ksel = Math.min(O.keys.length - 1, O.ksel + 1); C.render(); } else if (O.items.length) pick(Math.min(O.items.length - 1, O.sel + 1));
      return true;
    case "k": case "ArrowUp":
      if (chans) { O.csel = Math.max(0, O.csel - 1); C.render(); } else if (agents) { O.asel = Math.max(0, O.asel - 1); C.render(); } else if (keys) { O.ksel = Math.max(0, O.ksel - 1); C.render(); } else if (O.items.length) pick(Math.max(0, O.sel - 1));
      return true;
    default: return false;
  }
}
export function workspacesClick(act, el) {
  switch (act) {
    case "ws-yes": confirmYes(); return true;
    case "ws-no": confirmNo(); return true;
    case "ws-submit": submit(); return true;
    case "ws-delete": startDelete(); return true;
    case "ws-cancel": cancelForm(); return true;
    case "ws-pick": if (O.form) { O.form.i = Number(el.dataset.i); C.render(); } return true;
    case "ws-copy": { const b = O.minted && O.minted.blocks[Number(el.dataset.i)]; if (b) copyText(b.text).then((ok) => C.flash(ok ? "copied the " + b.name : "clipboard unavailable")); return true; }
    default: return false;
  }
}
export function workspacesSelect(list, i) {
  if (list === "wskey") { O.focus = "key"; O.ksel = i; C.render(); return; }
  if (list === "wsagent") { O.focus = "agent"; O.asel = i; C.render(); return; }
  if (list === "wschan") { O.focus = "chan"; O.csel = i; C.render(); return; }
  O.focus = "ws";
  if (i === O.sel) C.render(); else pick(i);
}
