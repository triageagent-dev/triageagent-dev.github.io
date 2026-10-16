// Entry point: the port of components/mobile/mobile-view.tsx. MobileView
// wraps the App in the canvas: fixed to the viewport (styles.css), so the
// document never scrolls and only a screen's own list does.
import { html, render } from "./vendor/preact-htm.js"
import { App } from "./App.js"

export function MobileView() {
  return html`
    <div class="mobile-pwa-container w-full bg-[#161826] text-[#e9e9ed]">
      <${App} />
    </div>
  `
}

render(html`<${MobileView} />`, document.body)
