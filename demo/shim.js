// Answers the apps' /v2 calls from the sample data so the demo runs with no
// backend. Loaded after fixtures.js, before the app's own scripts.
(function () {
  var D = window.TriageDemo, realFetch = window.fetch.bind(window);
  // The mobile app shows its Chats tab on the paid tier: the demo runs as that.
  // Every visit starts on the stable workspace: a workspace picked on an earlier visit is not remembered.
  try { localStorage.removeItem("triage.cfg"); localStorage.removeItem("triage-tui.tenant"); } catch (e) { /* nothing stored */ }
  try { localStorage.setItem("triage.sub.pro", "1"); } catch (e) { /* the app then starts on the free tier */ }
  var SOCKS = [], sent = 0;
  function json(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json" } }); }
  function frame(f) { SOCKS.forEach(function (s) { s._emit("message", { data: JSON.stringify(f) }); }); }
  // What Tria answers in a chat, from the sample data: the open issues, read for the question asked.
  function triaAnswer(q) {
    var open = (D.issues || []).filter(function (i) { return i.status === "open"; });
    if (!open.length) return "Nothing is open on this workspace.";
    q = String(q || "").toLowerCase();
    var plain = open.map(function (i) { return i.source.split("/").pop(); });
    var names = open.map(function (i) { return i.source.split("/").pop() + " (" + i.severity + ")"; });
    if (/\b(new|since|still|change|update|latest)\b/.test(q)) return "Nothing new since you last asked: " + plain.join(" and ") + " are still open, both warning. I will say so here when either resolves.";
    if (/\b(why|cause|root|because)\b/.test(q)) return "Likely cause for " + plain[0] + ": " + open[0].summary + " The errors began minutes after its last deploy, so I would compare that version with the previous one first.";
    if (/\b(fix|do|should|resolve|roll|next)\b/.test(q)) return "I would roll " + plain[0] + " back to the previous version and watch its error rate for an hour. I ask before any change, so say the word.";
    return open.length + " open: " + names.join(", ") + ". " + open[0].summary;
  }
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input.url;
    var path = new URL(url, location.href).pathname;
    if (path.indexOf("/v2/") !== 0) return realFetch(input, init);
    var method = ((init && init.method) || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    // A message sent in a workspace chat: it is stored, and @tria answers on the stream.
    var sm = path.match(/^\/v2\/messenger\/rooms\/([^/]+)\/messages$/);
    if (sm && method === "POST") {
      var b = {}; try { b = JSON.parse(init.body); } catch (e) { /* no text */ }
      var room = decodeURIComponent(sm[1]), id = "sent-" + (++sent), tria = /@tria/i.test(b.text || "");
      if (tria) {
        setTimeout(function () { frame({ room: room, typing: ["Tria"] }); }, 400);
        setTimeout(function () { frame({ room: room, message: { id: "tria-" + id, ts: Date.now(), type: "text", sender: "@tria:triage", name: "Tria", tria: true, mine: false, body: triaAnswer(b.text) } }); }, 2200);
      }
      return Promise.resolve(json({ id: id, tria: tria }));
    }
    var body = method === "GET" ? D.get(url) : {};
    if (body == null) (D.misses = D.misses || []).push(method + " " + path);
    var status = body == null ? 404 : 200;
    return Promise.resolve(new Response(JSON.stringify(body == null ? {} : body), { status: status, headers: { "content-type": "application/json" } }));
  };
  // Sign-in and sign-out lead nowhere in the demo: the links do nothing.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (a && new URL(a.href, location.href).pathname.indexOf("/v2/auth/") === 0) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  // The demo stays in the page: a question to Tria is answered from the sample data above and
  // nothing leaves the browser. Files, camera, microphone and notification prompts are refused
  // before the browser can ask, and every other composer is read-only.
  var realClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type === "file") return; return realClick.apply(this, arguments); };
  document.addEventListener("click", function (e) { if (e.target && e.target.type === "file") { e.preventDefault(); e.stopPropagation(); } }, true);
  try {
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = function () { return Promise.reject(new DOMException("The demo has no microphone or camera", "NotAllowedError")); };
    if (window.Notification) window.Notification.requestPermission = function () { return Promise.resolve("denied"); };
  } catch (e) { /* the browser keeps its own */ }
  function markComposers() {
    document.querySelectorAll('input[placeholder="Ask Tria"]').forEach(function (el) {
      if (!el.readOnly) { el.readOnly = true; el.placeholder = "Read-only demo"; }
    });
    document.querySelectorAll("#askq, #chatq").forEach(function (el) {
      if (!el.disabled && el.placeholder !== "Ask Tria (demo)") el.placeholder = "Ask Tria (demo)";
    });
    document.querySelectorAll("textarea.cs-input").forEach(function (el) {
      if (el.placeholder === "Message") el.placeholder = "Ask @tria (demo)";
    });
  }
  document.addEventListener("DOMContentLoaded", function () {
    var st = document.createElement("style");
    st.textContent = '[aria-label="Attach"],[aria-label="Save"],[aria-label="Stop"],[aria-label="Search"],[data-act="chat-attach"],[data-act="chat-new"]{display:none!important}';
    document.head.appendChild(st);
    new MutationObserver(markComposers).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["placeholder"] });
    markComposers();
  });
  // A socket that opens and stays quiet, except for the two chats: the workspace
  // messenger stream and Tria's private chat answer from the sample data.
  function Quiet(url) {
    var self = this; this.readyState = 0; this._l = {}; this.url = url || ""; this._busy = false;
    setTimeout(function () {
      self.readyState = 1; self._emit("open", {});
      if (self.url.indexOf("/v2/messenger/ws") >= 0) { SOCKS.push(self); self._emit("message", { data: JSON.stringify({ hello: true }) }); }
      if (self.url.indexOf("/v2/agent/chat") >= 0) self._hello();
    }, 30);
  }
  Quiet.prototype = {
    send: function (data) {
      var m; try { m = JSON.parse(data); } catch (e) { return; }
      if (this.url.indexOf("/v2/agent/chat") >= 0 && m.text) this._answer(m.text);
    },
    close: function () { this.readyState = 3; var i = SOCKS.indexOf(this); if (i >= 0) SOCKS.splice(i, 1); this._emit("close", {}); },
    addEventListener: function (t, f) { (this._l[t] = this._l[t] || []).push(f); },
    removeEventListener: function (t, f) { this._l[t] = (this._l[t] || []).filter(function (x) { return x !== f; }); },
    _emit: function (t, ev) { if (typeof this["on" + t] === "function") this["on" + t](ev); (this._l[t] || []).forEach(function (f) { f(ev); }); },
    _say: function (f) { this._emit("message", { data: JSON.stringify(f) }); },
    _hello: function () {
      var u = { sessionInput: 0, sessionOutput: 0, input: 0, output: 0, thoughts: 0, cached: 0, context: 0, contextLimit: 60000, limit: 250000, used: 48000 };
      this._say({ hello: { model: "chat-1", tenant: D.tenant, bound: true, files: false, maxOutputTokens: 2048, toolsPerAnswer: 6, contextTokens: 60000, usage: u,
        tools: [{ name: "list_open_issues", description: "Open issues of this workspace" }, { name: "get_issue_detail", description: "One issue with its events and notes" }, { name: "inspect_service", description: "A service's health, signals and neighbours" }] } });
      this._say({ past: { turns: D.chatPast || [], next: "" } });
    },
    _answer: function (q) {
      var self = this, words = triaAnswer(q).split(" "), t = 300;
      function at(ms, f) { setTimeout(function () { if (self.readyState === 1) self._say(f); }, ms); }
      at(t, { tool: { id: "t1", name: "list_open_issues", args: {}, state: "run" } });
      at(t += 600, { tool: { id: "t1", name: "list_open_issues", args: {}, state: "ok" } });
      words.forEach(function (w, i) { at(t += 45, { delta: (i ? " " : "") + w }); });
      at(t += 100, { usage: { sessionInput: 2100, sessionOutput: 90, input: 2100, output: 90, thoughts: 0, cached: 0, context: 2400, contextLimit: 60000, limit: 250000, used: 50200 } });
      at(t += 50, { done: true });
    }
  };
  Quiet.CONNECTING = 0; Quiet.OPEN = 1; Quiet.CLOSING = 2; Quiet.CLOSED = 3;
  window.WebSocket = Quiet;
})();
