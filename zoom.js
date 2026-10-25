// On very large screens the page keeps its proportions: everything is scaled up by the window width (CSS zoom)
// so it does not sit small in the middle of the window. Below 2200px nothing changes.
(function () {
  var d = document.documentElement;
  function fit() {
    var z = 1;
    if (innerWidth >= 2200) z = Math.min(2.2, Math.max(1, innerWidth / 1920));
    z = Math.round(z * 100) / 100;
    d.style.zoom = z === 1 ? "" : String(z);
    d.style.setProperty("--z", String(z));
  }
  fit();
  addEventListener("resize", fit);
})();
