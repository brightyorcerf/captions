import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropX, follow, track } from './follow.js';

const CROP = 0.316; // a 9:16 crop of a 16:9 frame
const at = (keys, t) => {
  if (t <= keys[0].t) return keys[0].c;
  for (let i = 1; i < keys.length; i++) if (t <= keys[i].t) {
    const a = keys[i - 1], b = keys[i];
    return a.c + ((b.c - a.c) * (t - a.t)) / (b.t - a.t);
  }
  return keys.at(-1).c;
};
const times = n => Array.from({ length: n }, (_, i) => i * 0.5);

test('a speaker who stays near the middle gets one still crop', () => {
  const t = times(40), c = t.map((_, i) => 0.5 + 0.02 * Math.sin(i));
  const keys = follow(t, c, [], CROP);
  assert.equal(new Set(keys.map(k => k.c)).size, 1);
});

test('a slow pan is followed smoothly and the head ends back inside the dead zone', () => {
  // the reference failure: the camera pans and the speaker drifts from 50% to 39% of the width in 3 s
  const t = times(30), c = t.map(s => (s < 2 ? 0.5 : s < 5 ? 0.5 - (0.11 * (s - 2)) / 3 : 0.39));
  const keys = follow(t, c, [], CROP);
  for (let s = 0; s < 14; s += 0.1) {
    const v = Math.abs(at(keys, s + 0.1) - at(keys, s)) / 0.1;
    assert.ok(v <= 0.35 * CROP + 1e-9, `pan speed ${v} at ${s}s`);
  }
  assert.ok(Math.abs(0.39 - at(keys, 14)) <= 0.12 * CROP, 'head back within the dead zone');
});

test('a fast move by the camera is caught up within about a second', () => {
  // the reference's second failure: the head goes from 50% to 32% of the width between two samples
  const t = times(30), c = t.map(s => (s < 10 ? 0.5 : 0.32));
  const keys = follow(t, track(t.map((s, i) => ({ t: s, centre: c[i] }))), [], CROP);
  const off = s => Math.abs(0.32 - at(keys, s)) / CROP; // head's distance from the crop centre, in crop widths
  assert.ok(off(11.5) <= 0.3, `head ${off(11.5).toFixed(2)} crop widths off centre at 11.5 s`);
  assert.ok(off(13) <= 0.12, 'and back inside the dead zone');
});

test('two people taking turns: the crop stays on the main one', () => {
  // the Nippard interview: the highest head alternates between the two in runs of a few seconds
  const s = times(80).map((t, i) => ({ t, centre: Math.floor(i / 6) % 3 === 2 ? 0.75 : 0.3 }));
  const c = track(s);
  assert.ok(c.every(x => Math.abs(x - 0.3) < 0.01), `left the main person: ${[...new Set(c)]}`);
});

test('a camera cut jumps instead of panning', () => {
  const t = times(20), c = t.map(s => (s < 5.2 ? 0.3 : 0.7));
  const keys = follow(t, c, [5.2], CROP);
  assert.ok(Math.abs(at(keys, 5.19) - 0.3) < 0.01 && Math.abs(at(keys, 5.21) - 0.7) < 0.01);
});

test('the track stays on the main speaker when the highest head flips to someone else', () => {
  const s = times(12).map((t, i) => ({ t, centre: i === 4 || i === 7 ? 0.8 : 0.4 }));
  assert.deepEqual(track(s), s.map(() => 0.4));
  // ...but follows them for good once they stay there
  const moved = times(12).map((t, i) => ({ t, centre: i < 6 ? 0.4 : 0.8 }));
  assert.equal(track(moved).at(-1), 0.8);
  // and switches at once on a camera cut
  assert.equal(track(moved, [2.9])[6], 0.8);
});

test('the crop expression is valid ffmpeg arithmetic that matches the keyframes', () => {
  const keys = follow(times(30), times(30).map(s => (s < 3 ? 0.5 : 0.35)), [], CROP);
  const W = 1280, cw = 404, expr = cropX(keys, W, cw);
  const js = expr.replace(/if\(/g, 'iff(').replace(/lt\(/g, 'lt_(').replace(/gte\(/g, 'gte_(');
  const fn = new Function('t', 'iff', 'lt_', 'gte_', `return ${js};`);
  for (let s = 0; s < 15; s += 0.25) {
    const x = fn(s, (c, a, b) => (c ? a : b), (a, b) => +(a < b), (a, b) => +(a >= b));
    const want = Math.min(W - cw, Math.max(0, at(keys, s) * W - cw / 2));
    assert.ok(Math.abs(x - want) <= 1.5, `x ${x} vs ${want} at ${s}s`);
  }
});
