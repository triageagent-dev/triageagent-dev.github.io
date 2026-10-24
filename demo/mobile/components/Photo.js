import { html, useState } from "../vendor/preact-htm.js"

/**
 * A person's (or a chat's) round picture: their photo when they have one,
 * else their initial on a colour. A photo that fails to load falls back too.
 */
export function Photo({ src, name = "?", size = 36, color = "var(--avatar-bg)", square = false, style }) {
  const [broken, setBroken] = useState("")
  const box = { width: size, height: size, borderRadius: square ? Math.round(size / 3) : 999, flexShrink: 0, ...style }
  if (src && broken !== src) {
    return html`<img src=${src} alt="" loading="lazy" onError=${() => setBroken(src)} style=${{ ...box, objectFit: "cover", background: "var(--well)", display: "block" }} />`
  }
  return html`<span style=${{ ...box, background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: Math.round(size * 0.42), fontWeight: 500, color: "var(--text-strong)" }}>${(name || "?").slice(0, 1).toUpperCase()}</span>`
}
