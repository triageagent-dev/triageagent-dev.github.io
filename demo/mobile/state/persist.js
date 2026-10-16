/**
 * localStorage, wrapped: a private window or blocked storage must never
 * break the app — it just forgets.
 */
import { GOALS_KEY, goalsKey, ownGoalsFor } from "../../tui/rings.js"

export const CFG_KEY = "triage.cfg"
export const PRO_KEY = "triage.sub.pro"
export { GOALS_KEY }

function read(key) {
  try { return localStorage.getItem(key) } catch { return null }
}
function write(key, v) {
  try { localStorage.setItem(key, v) } catch { /* storage blocked */ }
}

export function loadCfg() {
  try {
    const v = JSON.parse(read(CFG_KEY) || "null")
    return { tenant: typeof v?.tenant === "string" ? v.tenant : "" }
  } catch {
    return { tenant: "" }
  }
}

export function saveCfg(cfg) {
  // Spread whatever else a future version stored, so writing one field never
  // silently drops another.
  let prev = {}
  try { prev = JSON.parse(read(CFG_KEY) || "{}") ?? {} } catch { prev = {} }
  write(CFG_KEY, JSON.stringify({ ...prev, ...cfg }))
}

export const loadPro = () => read(PRO_KEY) === "1"
export const savePro = (v) => write(PRO_KEY, v ? "1" : "0")

/**
 * The goals the viewer set in this browser for a tenant (shared with the
 * TUI): only the fields they set, each valid or dropped (tui/rings.js
 * ownGoals). A goal not set here follows the tenant's.
 */
export const loadOwnGoals = (tenant) => ownGoalsFor(read, tenant)

/** An empty object is still written: it says the viewer chose the tenant's
 *  goals, so the TUI does not fall back to goals an older UI left behind. */
export const saveOwnGoals = (tenant, own) => write(goalsKey(tenant), JSON.stringify(own))
