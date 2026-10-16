// Served as the home page (the server adds <base href="tui/">), phones go on
// to the mobile app, as the old home page did. A classic script in <head>,
// ahead of app.js, so a phone leaves before the TUI's modules and fonts are
// fetched (app.js's static imports all load before any of its own code runs).
(function () {
  var isPhone = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || "")
    || matchMedia("(display-mode: standalone)").matches || navigator.standalone === true
    || (window.innerWidth > 0 && window.innerWidth <= 768);
  if (document.querySelector("base") && isPhone) location.replace(new URL("../mobile", document.currentScript.src).href + location.search);
})();
