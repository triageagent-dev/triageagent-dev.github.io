/**
 * Issue fractal from GET /v2/agent/issues/{id}/graph, ported from the
 * design's mapFractal/buildFractal (triage-api.js + the .dc.html).
 *
 * Every leaf stands for something the server reported: a node it returned, a
 * downstream service it named in blastGraph, the attached app status, a prior
 * episode in `historical`, or a similar-issue match. Nothing is seeded or
 * random; an issue with no graph draws nothing.
 */

export const LAYER_NAMES = ["Blast Radius", "App Status", "Causal Chain", "Historical", "Similar"]
export const LAYER_TINTS = ["#6366f1", "#22c55e", "#ef4444", "#6b7280", "#f59e0b"]

export const NODE_COLOR = {
  issue: "#e5e7eb", layer: "#6366f1", root: "#ef4444", symptom: "#f59e0b", recovery: "#22c55e",
  context: "#6b7280", info: "#9ca3af", affected: "#9ca3af", status: "#38bdf8", episode: "#6b7280", memory: "#a78bfa",
}

const LAYER_MATCH = [
  { key: "blast", tests: ["blast", "radius", "affected", "downstream", "impact"] },
  { key: "app", tests: ["app_status", "appstatus", "status", "workload", "component", "deployment"] },
  { key: "causal", tests: ["caus", "chain", "sequence", "timeline", "app", "event", "k8s"] },
  { key: "hist", tests: ["hist", "prior", "past", "episode"] },
  { key: "similar", tests: ["similar", "memory", "match", "related"] },
]

function nodeKind(n) {
  const t = String(n.nodeType || n.relation || n.layer || "").toLowerCase()
  if (/root|cause/.test(t)) return "root"
  if (/recover|resolv|heal/.test(t)) return "recovery"
  if (/symptom|effect|anomal/.test(t)) return "symptom"
  if (/context|info|note/.test(t)) return "context"
  const sev = String(n.severity || "").toLowerCase()
  if (/crit|error/.test(sev)) return "symptom"
  return "info"
}

function oneLine(s, cap) {
  const t = String(s || "").replace(/[#*`>_]/g, " ").replace(/\s+/g, " ").trim()
  if (!t) return ""
  const first = t.split(". ")[0] || t
  if (first.length <= cap) return first
  const cut = first.slice(0, cap)
  const sp = cut.lastIndexOf(" ")
  return (sp > cap * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…"
}

export function mapFractal(g) {
  if (!g) return null
  const nodes = g.nodes ?? []
  const buckets = LAYER_MATCH.map(() => [])
  for (const n of nodes) {
    const layer = String(n.layer || "").toLowerCase()
    let idx = LAYER_MATCH.findIndex(L => L.tests.some(t => layer.includes(t)))
    if (idx < 0) idx = 2
    buckets[idx].push(n)
  }
  const hist = g.historical ?? []
  const similarText = String(g.similarIssues || "")
  const similarN = (similarText.match(/^###\s*past issue/gim) || []).length
    || (similarText.match(/similarity\s*:/gi) || []).length
  const blastText = String(g.blastGraph || "")
  const scoreM = blastText.match(/blast[_ ]radius(?:[ _]score)?\s*[:=]\s*([0-9.]+)/i)
  const affM = blastText.match(/(?:affected downstream|directly used by|used by|affects)\s*\((\d+)\s*services?\)\s*:?\s*([^\n]*)/i)
  const affected = affM ? Number(affM[1]) || 0 : buckets[0].length
  const names = affM ? affM[2].replace(/\s+/g, " ").trim() : ""
  const blastLine = affM
    ? `${affected} affected downstream${names ? " · " + names : ""}${scoreM ? " · blast " + scoreM[1] : ""}`
    : scoreM ? `blast ${scoreM[1]}` : ""

  const known = [affected, g.appStatus ? 1 : 0, buckets[2].length, hist.length, similarN]
  const counts = buckets.map((b, i) => Math.min(16, b.length || known[i] || 0))
  const FILLER = ["affected", "status", "info", "episode", "memory"]
  const kindsByLayer = buckets.map((b, i) => {
    const ks = b.slice(0, counts[i]).map(nodeKind)
    while (ks.length < counts[i]) ks.push(FILLER[i])
    return ks
  })
  const chain = kindsByLayer[2]
  const roleTally = chain.reduce((m, k) => { m[k] = (m[k] || 0) + 1; return m }, {})
  const kindTally = kindsByLayer.reduce((m, ks) => { ks.forEach(k => { m[k] = (m[k] || 0) + 1 }); return m }, {})
  const roleSummary = ["root", "symptom", "recovery", "context"].filter(k => roleTally[k]).map(k => roleTally[k] + " " + k).join(", ")
  const details = [
    blastLine || (buckets[0].length ? `${buckets[0].length} affected downstream` : "no downstream impact mapped"),
    oneLine(String(g.appStatus || "").split(/\bresources\b/i)[0], 68).replace(/[:;,\s]+$/, "") || (buckets[1][0]?.message ?? "") || "no application status attached",
    chain.length ? `${chain.length} node${chain.length === 1 ? "" : "s"} · ${roleSummary || "roles unassigned"}` : "no causal chain reconstructed",
    hist.length ? `${hist.length} prior episode${hist.length === 1 ? "" : "s"}` : "first occurrence",
    similarN ? `${similarN} match${similarN === 1 ? "" : "es"} in issue memory` : "no memory match",
  ]
  return {
    counts, kindsByLayer, details, roleTally, kindTally, affected,
    service: g.service || "", total: nodes.length,
    windowFrom: g.windowFrom || "", windowTo: g.windowTo || "",
  }
}

/** Elliptical fan in a 370 × 300 viewBox (design buildFractal). */
export function drawFractal(fr) {
  const cx = 58, cy = 150
  const LAX = 128, LAY = 60, EAX = 296, EAY = 134
  const nodes = [{ x: cx, y: cy, r: 5.5, fill: NODE_COLOR.issue, stroke: NODE_COLOR.layer }]
  const edges = []
  const labels = []
  const span = 96, start = -48
  LAYER_NAMES.forEach((_, i) => {
    const a = ((start + (span * i) / (LAYER_NAMES.length - 1)) * Math.PI) / 180
    const lx = cx + LAX * Math.cos(a), ly = cy + LAY * Math.sin(a)
    edges.push({ d: `M${cx} ${cy} Q${cx + LAX * 0.55 * Math.cos(a)} ${cy + LAY * 0.9 * Math.sin(a)} ${lx} ${ly}` })
    nodes.push({ x: lx, y: ly, r: 4, fill: NODE_COLOR.layer, stroke: "none" })
    labels.push({ x: lx + 8, y: ly - 8 })
    const leaves = fr.counts[i]
    const kinds = fr.kindsByLayer[i]
    const leafSpan = 30, leafStart = -leafSpan / 2
    for (let j = 0; j < leaves; j++) {
      const la = a + ((leafStart + (leafSpan * j) / Math.max(1, leaves - 1)) * Math.PI) / 180
      const ex = cx + EAX * Math.cos(la), ey = cy + EAY * Math.sin(la)
      edges.push({ d: `M${lx} ${ly} Q${lx + (ex - lx) * 0.5} ${ly + (ey - ly) * 0.75} ${ex} ${ey}` })
      nodes.push({ x: ex, y: ey, r: kinds[j] === "info" ? 2.4 : 3.1, fill: NODE_COLOR[kinds[j]] ?? NODE_COLOR.info, stroke: "none" })
    }
  })
  return { nodes, edges, labels }
}
