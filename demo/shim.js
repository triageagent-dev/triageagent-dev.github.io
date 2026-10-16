// Answers the apps' /v2 calls from the sample data so the demo runs with no
// backend. Loaded after fixtures.js, before the app's own scripts.
(function () {
  var D = window.TriageDemo, realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input.url;
    var path = new URL(url, location.href).pathname;
    if (path.indexOf("/v2/") !== 0) return realFetch(input, init);
    var method = ((init && init.method) || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    var body = method === "GET" ? D.get(url) : {};
    var status = body == null ? 404 : 200;
    return Promise.resolve(new Response(JSON.stringify(body == null ? {} : body), { status: status, headers: { "content-type": "application/json" } }));
  };
  // Sign-in and sign-out lead nowhere in the demo: the links do nothing.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (a && new URL(a.href, location.href).pathname.indexOf("/v2/auth/") === 0) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  // A socket that opens and stays quiet: no live pushes, the apps poll instead.
  function Quiet() {
    var self = this; this.readyState = 0; this._l = {};
    setTimeout(function () { self.readyState = 1; self._emit("open", {}); }, 30);
  }
  Quiet.prototype = {
    send: function () {}, close: function () { this.readyState = 3; this._emit("close", {}); },
    addEventListener: function (t, f) { (this._l[t] = this._l[t] || []).push(f); },
    removeEventListener: function (t, f) { this._l[t] = (this._l[t] || []).filter(function (x) { return x !== f; }); },
    _emit: function (t, ev) { if (typeof this["on" + t] === "function") this["on" + t](ev); (this._l[t] || []).forEach(function (f) { f(ev); }); }
  };
  Quiet.CONNECTING = 0; Quiet.OPEN = 1; Quiet.CLOSING = 2; Quiet.CLOSED = 3;
  window.WebSocket = Quiet;
})();
