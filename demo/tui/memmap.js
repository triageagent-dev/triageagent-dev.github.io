// Panel 5 main view: the memory store as a Voronoi map, ported from the
// X-Ray memory graph (xray-ui components/memory-graph.tsx). Each cell is one
// memory item; categories sit in fixed radial sectors (kind → angle, tier),
// with a watermark label and the category's true total. Lines join cells
// that link to each other or share two or more tags. No d3: the cells are
// computed here by clipping the canvas against each neighbour's bisector.
// Live hits, region washes and news cells come from memlive.js.
import { esc } from "./ui.js";
import { kindColor } from "./api.js";
import { L, fadeAge } from "./memlive.js";

const DOT_HIT_MS = 1600, REGION_DOT_MS = 1200, LABEL_PULSE_MS = 1200;

// Canvas size in CSS px: the panel's own width and the height left under
// it, set per render so the map fills the panel edge to edge.
let W = 1000, H = 600;
// Bounded preview, as in X-Ray: a large store keeps every category on the
// map (round-robin by hit count) without freezing the browser.
const MAX_CELLS = 480;
const MAX_LINES = 600;

// Sector order and tiers from X-Ray's 12 standard categories (category-config.ts).
const SECTORS = [
  ["active_concern", 0.60], ["operational_pattern", 0.65], ["precursor_pattern", 0.66],
  ["watch_item", 0.68], ["stable_fact", 0.55], ["system_identity", 0.60],
  ["policy", 0.50], ["mental_map", 0.70], ["analytics_counter", 0.72],
  ["event", 0.75], ["incident_claim", 0.78], ["note", 0.40],
];
const SECTOR = Object.fromEntries(SECTORS.map(([k, tier], i) => [k, { tier, angle: (i * 2 * Math.PI) / 12 }]));

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) >>> 0;
  return h;
}
const lcg = (seed) => ((seed * 1664525 + 1013904223) >>> 0) / 0x100000000;

// Unknown kinds go to the outer tier, half a sector off the known ones so
// they never sit on top of a standard category.
// A deployment's /v2/categories wins over the built-in sectors.
function sectorOf(kind) {
  const k = String(kind || "unknown");
  return (L.categories && L.categories[k]) || SECTOR[k] || { tier: 0.85, angle: ((hashStr(k) % 12) + 0.5) * (2 * Math.PI) / 12 };
}
export const kindLabel = (k) => {
  const c = L.categories && L.categories[String(k)];
  return c ? c.label : String(k || "unknown").replace(/_/g, " ");
};
// The newsfeed kind: drawn brighter, with a glow, as in X-Ray.
const isNews = (it) => it.kind === "recent_change";
const delay = (age) => `animation-delay:-${Math.round(age)}ms`;

// Round-robin across kinds, busiest cells first, so no kind is starved.
function budget(entries, keep) {
  if (entries.length <= MAX_CELLS) return entries;
  const byKind = new Map();
  for (const e of entries) {
    const k = String(e.it.kind || "unknown");
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(e);
  }
  const buckets = [...byKind.values()];
  buckets.forEach((b) => b.sort((a, b2) => (b2.it.hitCount || 0) - (a.it.hitCount || 0)));
  const out = [];
  for (let round = 0; out.length < MAX_CELLS; round++) {
    let placed = false;
    for (const b of buckets) {
      if (round >= b.length) continue;
      out.push(b[round]); placed = true;
      if (out.length >= MAX_CELLS) break;
    }
    if (!placed) break;
  }
  if (keep && !out.includes(keep)) out[out.length - 1] = keep;
  return out;
}

// Elliptical radial layout: the panel is wide, so the sectors stretch to it.
function seeds(entries) {
  const cx = W / 2, cy = H / 2, rx = W * 0.46, ry = H * 0.46;
  const byKind = {};
  entries.forEach((e) => { const k = String(e.it.kind || "unknown"); (byKind[k] = byKind[k] || []).push(e); });
  const arc = Math.PI / 3;
  return entries.map((e) => {
    const k = String(e.it.kind || "unknown"), sec = sectorOf(k), h = hashStr(String(e.it.id));
    const t = sec.tier + (lcg(h) - 0.5) * 0.18;
    const group = byKind[k], n = group.length, idx = group.indexOf(e);
    const spread = n === 1 ? 0 : (idx / (n - 1) - 0.5) * arc * 0.8;
    const a = sec.angle + spread + (lcg(h + 7) - 0.5) * 0.08;
    return [Math.max(8, Math.min(W - 8, cx + Math.cos(a) * rx * t)), Math.max(8, Math.min(H - 8, cy + Math.sin(a) * ry * t))];
  });
}

// Keep the side of the line through m, normal d, that holds the seed:
// (p - m)·d <= 0 (Sutherland–Hodgman against one half-plane).
function clip(poly, mx, my, dx, dy) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = (a[0] - mx) * dx + (a[1] - my) * dy, db = (b[0] - mx) * dx + (b[1] - my) * dy;
    if (da <= 0) out.push(a);
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

// Voronoi cells over [0,W]×[0,H]. Neighbours are taken nearest first and
// the loop stops once a neighbour is more than twice the cell's furthest
// vertex away — no bisector beyond that can cut the cell.
function cells(pts) {
  return pts.map(([x, y], i) => {
    const near = [];
    for (let j = 0; j < pts.length; j++) {
      if (j === i) continue;
      const dx = pts[j][0] - x, dy = pts[j][1] - y, d2 = dx * dx + dy * dy;
      if (d2 > 0) near.push([d2, j]);
    }
    near.sort((a, b) => a[0] - b[0]);
    let poly = [[0, 0], [W, 0], [W, H], [0, H]];
    let reach2 = Math.max(x * x, (W - x) * (W - x)) + Math.max(y * y, (H - y) * (H - y));
    for (const [d2, j] of near) {
      if (d2 > 4 * reach2) break;
      const [px, py] = pts[j];
      poly = clip(poly, (x + px) / 2, (y + py) / 2, px - x, py - y);
      if (poly.length < 3) break;
      reach2 = 0;
      for (const [vx, vy] of poly) reach2 = Math.max(reach2, (vx - x) ** 2 + (vy - y) ** 2);
    }
    return poly;
  });
}

// The geometry only changes with the drawn ids, so a live re-render (every
// websocket push) reuses it.
let cache = { key: "", entries: null, pts: null, polys: null };
function geometry(entries) {
  const key = W + "x" + H + (L.categories ? "c" : "") + "\n" + entries.map((e) => e.it.id).join("\n");
  if (cache.key !== key) cache = { key, entries, pts: null, polys: null };
  if (!cache.pts) { cache.pts = seeds(entries); cache.polys = cells(cache.pts); }
  return cache;
}

const path = (poly) => poly.length ? "M" + poly.map(([x, y]) => x.toFixed(1) + "," + y.toFixed(1)).join("L") + "Z" : "";

// rows: the filtered memory list (the list view's rows, same indices);
// sel: the selected row or -1; totals: per-kind totals over the full store,
// used for the labels when no filter narrows the rows; w, h: the size to fill.
export function memMapSvg(rows, sel, totals, filtered, w, h) {
  if (!rows.length) return "";
  W = Math.max(320, Math.round(w || 1000)); H = Math.max(240, Math.round(h || 600));
  const all = rows.map((it, i) => ({ it, i }));
  const entries = budget(all, sel >= 0 ? all[sel] : null);
  const { pts, polys } = geometry(entries);
  const pos = new Map(entries.map((e, n) => [e.it.id, n]));

  // A direct hit lifts to 0.55 with a soft glow and fades to base over 20s;
  // the rest of its kind's region washes to 0.4 and fades the same way.
  // A search draws plain cells: its own read fires hits on every match.
  const hitAge = entries.map((e) => (filtered ? -1 : fadeAge(L.hits, e.it.id)));
  const cellsSvg = entries.map((e, n) => {
    const it = e.it, c = kindColor(it.kind), on = e.i === sel, news = !filtered && isNews(it);
    const base = news ? 0.4 : 0.28;
    const region = !filtered && hitAge[n] < 0 ? fadeAge(L.regions, String(it.kind)) : -1;
    const cls = ["mm-cell"];
    let style = `--mm-base:${base};color:${c}`;
    if (on) cls.push("on");
    if (hitAge[n] >= 0) { cls.push("hit"); style += ";" + delay(hitAge[n]); }
    else if (region >= 0) { cls.push("region"); style += ";" + delay(region); }
    else if (news) style += `;filter:drop-shadow(0 0 4px ${c}44)`;
    const stroke = on ? "rgba(255,255,255,.6)" : news ? c : "rgba(255,255,255,.22)";
    return `<path d="${path(polys[n])}" fill="${c}" fill-opacity="${on ? 0.5 : base}" stroke="${stroke}" stroke-width="${on || news ? 1.5 : 1}" class="${cls.join(" ")}" style="${style}" data-act="sel" data-list="mem" data-i="${e.i}" data-id="${esc(it.id)}"></path>`;
  });

  // Category watermarks, centred on the bounding box of the category's cells.
  const groups = {};
  entries.forEach((e, n) => { const k = String(e.it.kind || "unknown"); (groups[k] = groups[k] || []).push(n); });
  const labels = Object.entries(groups).map(([k, idx]) => {
    const pad = 24;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    idx.forEach((n) => polys[n].forEach(([x, y]) => {
      x = Math.max(pad, Math.min(W - pad, x)); y = Math.max(pad, Math.min(H - pad, y));
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }));
    const label = kindLabel(k).toUpperCase(), c = kindColor(k);
    const pulse = filtered ? -1 : fadeAge(L.labels, k, LABEL_PULSE_MS);
    const fs = Math.max(18, Math.min(72, Math.min((x1 - x0) / (label.length * 0.6 * 1.15), (y1 - y0) * 0.35)));
    const count = !filtered && totals && totals[k] ? totals[k] : idx.length;
    const lx = (x0 + x1) / 2, ly = (y0 + y1) / 2;
    return `<g${pulse >= 0 ? ` class="mm-label-hit" style="${delay(pulse)}"` : ""}><text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="${fs.toFixed(1)}" font-weight="700" letter-spacing="0.1em" fill="${c}" fill-opacity="0.05" stroke="${c}" stroke-opacity="0.28" stroke-width="1">${esc(label)}</text>
      <text x="${lx.toFixed(1)}" y="${(ly + fs * 0.65).toFixed(1)}" font-size="${Math.max(11, fs * 0.2).toFixed(1)}" font-weight="700" letter-spacing="0.08em" fill="${c}" fill-opacity="0.55">${esc(count)} ${count === 1 ? "item" : "items"}</text></g>`;
  });

  // Synapses: explicit links, then pairs sharing ≥2 tags (tenant tags left
  // out — every cell of a tenant carries one).
  const lines = [], seen = new Set();
  const line = (a, b, w, o) => {
    const id = a < b ? a + ":" + b : b + ":" + a;
    if (a === b || seen.has(id) || lines.length >= MAX_LINES) return;
    seen.add(id);
    const [x1, y1] = pts[a], [x2, y2] = pts[b];
    lines.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${kindColor(entries[a].it.kind)}" stroke-width="${w}" stroke-opacity="${o}"/>`);
  };
  entries.forEach((e, a) => (e.it.links || []).forEach((l) => { const b = pos.get(l.toId); if (b != null) line(a, b, 1.4, 0.45); }));
  const tags = entries.map((e) => new Set((e.it.tags || []).filter((t) => !String(t).startsWith("tenant/"))));
  for (let a = 0; a < entries.length && lines.length < MAX_LINES; a++) {
    if (tags[a].size < 2) continue;
    for (let b = a + 1; b < entries.length; b++) {
      let shared = 0;
      tags[b].forEach((t) => { if (tags[a].has(t)) shared++; });
      if (shared < 2) continue;
      if (Math.hypot(pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]) > Math.min(W, H) * 0.55) continue;
      line(a, b, 1 + shared * 0.4, Math.min(0.35, 0.1 + shared * 0.08));
    }
  }

  // Dots: a short radius pulse on a direct hit, a smaller one across the region.
  const dots = entries.map((e, n) => {
    const c = kindColor(e.it.kind), on = e.i === sel, [x, y] = pts[n];
    let anim = "";
    if (hitAge[n] >= 0 && hitAge[n] < DOT_HIT_MS) anim = ` class="mm-dot-hit" style="${delay(hitAge[n])}"`;
    else if (hitAge[n] < 0 && !filtered) {
      const r = fadeAge(L.regions, String(e.it.kind));
      if (r >= 0 && r < REGION_DOT_MS) anim = ` class="mm-dot-region" style="${delay(r)}"`;
    }
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${on ? 7 : 5}" fill="${on ? "#fff" : c}" fill-opacity="${on ? 0.9 : 0.35}" stroke="${c}" stroke-width="1.5"${anim}/>`;
  });

  return `<svg class="memmap" viewBox="0 0 ${W} ${H}" style="height:${H}px" role="img" aria-label="memory map">
    <defs><radialGradient id="mm-fade" cx="50%" cy="50%" r="60%"><stop offset="70%" stop-color="#fff"/><stop offset="100%" stop-color="#000"/></radialGradient>
    <mask id="mm-mask"><rect width="${W}" height="${H}" fill="url(#mm-fade)"/></mask></defs>
    <g mask="url(#mm-mask)">${cellsSvg.join("")}<g class="mm-ink">${labels.join("")}${lines.join("")}${dots.join("")}</g></g>
  </svg>`;
}

// How many rows the map draws out of the list (the preview cap).
export const memMapShown = (n) => Math.min(n, MAX_CELLS);
