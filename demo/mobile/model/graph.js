/**
 * Service-graph layout for the Apps screen, in a 360 × 220 viewBox starting
 * at x = -30. The same picture as the desktop app (tui goals.js graphSvg):
 * every node on one ring ordered by name, each edge a curve bent through the
 * centre, nodes coloured by blast radius against the graph's own thresholds
 * and sized by it, and a name beside each node while there are 40 or fewer.
 */
import { num } from "./format.js"

export const CX = 150, CY = 110
const RING = 92, LABEL_RING = 104, LABEL_MAX = 40

export function nodeColor(n, g) {
  const b = num(n.blastRadius) ?? 0
  const inc = num(g.issueThreshold)
  const noise = num(g.noiseThreshold)
  if (inc != null && b >= inc) return "#f87171"
  if (noise != null && b >= noise) return "#f59e0b"
  return "#6f7387"
}

export function edgesOf(g) {
  const seen = new Set()
  const out = []
  const add = (s, t) => {
    const k = s + "→" + t
    if (s && t && s !== t && !seen.has(k)) { seen.add(k); out.push({ source: s, target: t }) }
  }
  for (const e of g.edges ?? []) add(e.source, e.target)
  for (const n of g.nodes ?? []) {
    for (const c of n.calls ?? []) add(n.name, c)
    for (const c of n.calledBy ?? []) add(c, n.name)
  }
  return out
}

export function layoutGraph(g) {
  const all = g?.nodes ?? []
  if (!g || !all.length) return null
  const inc = num(g.issueThreshold) ?? 0.25
  const sorted = all.slice().sort((a, b) => (a.name < b.name ? -1 : 1))
  const labelled = sorted.length <= LABEL_MAX
  const nodes = sorted.map((nd, i) => {
    const a = (i / sorted.length) * Math.PI * 2 - Math.PI / 2
    const b = num(nd.blastRadius) ?? 0
    const cos = Math.cos(a)
    return {
      name: nd.name, named: labelled,
      x: CX + cos * RING, y: CY + Math.sin(a) * RING,
      r: 2.5 + Math.min(1, b / Math.max(inc, 0.001)) * 3.5, c: nodeColor(nd, g),
      lx: CX + cos * LABEL_RING, ly: CY + Math.sin(a) * LABEL_RING + 2.5,
      anchor: Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end",
      short: nd.name,
    }
  })
  const pos = new Map(nodes.map(n => [n.name, n]))
  const raw = edgesOf(g)
  const edges = []
  for (const e of raw) {
    const a = pos.get(e.source), b = pos.get(e.target)
    if (a && b) edges.push({ d: `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${CX},${CY} ${b.x.toFixed(1)},${b.y.toFixed(1)}` })
  }
  return {
    nodes, edges, nodeCount: all.length, edgeCount: raw.length,
    issueThreshold: num(g.issueThreshold) ?? null,
    noiseThreshold: num(g.noiseThreshold) ?? null,
  }
}
