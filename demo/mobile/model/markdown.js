// The subset of Markdown Tria's answers use, as an HTML string for Md
// (components/Md.js): fenced code, tables (kept as monospace lines),
// headings, lists, `code`, **bold** and paragraphs. The same subset the TUI
// renders (tui/chat.js md). Everything is escaped before any tag is added.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c])

const inline = s => esc(s)
  .replace(/`([^`\n]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")

export function markdown(src) {
  const out = []
  String(src ?? "").split(/^```[^\n]*\n?/m).forEach((part, i) => {
    if (i % 2) { out.push(`<pre>${esc(part.replace(/\n$/, ""))}</pre>`); return }
    let para = [], table = []
    const flushP = () => { if (para.length) out.push(`<p>${para.map(inline).join("\n")}</p>`); para = [] }
    const flushT = () => { if (table.length) out.push(`<pre class="tbl">${esc(table.join("\n"))}</pre>`); table = [] }
    part.split("\n").forEach(line => {
      const t = line.trim()
      if (/^\|.*\|$/.test(t)) { flushP(); if (!/^\|[\s:|-]+\|$/.test(t)) table.push(t); return }
      flushT()
      let m
      if (!t) { flushP(); return }
      if ((m = t.match(/^#{1,6}\s+(.*)$/))) { flushP(); out.push(`<div class="h">${inline(m[1])}</div>`); return }
      if ((m = line.match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/))) {
        flushP()
        const lvl = Math.min(3, Math.floor(m[1].length / 2))
        const mark = /\d/.test(m[2]) ? esc(m[2]) : "•"
        out.push(`<div class="li" style="padding-left:${1.3 + lvl * 1.2}em"><span style="left:${lvl * 1.2}em">${mark}</span>${inline(m[3])}</div>`)
        return
      }
      para.push(line)
    })
    flushP(); flushT()
  })
  return out.join("")
}
