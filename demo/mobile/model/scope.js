/**
 * Home's scope: which cluster and namespace the rings are about, as the TUI's
 * filters. Pure helpers over the snapshot; an empty cluster or namespace is
 * unfiltered. Placement is the TUI's too (public/tui/goals.js): the core's
 * word on an issue first, then its source path, then where the service it is
 * about runs.
 */
import { lastSegment, parseSource } from "./format.js"

/** The single-cluster key "default" is the empty cluster. */
export const normCluster = (c) => (c === "default" ? "" : c ?? "")

/** A scope is { cluster, ns }; either may be empty. */
export const isScoped = (sc) => !!(sc && (sc.cluster || sc.ns))

const within = (sc, cluster, ns) => (!sc.cluster || normCluster(cluster) === sc.cluster) && (!sc.ns || (ns ?? "") === sc.ns)

/** The clusters the tenant's apps run in, sorted. */
export function clustersOf(apps) {
  const set = new Set()
  for (const a of apps ?? []) {
    const c = normCluster(a.cluster)
    if (c) set.add(c)
  }
  return [...set].sort()
}

/** The namespaces the apps run in, within a cluster when one is picked, sorted. */
export function namespacesOf(apps, cluster) {
  const set = new Set()
  for (const a of apps ?? []) if (a.namespace && (!cluster || normCluster(a.cluster) === cluster)) set.add(a.namespace)
  return [...set].sort()
}

/** The scopes a swipe walks, in order: the whole tenant, then each cluster
 *  and, when it runs in more than one namespace, each of its namespaces. */
export function scopeSteps(apps) {
  const steps = [{ cluster: "", ns: "" }]
  for (const cluster of clustersOf(apps)) {
    steps.push({ cluster, ns: "" })
    const nss = namespacesOf(apps, cluster)
    if (nss.length > 1) for (const ns of nss) steps.push({ cluster, ns })
  }
  return steps
}

/** service -> where it runs, from the apps list. */
export function placesOf(apps) {
  const places = new Map()
  for (const a of apps ?? []) {
    const k = a.serviceName || a.namespace
    if (k) places.set(k, (places.get(k) ?? []).concat({ cluster: normCluster(a.cluster), ns: a.namespace ?? "" }))
  }
  return places
}

export function issueInScope(i, sc, places) {
  const cl = (i.clusters?.length ? i.clusters : i.cluster ? [i.cluster] : []).map(normCluster)
  const ns = i.namespaces?.length ? i.namespaces : i.namespace ? [i.namespace] : []
  if (cl.length || ns.length) return (!sc.cluster || cl.includes(sc.cluster)) && (!sc.ns || ns.includes(sc.ns))
  const src = parseSource(i.source)
  if (src.cluster) return within(sc, src.cluster, src.namespace)
  return (places.get(lastSegment(i.source)) ?? []).some(p => within(sc, p.cluster, p.ns))
}

/** The issues in a scope; every issue when it is unfiltered. */
export function scopeIssues(issues, apps, sc) {
  if (!isScoped(sc)) return issues ?? []
  const places = placesOf(apps)
  return (issues ?? []).filter(i => issueInScope(i, sc, places))
}

/** The apps in a scope; every app when it is unfiltered. */
export function scopeApps(apps, sc) {
  if (!isScoped(sc)) return apps ?? []
  return (apps ?? []).filter(a => within(sc, a.cluster, a.namespace))
}

/** A deployment row (cluster, namespace) of the core's per-deployment series, or a baseline's cluster. */
export const rowInScope = (r, sc) => within(sc, r.cluster, r.namespace)
