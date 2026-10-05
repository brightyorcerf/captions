// usage: node tools/measure/pixels.mjs reference/eclipse.mp4  (frame times and crop boxes are for the Eclipse reference reel)
// Pixel statistics from reference frames: text colours, highlight box colour/alpha, shadow, geometry.
import { execFileSync } from 'node:child_process';

const REF = process.argv[2];
const frame = t => {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', `${t}`, '-i', REF, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
  return { px: (x, y) => [buf[(y * 1080 + x) * 3], buf[(y * 1080 + x) * 3 + 1], buf[(y * 1080 + x) * 3 + 2]], buf };
};
const med = a => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
const medRGB = list => [0, 1, 2].map(k => med(list.map(p => p[k])));
const hex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
const region = (f, x0, y0, x1, y1, test) => { const out = []; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = f.px(x, y); if (test(p)) out.push({ x, y, p }); } return out; };
const bbox = pts => pts.reduce((b, { x, y }) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [1e9, 1e9, -1, -1]);

const isWhite = ([r, g, b]) => Math.min(r, g, b) > 228;
const isYellow = ([r, g, b]) => r > 215 && g > 195 && b < 90;

// 1. inactive (white) word colour, and the text's core: pixels well inside strokes
for (const [t, box, name] of [[27.0, [425, 1445, 985, 1555], 'lage hue hain'], [46.0, [140, 1435, 640, 1545], 'Kyunki unki']]) {
  const f = frame(t);
  const w = region(f, ...box, isWhite);
  const core = w.filter(({ x, y }) => [[-3, 0], [3, 0], [0, -3], [0, 3]].every(([dx, dy]) => isWhite(f.px(x + dx, y + dy))));
  console.log(`inactive "${name}" @${t}s: core colour ${hex(medRGB(core.map(c => c.p)))} (n=${core.length}), text bbox ${bbox(w)}`);
  // shadow: luminance just below the glyph bottoms vs 30px lower
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const below = [], far = [];
  for (const { x, y } of w) if (!isWhite(f.px(x, y + 1)) && !isWhite(f.px(x, y + 4))) { below.push(lum(f.px(x, y + 5))); far.push(lum(f.px(x, y + 30 > 1919 ? y : y + 30))); }
  console.log(`  shadow: luminance 5px under glyph edges ${med(below).toFixed(0)} vs 30px away ${med(far).toFixed(0)}`);
  // stroke: is there a dark ring 1-2px around glyphs?
  const ring = w.filter(({ x, y }) => !isWhite(f.px(x + 2, y))).map(({ x, y }) => lum(f.px(x + 2, y)));
  console.log(`  edge ring 2px right of glyphs: median luminance ${med(ring).toFixed(0)} (dark < 60 would mean a stroke)`);
}

// 2. active word: text colour + translucent box
for (const [t, box, name] of [[27.0, [80, 1440, 420, 1560], 'crystals'], [46.0, [640, 1420, 950, 1550], 'WEBSITE'], [3.3, [240, 1430, 640, 1560], 'ASTROTALK']]) {
  const f = frame(t);
  const y = region(f, ...box, isYellow);
  const core = y.filter(({ x, y: yy }) => [[-2, 0], [2, 0], [0, -2], [0, 2]].every(([dx, dy]) => isYellow(f.px(x + dx, yy + dy))));
  const tb = bbox(y);
  console.log(`active "${name}" @${t}s: text ${hex(medRGB(core.map(c => c.p)))}, text bbox ${tb} (${tb[2] - tb[0] + 1}x${tb[3] - tb[1] + 1})`);
  // box edges: scan rows/cols outward from the text bbox for a step in the blue channel (yellow tint lowers blue)
  const b = (x, yy) => f.px(x, yy)[2];
  const midY = (tb[1] + tb[3]) >> 1, midX = (tb[0] + tb[2]) >> 1;
  const edge = (from, step, axis) => { let k = from; for (let i = 0; i < 80; i++, k += step) { const [x, yy] = axis === 'x' ? [k, midY] : [midX, k]; const [x2, y2] = axis === 'x' ? [k + step * 3, midY] : [midX, k + step * 3]; if (b(x2, y2) - b(x, yy) > 25) return k; } return null; };
  const L = edge(tb[0] - 2, -1, 'x'), Rr = edge(tb[2] + 2, 1, 'x'), T = edge(tb[1] - 2, -1, 'y'), B = edge(tb[3] + 2, 1, 'y');
  console.log(`  box ~ x ${L}..${Rr}, y ${T}..${B}  pad L ${tb[0] - L} R ${Rr - tb[2]} T ${tb[1] - T} B ${B - tb[3]} (px)`);
}
