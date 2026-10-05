// A/B: where does our text land vs the reference, in pixels?
// usage: node tools/measure/abtest.mjs <job-dir> reference/eclipse.mp4 <t1,t2,...>
// Clones the composed job with a black source video and transparent cut-outs, so a snapshot of it
// contains nothing but our captions; then measures text ink boxes in both with the same thresholds.
// Pick timestamps where the reference's caption band is free of other white/yellow objects.
import { execFileSync } from 'node:child_process';
import { cpSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const [jobDir, ref, times] = process.argv.slice(2);
const ts = times.split(',').map(Number);
const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]);
const dur = s => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', s]).toString());

const clean = join(tmpdir(), 'eclipse-ab');
rmSync(clean, { recursive: true, force: true });
cpSync(jobDir, clean, { recursive: true });
ff('-f', 'lavfi', '-i', `color=black:s=1080x1920:r=30:d=${dur(join(jobDir, 'source.mp4'))}`, '-f', 'lavfi', '-i', 'anullsrc', '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', join(clean, 'source.mp4'));
for (const f of readdirSync(clean).filter(f => /^subject-.*\.webm$/.test(f)))
  ff('-f', 'lavfi', '-i', `color=black@0:s=1080x1920:r=30:d=${dur(join(jobDir, f))},format=yuva420p`, '-c:v', 'libvpx-vp9', '-auto-alt-ref', '0', join(clean, f));

const snaps = join(clean, 'snaps');
execFileSync(process.execPath, [resolve(import.meta.dirname, '../../node_modules/hyperframes/bin/hyperframes.mjs'), 'snapshot', clean,
  '--at', ts.join(','), '--no-end', '-o', snaps], { env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' }, stdio: 'ignore' });
const shots = readdirSync(snaps).filter(f => /^frame-.*\.png$/.test(f)).sort();

const rgb = args => execFileSync('ffmpeg', ['-v', 'error', ...args, '-frames:v', '1', '-vf', 'scale=1080:1920', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
const white = (b, i) => b[i] > 228 && b[i + 1] > 228 && b[i + 2] > 228;
const yellow = (b, i) => b[i] > 215 && b[i + 1] > 195 && b[i + 2] < 90;
function box(buf, y0, y1, test) {
  let x0 = 1080, t = 1920, x1 = -1, b = -1, n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < 1080; x++) if (test(buf, (y * 1080 + x) * 3)) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < t) t = y; if (y > b) b = y; }
  return n < 200 ? null : { x0, x1, top: t, bottom: b, w: x1 - x0 + 1, h: b - t + 1 };
}
const fmt = r => r ? `x ${r.x0}-${r.x1} (w ${r.w})  y ${r.top}-${r.bottom} (h ${r.h})` : '—';
const d = (a, b) => a && b ? `Δx0 ${a.x0 - b.x0}  Δw ${a.w - b.w}  Δtop ${a.top - b.top}  Δh ${a.h - b.h}` : '';

ts.forEach((t, k) => {
  const ours = rgb(['-i', join(snaps, shots[k])]), theirs = rgb(['-ss', `${t}`, '-i', ref]);
  console.log(`\n@ ${t}s`);
  for (const [name, y0, y1, test] of [
    ['line  (white+yellow)', 1250, 1750, (b, i) => white(b, i) || yellow(b, i)],
    ['callout (yellow)    ', 0, 1000, yellow],
  ]) {
    const a = box(ours, y0, y1, test), b = box(theirs, y0, y1, test);
    console.log(`  ${name} ours ${fmt(a)}\n  ${' '.repeat(name.length)} ref  ${fmt(b)}\n  ${' '.repeat(name.length)}      ${d(a, b)}`);
  }
});
if (!existsSync(snaps)) console.error('snapshot failed');
