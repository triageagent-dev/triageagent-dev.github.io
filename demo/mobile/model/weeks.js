/** Contiguous ISO-week calendar (ui/lib/vitals/trends-model.ts). */

export function isoWeek(d) {
  // The ISO week is the one holding this week's Thursday.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1)
  return { y: t.getUTCFullYear(), w: Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7) }
}

export const weeksIn = (y) => isoWeek(new Date(Date.UTC(y, 11, 28))).w

/** Thursday of an ISO week — the day that decides its month and quarter. */
export function thursdayOf(y, w) {
  const jan4 = new Date(Date.UTC(y, 0, 4))
  const mon = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000
  return new Date(mon + ((w - 1) * 7 + 3) * 86400000)
}

/** The last `n` ISO weeks ending in the current one, oldest first. */
export function weekWindow(now, n) {
  let { y, w } = isoWeek(new Date(now))
  const out = []
  for (let i = 0; i < n; i++) {
    out.unshift({ key: `${y}-W${String(w).padStart(2, "0")}`, label: "W" + w, thu: thursdayOf(y, w) })
    w -= 1
    if (w < 1) { y -= 1; w = weeksIn(y) }
  }
  return out
}

/** Normalises "2026-W16", "2026W16", "2026-16" to "2026-W16". */
export function normWeekKey(k) {
  const m = String(k).match(/(\d{4})-?W?(\d{1,2})/)
  return m ? `${m[1]}-W${m[2].padStart(2, "0")}` : null
}
