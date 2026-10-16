// The corona: the ring of 5-minute signal ticks around the goal rings.
// Shared by the TUI (goals.js) and mobile (mobile/model/vitals.js);
// each side draws the ticks this returns in its own markup and colours.

// Width of one history bucket in seconds (the core's signals-history grid).
export const BUCKET = 300;

// The corona is a 12 h clock face: one tick per 5 min bucket, 144 in all.
export const CORONA_SPAN = 144;

// What says an agent was reporting in a bucket: its report count, or (a core
// that does not send one yet) the requests it measured.
const HEARTBEAT = ["reports", "requests"];

// Sparse histories (all-zero buckets are dropped on the wire) summed onto the
// 300 s grid: `span` buckets ending at the current one, or at the newest
// bucket when that is later. `keys` are the signal fields to sum; the
// heartbeat fields are always carried.
export function denseHistory(histories, keys, now, span) {
  const byT = new Map();
  histories.forEach((h) => (h || []).forEach((b) => {
    const cur = byT.get(b.t) || { t: b.t };
    [...keys, ...HEARTBEAT].forEach((k) => { if (b[k]) cur[k] = (cur[k] || 0) + b[k]; });
    byT.set(b.t, cur);
  }));
  if (!byT.size) return [];
  const nowSec = Math.floor(now / 1000);
  let end = nowSec - (nowSec % BUCKET);
  for (const t of byT.keys()) if (t > end) end = t;
  const out = [];
  for (let i = span - 1; i >= 0; i--) { const t = end - i * BUCKET; out.push(byT.get(t) || { t }); }
  return out;
}

// Local wall-clock time on a 12 h dial: 12 at the top (the svg is turned
// -90deg), 3 on the right.
function dial(ms) {
  const d = new Date(ms);
  return ((d.getHours() % 12) * 60 + d.getMinutes() + d.getSeconds() / 60) / 720 * Math.PI * 2;
}

const spoke = (a, r0, r1) => ({
  x1: 100 + Math.cos(a) * r0, y1: 100 + Math.sin(a) * r0,
  x2: 100 + Math.cos(a) * r1, y2: 100 + Math.sin(a) * r1,
});

// One tick per bucket, at the bucket's midpoint on the dial. One scale for
// every signal: a tick's length is its bucket's total over the busiest
// bucket, on a sqrt curve so small counts still show. `sig` is the signal
// with the most events in that bucket (null when quiet); `signals` is a list
// of { k, api }, and its order breaks ties. `segs` splits the tick into one
// stacked piece per signal seen in the bucket, in `signals` order from the
// inside out, each as long as its share of the bucket, so a bucket with
// request errors and k8s events shows both. `alive` says an agent reported in
// the bucket: a quiet bucket that is alive is the all-good state, one that
// is not is a bucket nothing was collected for.
// `reach` is the longest tick beyond its 4 base units; mobile keeps 15 to stay
// inside its 200 viewBox, the TUI passes more.
export function coronaTicks(hist, signals, reach = 15) {
  if (!hist.length) return [];
  const total = (b) => signals.reduce((a, s) => a + (b[s.api] || 0), 0);
  const max = Math.max(1, ...hist.map(total));
  const opOf = (s) => (s.k === "evt" ? 0.55 : 0.9);
  return hist.map((b) => {
    let sig = null, top = 0;
    signals.forEach((s) => { if ((b[s.api] || 0) > top) { top = b[s.api]; sig = s; } });
    const sum = total(b), len = 4 + Math.sqrt(sum / max) * reach;
    const a = dial((b.t + BUCKET / 2) * 1000);
    const alive = HEARTBEAT.some((k) => b[k] > 0);
    const segs = [];
    let r = 81;
    signals.forEach((s) => {
      const n = b[s.api] || 0;
      if (!n) return;
      const l = len * n / sum;
      segs.push({ ...spoke(a, r, r + l), sig: s, op: opOf(s) });
      r += l;
    });
    return { ...spoke(a, 81, 81 + len), sig, alive, segs, op: sig ? opOf(sig) : alive ? 0.6 : 0.35 };
  });
}

// The "now" hand across the corona.
export function coronaHand(now, end = 99) {
  return spoke(dial(now), 79, end);
}
