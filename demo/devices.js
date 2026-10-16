// Interactive watch and tracker faces for the landing page. The tablet and the
// phone are the real apps in iframes (demo/tui, demo/mobile); these two are
// drawn here from the same sample data (demo/fixtures.js).
(function () {
  var D = window.TriageDemo;
  var NS = "http://www.w3.org/2000/svg";
  var RING_COLORS = ["#22d3ee", "#e879f9", "#8b8bf0", "#fbbf24"];
  var GOALS = [["Saturation", 100], ["Reliability", 99], ["Traffic", 96], ["Readiness", 100]];
  var SEV = { critical: ["CRIT", "#ef4444"], warning: ["WARN", "#f59e0b"] };

  function el(name, attrs) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function seeded(seed) { return function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; }

  // Concentric goal rings; `ticks` adds the ring of 5-minute signal ticks.
  function drawRings(svg, o) {
    var c = o.size / 2, rnd = seeded(11), i;
    if (o.ticks) {
      var palette = ["#3fa66b", "#3fa66b", "#3fa66b", "#22d3ee", "#f59e0b", "#8b8bf0", "#60a5fa"];
      for (i = 0; i < 120; i++) {
        var a = i / 120 * Math.PI * 2, deg = i / 120 * 360;
        var red = deg > 200 && deg < 232 && rnd() > 0.2;
        var len = red ? 9 + rnd() * 6 : 3 + rnd() * 9;
        var r0 = o.tickR, r1 = r0 + len;
        svg.appendChild(el("line", {
          x1: c + Math.sin(a) * r0, y1: c - Math.cos(a) * r0, x2: c + Math.sin(a) * r1, y2: c - Math.cos(a) * r1,
          stroke: red ? "#ef4444" : palette[Math.floor(rnd() * palette.length)], "stroke-width": o.tickW, "stroke-linecap": "round"
        }));
      }
    }
    o.fills.forEach(function (f, k) {
      var r = o.r0 - k * o.gap, circ = 2 * Math.PI * r;
      svg.appendChild(el("circle", { cx: c, cy: c, r: r, fill: "none", stroke: "#262a45", "stroke-width": o.w }));
      svg.appendChild(el("circle", {
        cx: c, cy: c, r: r, fill: "none", stroke: RING_COLORS[k], "stroke-width": o.w, "stroke-linecap": "round",
        "stroke-dasharray": (circ * Math.min(f, 0.985)) + " " + circ, transform: "rotate(-90 " + c + " " + c + ")"
      }));
    });
    var t = el("text", { x: c, y: c + o.fs * 0.35, "text-anchor": "middle", fill: "#fff", "font-size": o.fs, "font-weight": 500, "font-family": "system-ui,-apple-system,Segoe UI,Roboto,sans-serif" });
    t.textContent = o.score + "%";
    svg.appendChild(t);
  }

  // Pages inside a device screen: tap or crown for next, side button for back,
  // swipe and wheel too. `detail` is an optional page opened from a list row.
  function pager(root) {
    var pages = [].slice.call(root.querySelectorAll("[data-page]"));
    var dots = [].slice.call(root.querySelectorAll("[data-dot]"));
    var detail = root.querySelector("[data-detail]");
    var idx = 0, open = false, startX = 0, startY = 0, wheelAt = 0;
    function show() {
      pages.forEach(function (p, i) { p.classList.toggle("on", i === idx && !open); });
      if (detail) detail.classList.toggle("on", open);
      dots.forEach(function (d, i) { d.classList.toggle("on", i === idx); });
    }
    function go(n) { open = false; idx = (idx + n + pages.length) % pages.length; show(); }
    function back() { if (open) { open = false; show(); } else go(-1); }
    root.__go = go; root.__back = back;
    root.addEventListener("pointerdown", function (e) { startX = e.clientX; startY = e.clientY; });
    root.addEventListener("pointerup", function (e) {
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 28 && Math.abs(dx) > Math.abs(dy)) return go(dx < 0 ? 1 : -1);
      if (Math.abs(dy) > 28) return go(dy < 0 ? 1 : -1);
      var tria = e.target.closest && e.target.closest("[data-tria]");
      if (tria) {
        var on = tria.classList.toggle("live");
        tria.querySelector(".ta").textContent = on ? "Listening\u2026" : "Tap to talk to Tria";
        return;
      }
      var row = e.target.closest && e.target.closest("[data-issue]");
      if (row && detail) {
        var i = D.issues[+row.getAttribute("data-issue")];
        detail.querySelector("[data-d-svc]").textContent = i.source.split("/").pop();
        detail.querySelector("[data-d-sev]").textContent = SEV[i.severity][0];
        detail.querySelector("[data-d-sev]").style.color = SEV[i.severity][1];
        detail.querySelector("[data-d-txt]").textContent = i.summary;
        open = true; return show();
      }
      go(1);
    });
    root.addEventListener("wheel", function (e) {
      e.preventDefault();
      var now = Date.now(); if (now - wheelAt < 350) return; wheelAt = now;
      go(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    show();
  }

  function init() {
    if (!D) return;
    var score = 97, fills = GOALS.map(function (g) { return g[1] / 100; });
    var open = D.issues.filter(function (i) { return i.status === "open"; });

    document.querySelectorAll("[data-live]").forEach(function (box) {
      var f = box.querySelector("iframe");
      var w = +box.getAttribute("data-w"), h = +box.getAttribute("data-h");
      function fit() { var s = box.clientWidth / w; f.style.transform = "scale(" + s + ")"; box.style.height = (h * s) + "px"; }
      f.style.width = w + "px"; f.style.height = h + "px";
      fit();
      if (window.ResizeObserver) new ResizeObserver(fit).observe(box); else window.addEventListener("resize", fit);
    });

    document.querySelectorAll("[data-watch-face]").forEach(function (s) {
      drawRings(s, { size: 200, tickR: 80, tickW: 2.4, r0: 68, gap: 11.5, w: 8.5, fills: fills, score: score, fs: 27, ticks: true });
    });
    document.querySelectorAll("[data-tracker-face]").forEach(function (s) {
      drawRings(s, { size: 82, r0: 35, gap: 6.5, w: 4.2, fills: fills, score: score, fs: 11, ticks: false });
    });

    document.querySelectorAll("[data-goals]").forEach(function (box) {
      box.innerHTML = GOALS.map(function (g, i) {
        return '<div class="gr"><i style="background:' + RING_COLORS[i] + '"></i><span>' + g[0] + '</span><b>' + g[1] + '</b></div>';
      }).join("");
    });
    document.querySelectorAll("[data-issues]").forEach(function (box) {
      var n = +box.getAttribute("data-issues");
      box.innerHTML = open.slice(0, n).map(function (i, k) {
        var s = SEV[i.severity];
        return '<div class="ir" data-issue="' + D.issues.indexOf(i) + '"><i style="background:' + s[1] + '"></i><span>' + i.source.split("/").pop() + '</span></div>';
      }).join("");
    });
    document.querySelectorAll("[data-open]").forEach(function (b) { b.textContent = open.length; });
    document.querySelectorAll("[data-crit]").forEach(function (b) {
      b.textContent = open.filter(function (i) { return i.severity === "critical"; }).length;
    });

    document.querySelectorAll("[data-pager]").forEach(pager);
    document.querySelectorAll("[data-crown]").forEach(function (b) {
      b.addEventListener("click", function () { document.getElementById(b.getAttribute("data-crown")).__go(1); });
    });
    document.querySelectorAll("[data-side]").forEach(function (b) {
      b.addEventListener("click", function () { document.getElementById(b.getAttribute("data-side")).__back(); });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
