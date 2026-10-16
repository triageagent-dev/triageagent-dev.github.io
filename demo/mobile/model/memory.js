/**
 * Memory composition for the Awareness detail and the Apps "memory" mode.
 * Counts by kind from /v2/memory/summary (totalsByKind) or, failing that,
 * /v2/memory/metrics (composition.byKind). Drawn as proportional bars — the
 * design's scattered dot cloud placed dots at random, which is not data.
 */

const KIND_COLOR = [
  ["concern", "#ef4444"], ["issue", "#ef4444"],
  ["identity", "#8b8bf0"], ["service", "#8b8bf0"], ["entity", "#8b8bf0"],
  ["pattern", "#60a5fa"], ["operational", "#60a5fa"], ["playbook", "#60a5fa"],
  ["watch", "#a78bfa"], ["hypothesis", "#a78bfa"],
  ["fact", "#22c55e"], ["stable", "#22c55e"], ["baseline", "#22c55e"],
]

export const kindColor = (k) => {
  const key = k.toLowerCase()
  return KIND_COLOR.find(([t]) => key.includes(t))?.[1] ?? "#9ca3af"
}

const humanise = (k) => {
  const s = k.replace(/[_-]+/g, " ").trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function buildMemory(snap) {
  const s = snap?.memSummary, m = snap?.memMetrics
  const byKind = s?.totalsByKind ?? m?.composition?.byKind
  if (!s && !m) return null
  const kinds = Object.entries(byKind ?? {})
    .filter(([, n]) => typeof n === "number" && n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => ({ label: humanise(k), n, c: kindColor(k) }))
  const st = m?.composition?.byStatus
  return {
    total: s?.total ?? m?.items ?? null,
    active: st?.active ?? null,
    stale: st?.stale ?? null,
    workingSet: m?.composition?.workingSet ?? null,
    tenantCount: (s?.totalsByTenant ?? m?.composition?.byTenant)?.[snap.tenant] ?? null,
    kinds,
  }
}
