// The status band: the open issues and the goals read together, so the word
// above the rings never contradicts the rings. Shared by the TUI (goals.js)
// and mobile (mobile/model/vitals.js); each side colours `tone` its own way.

const GOAL_NAMES = { use: "capacity", red: "reliability", sig: "traffic", inc: "readiness" };

// crit/warn/other are open issues by severity, degraded the workloads not
// ready, repeat the repeat rate in percent, fills the four goal rings (0..1,
// null when unknown), weighted this week's issue count with criticals
// weighted, incGoal its weekly goal.
//
//   critical open, issues over the week's goal → Critical
//   critical open, every goal met              → Issue open, within goal
//   critical open, another goal missed         → Warning, naming the goal
//   none critical, a goal missed               → Warning, naming the goal
//   otherwise                                  → Warning / Watch / All clear as before
//
// An open critical issue is what the readiness goal budgets for, so on its
// own it never reads Critical: a tenant at 3 of 4 goals with its week within
// budget is not an emergency. Over budget it is. With no goal known yet a
// critical issue reads Critical.
export function statusBand({ crit = 0, warn = 0, other = 0, degraded = 0, repeat = 0, fills = {}, weighted = null, incGoal = null }) {
  const known = Object.entries(fills).filter(([, f]) => f != null);
  const missed = known.filter(([, f]) => f < 0.999).sort((a, b) => a[1] - b[1]).map(([k]) => GOAL_NAMES[k] || k);
  const allMet = known.length > 0 && !missed.length;
  if (crit > 0 && allMet) {
    const week = weighted != null && incGoal != null ? ` · ${weighted} of ${incGoal} this week` : "";
    return { band: "Issue open", tone: "warn", meaning: `${crit} critical open, within goal${week}` };
  }
  if (crit > 0 && !known.length) {
    return { band: "Critical", tone: "crit", meaning: "a critical issue is open — someone is needed now" };
  }
  if (crit > 0 && fills.inc != null && fills.inc < 0.999) {
    const week = weighted != null && incGoal != null ? ` (${weighted} of ${incGoal})` : "";
    return { band: "Critical", tone: "crit", meaning: `${crit} critical open and this week is over the readiness goal${week} — someone is needed now` };
  }
  if (missed.length) {
    const open = crit > 0 ? ` · ${crit} critical open` : warn + other > 0 ? "" : " · no issue open";
    return { band: "Warning", tone: "warn", meaning: `${missed[0]} is below goal${open}` };
  }
  if (warn > 0 || degraded > 0) return { band: "Warning", tone: "warn", meaning: "something is open or a workload is down" };
  if ((repeat || 0) >= 20 || other > 0) return { band: "Watch", tone: "watch", meaning: "nothing critical is open, but it keeps coming back" };
  return { band: "All clear", tone: "ok", meaning: "nothing open, nothing degraded, nothing repeating" };
}
