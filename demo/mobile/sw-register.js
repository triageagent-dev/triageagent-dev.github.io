// Registers the shell service worker (../sw.js, scoped to the base path), as
// the old layout's inline script did; external because the CSP allows no
// unhashed inline script.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("../sw.js"); });
}
