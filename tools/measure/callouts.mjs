// usage: node tools/measure/callouts.mjs reference/eclipse.mp4
// Scans every frame of the top 45% for big white / yellow text and reports each callout's
// lifetime, ink bbox (at full res), colour per frame. Background whites are removed by
// subtracting the per-pixel median over the whole video.
import { spawn } from 'node:child_process';

const REF = process.argv[2];
const W = 270, H = 216, FPS = 30; // quarter res, top 864px of 1920
const ff = spawn('ffmpeg', ['-v', 'error', '-i', REF, '-vf', `crop=1080:864:0:0,scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
const frames = []; let pend = Buffer.alloc(0); const FS = W * H * 3;
ff.stdout.on('data', d => { pend = Buffer.concat([pend, d]); while (pend.length >= FS) { frames.push(pend.subarray(0, FS)); pend = pend.subarray(FS); } });
await new Promise(r => ff.on('close', r));

const white = (b, i) => b[i] > 235 && b[i + 1] > 235 && b[i + 2] > 235;
const yellow = (b, i) => b[i] > 215 && b[i + 1] > 195 && b[i + 2] < 90;
// pixels that are white in > 30% of frames are background (lamps, box), not text
const bgCount = new Uint16Array(W * H);
for (const f of frames) for (let k = 0; k < W * H; k++) if (white(f, k * 3)) bgCount[k]++;
const bg = k => bgCount[k] > frames.length * 0.3;

const rows = frames.map((f, n) => {
  let w = 0, y = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let k = 0; k < W * H; k++) {
    if (bg(k)) continue;
    const isW = white(f, k * 3), isY = yellow(f, k * 3);
    if (!isW && !isY) continue;
    isW ? w++ : y++;
    const x = k % W, yy = (k / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
  }
  return { t: n / FPS, w, y, box: [x0 * 4, y0 * 4, x1 * 4 + 3, y1 * 4 + 3] };
});

// group frames with a lot of text ink into callout events
const ink = r => r.w + r.y > 600;
let ev = null; const events = [];
rows.forEach(r => {
  if (ink(r)) { if (!ev) events.push(ev = { start: r.t, rows: [] }); ev.rows.push(r); ev.end = r.t; }
  else if (ev && r.t - ev.end > 0.1) ev = null;
});
for (const e of events) {
  if (e.end - e.start < 0.1) continue;
  const peak = e.rows.reduce((a, b) => (a.w + a.y > b.w + b.y ? a : b));
  const yellowFrames = e.rows.filter(r => r.y > r.w).length;
  const [x0, y0, x1, y1] = peak.box;
  console.log(`${e.start.toFixed(2)}s-${e.end.toFixed(2)}s (${(e.end - e.start + 1 / FPS).toFixed(2)}s)  peak bbox x ${x0}-${x1} (${((x1 - x0) / 1080 * 100).toFixed(0)}% w, centre ${(((x0 + x1) / 2) / 1080 * 100).toFixed(0)}%)  y ${y0}-${y1} (top ${(y0 / 1920 * 100).toFixed(1)}%)  yellow in ${yellowFrames}/${e.rows.length} frames`);
  // first frames: how does it enter? (ink growth = scale/fade)
  console.log('   ink by frame: ' + e.rows.slice(0, 8).map(r => r.w + r.y).join(' ') + ' ... ' + e.rows.slice(-5).map(r => r.w + r.y).join(' '));
}
