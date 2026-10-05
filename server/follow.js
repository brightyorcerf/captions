// The 9:16 crop moved the way a camera operator would: still while the speaker stays near the middle,
// a capped-speed pan once they drift out, a jump on a camera cut. Pure functions: positions in, keyframes out.

export const FOLLOW = {
  zone: 0.12, // dead zone: the head may sit this far (in crop widths) from the crop's centre before it pans
  speed: 0.35, // fastest pan, in crop widths per second...
  edge: 0.3, // ...unless the head is this far (in crop widths) off centre, close to leaving the crop,
  catchUp: 1.2, // when it pans this fast to catch up (a quick zoom or reframe by the camera operator)
  jump: 0.15, // a head this far (in source widths) from the tracked one, without a cut, is someone else...
  reacquire: 2, // ...unless it stays there this many samples in a row (1 s at 2 samples a second)
};

const median = v => [...v].sort((a, b) => a - b)[v.length >> 1];
const cutBetween = (cuts, a, b) => cuts.find(c => c > a && c <= b);

/** Head centres split where neighbours (sorted) are more than `gap` apart: one group per place a head was seen. */
function groupsOf(centres, gap) {
  const seen = centres.filter(c => c != null).sort((a, b) => a - b);
  if (!seen.length) return [];
  const groups = [[seen[0]]];
  for (const c of seen.slice(1)) (c - groups.at(-1).at(-1) > gap ? groups.push([c]) : groups.at(-1).push(c));
  return groups.sort((a, b) => b.length - a.length);
}

/**
 * Which head to follow at each sample. The highest head can flip between two people, and that looks
 * different from a camera move: two people leave two separate groups of positions and the head goes
 * back and forth between them; a move goes one way (or leaves a trail of positions in between). So per
 * shot (between cuts): when a second group holds a fifth of the samples or more and the head returns
 * to a group it left, the track stays on the main person; otherwise a head that stays somewhere new is
 * followed (a quick reframe by the camera). Samples without a head keep the last position.
 * @param {{t:number, centre:number|null}[]} samples  head centre as a fraction of the source width
 * @returns {number[]} one centre per sample
 */
export function track(samples, cuts = [], o = FOLLOW) {
  const all = groupsOf(samples.map(s => s.centre), o.jump);
  if (!all.length) return samples.map(() => 0.5);
  // shots: the person to stay on, when a shot has two
  const shotOf = i => cuts.filter(c => c <= samples[i].t).length;
  const lock = new Map();
  for (let k = 0; k <= cuts.length; k++) {
    const own = samples.filter((_, i) => shotOf(i) === k).map(s => s.centre).filter(c => c != null);
    const g = groupsOf(own, o.jump);
    if (g.length < 2 || g[1].length < 0.2 * own.length) continue;
    // the group each sample belongs to, in time order, collapsed into runs: A B A is two people, A B a move
    const runs = own.map(c => g.findIndex(x => x.includes(c))).filter((v, i, a) => i === 0 || v !== a[i - 1]);
    if (runs.some((v, i) => runs.indexOf(v) < i - 1)) lock.set(k, median(g[0]));
  }
  let cur = lock.get(0) ?? median(all[0]);
  let far = 0;
  const out = samples.map((s, i) => {
    const main = lock.get(shotOf(i));
    if (s.centre == null || (main !== undefined && Math.abs(s.centre - main) > o.jump)) return cur;
    const cut = i > 0 && cutBetween(cuts, samples[i - 1].t, s.t) !== undefined;
    if (cut || main !== undefined || Math.abs(s.centre - cur) <= o.jump || ++far >= o.reacquire) { cur = s.centre; far = 0; }
    return cur;
  });
  // one-sample outliers (a hand raised above the head) are smoothed out, never across a cut
  return out.map((c, i) => {
    if (i === 0 || i === out.length - 1) return c;
    if (cutBetween(cuts, samples[i - 1].t, samples[i + 1].t) !== undefined) return c;
    return median([out[i - 1], c, out[i + 1]]);
  });
}

/**
 * Crop centre over time, as keyframes linear in between.
 * @param {number[]} times  sample times
 * @param {number[]} centres  tracked head centre per sample (fraction of the source width)
 * @param {number} crop  crop width as a fraction of the source width
 * @returns {{t:number, c:number}[]}
 */
export function follow(times, centres, cuts = [], crop, o = FOLLOW) {
  const lo = crop / 2, hi = 1 - crop / 2, clamp = c => Math.min(hi, Math.max(lo, c));
  let p = clamp(centres[0]);
  const keys = [{ t: times[0], c: p }];
  for (let i = 1; i < times.length; i++) {
    const cut = cutBetween(cuts, times[i - 1], times[i]);
    if (cut !== undefined) {
      if (cut - 0.001 > times[i - 1]) keys.push({ t: cut - 0.001, c: p });
      p = clamp(centres[i]);
      keys.push({ t: cut, c: p });
    }
    const off = centres[i] - p, zone = o.zone * crop;
    if (Math.abs(off) > zone) {
      // bring the head back inside the dead zone, halfway to the centre, no faster than the pan limit
      const target = clamp(centres[i] - Math.sign(off) * zone * 0.5);
      const speed = Math.abs(off) > o.edge * crop ? o.catchUp : o.speed;
      const step = speed * crop * (times[i] - (cut ?? times[i - 1]));
      p = clamp(p + Math.max(-step, Math.min(step, target - p)));
    }
    keys.push({ t: times[i], c: p });
  }
  // drop keyframes a straight line through their neighbours already gives (holds and steady pans)
  const out = [keys[0]];
  for (let i = 1; i < keys.length - 1; i++) {
    const a = out.at(-1), b = keys[i], n = keys[i + 1];
    const lerp = a.c + ((n.c - a.c) * (b.t - a.t)) / (n.t - a.t);
    if (Math.abs(lerp - b.c) > 1e-3) out.push(b);
  }
  if (keys.length > 1) out.push(keys.at(-1));
  return out;
}

/**
 * The keyframes as an ffmpeg expression of t for the crop filter's x (pixels, left edge), searched as a
 * balanced tree so long videos with many moves stay shallow.
 */
export function cropX(keys, W, cw) {
  const x = c => Math.round(Math.min(W - cw, Math.max(0, c * W - cw / 2)));
  const f = v => +v.toFixed(3);
  if (keys.length === 1) return `${x(keys[0].c)}`;
  const seg = i => {
    const a = keys[i], b = keys[i + 1], xa = x(a.c), xb = x(b.c);
    return xa === xb ? `${xa}` : `${xa}+${xb - xa}*(t-${f(a.t)})/${f(b.t - a.t)}`;
  };
  const tree = (lo, hi) => (hi - lo === 1 ? seg(lo) : (m => `if(lt(t,${f(keys[m].t)}),${tree(lo, m)},${tree(m, hi)})`)((lo + hi) >> 1));
  return `if(lt(t,${f(keys[0].t)}),${x(keys[0].c)},if(gte(t,${f(keys.at(-1).t)}),${x(keys.at(-1).c)},${tree(0, keys.length - 1)}))`;
}
