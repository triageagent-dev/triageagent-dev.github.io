// Shared rendering helpers for the Triage TUI web client (app.js and the
// panel modules signals.js / chat.js / approvals.js).
import { DASH } from "./api.js";

export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// The title of a panel's bar: its name, then the tenant in view in brackets,
// the tenant in the label colour. `extra` follows the brackets.
export const panelTitle = (name, tenant, extra = "") => `<span class="t">${name} [<span class="fg-label">${esc(tenant || "all")}</span>]${extra}</span>`;
export const v = (x) => (x == null || x === "" ? DASH : x);
export const sub = (t, attrs = "") => `<div class="sub"${attrs}><span>&#8212; ${esc(t)}</span></div>`;
export const kv = (k, val, cls = "", s = "", w = "") => `<div class="kv ${w}"><span class="k">${esc(k)}</span><span class="v ${cls}">${esc(v(val))}</span>${s ? `<span class="s">${esc(s)}</span>` : ""}</div>`;
// Column widths are given in px at the old 13px base and emitted in em, so
// they scale with the font size (--fs) instead of truncating at 15px.
export const em = (px) => +(px / 13).toFixed(2) + "em";
export const cellW = (w, cls, text, extra = "") => `<span class="c ${cls}" style="width:${em(w)}"${extra}>${esc(text)}</span>`;

// Offset of el from the top of box's scrolled content.
function relTop(el, box) {
  return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
}

// tab / shift+tab section jump inside a scroll box: the next (dir=1) or
// previous (dir=-1) [data-sec] header, wrapping at the ends — the CLI's
// jumpToSection over sectionTitle rules.
export function jumpSec(box, dir) {
  if (!box) return false;
  const hs = [...box.querySelectorAll("[data-sec]")];
  if (!hs.length) return false;
  const cur = box.scrollTop;
  const tops = hs.map((h) => Math.max(0, relTop(h, box) - 4));
  let target;
  if (dir > 0) {
    target = tops.find((t) => t > cur + 2);
    if (target == null) target = tops[0];
  } else {
    const prev = tops.filter((t) => t < cur - 2);
    target = prev.length ? prev[prev.length - 1] : tops[tops.length - 1];
  }
  box.scrollTop = target;
  return true;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(String(text)); return true; }
  catch (e) { return false; }
}
