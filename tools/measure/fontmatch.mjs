// usage: node tools/measure/fontmatch.mjs <chrome-path> <json cases>  (see docs/eclipse-spec.md)
// Scores candidate fonts against text cropped from the reference: binarise both, normalise each to
// its bounding box, resample to one grid, report IoU. Higher = closer glyph shapes and proportions.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [chrome, ...rest] = process.argv.slice(2);
const cases = JSON.parse(rest.join(' '));
// candidate fonts: npm install --no-save @fontsource/<family> for anything beyond the repo's own fonts
const fs = p => join(import.meta.dirname, '../../node_modules/@fontsource', p);
const face = (pkg, w) => readFileSync(fs(`${pkg}/latin-${w}.css`), 'utf8')
  .replace(/,\s*url\(\.\/files\/[^)]+\.woff\) format\('woff'\)/g, '')
  .replace(/url\(\.\/files\/([^)]+\.woff2)\)/g, (_, f) => `url(data:font/woff2;base64,${readFileSync(fs(`${pkg}/files/${f}`)).toString('base64')})`);

const browser = await puppeteer.launch({ executablePath: chrome, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
for (const c of cases) {
  const css = c.fonts.map(([pkg, w]) => face(pkg, w)).join('\n');
  await page.goto('about:blank');
  await page.setContent(`<style>${css}</style>` + c.fonts.map(([pkg, w, fam]) => `<span style="font-family:'${fam}';font-weight:${w}">${c.text}</span>`).join(''));
  const loaded = await page.evaluate(async fonts => {
    await Promise.all(fonts.map(([, w, fam]) => document.fonts.load(`${w} 50px "${fam}"`)));
    return fonts.map(([, w, fam]) => document.fonts.check(`${w} 50px "${fam}"`));
  }, c.fonts);
  if (loaded.includes(false)) console.log('NOT LOADED:', c.fonts.filter((_, i) => !loaded[i]).map(f => f.join(' ')));
  const ref = 'data:image/png;base64,' + readFileSync(c.ref).toString('base64');
  const res = await page.evaluate(async ({ c, ref }) => {
    const G = [480, Math.round(480 / c.aspect)];
    const img = new Image(); img.src = ref; await img.decode();
    const mask = (cv, test) => {
      const { width: W, height: H } = cv, d = cv.getContext('2d').getImageData(0, 0, W, H).data;
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      const m = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (test(d[i], d[i + 1], d[i + 2])) { m[y * W + x] = 1; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      // resample bbox to grid
      const o = document.createElement('canvas'); o.width = G[0]; o.height = G[1];
      const t = document.createElement('canvas'); t.width = W; t.height = H;
      const id = t.getContext('2d').createImageData(W, H);
      m.forEach((v, k) => { id.data[k * 4 + 3] = v * 255; });
      t.getContext('2d').putImageData(id, 0, 0);
      o.getContext('2d').drawImage(t, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, G[0], G[1]);
      const od = o.getContext('2d').getImageData(0, 0, ...G).data;
      return { grid: Array.from({ length: G[0] * G[1] }, (_, k) => od[k * 4 + 3] > 127), w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };
    const rc = document.createElement('canvas'); rc.width = img.width; rc.height = img.height;
    rc.getContext('2d').drawImage(img, 0, 0);
    const test = c.color === 'yellow' ? (r, g, b) => r > 200 && g > 180 && b < 110 : (r, g, b) => Math.min(r, g, b) > 228;
    const R = mask(rc, test);
    const out = [];
    for (const [fam, w] of c.fonts.map(([, w, fam]) => [fam, w])) {
      const cv = document.createElement('canvas'); cv.width = 2400; cv.height = 400;
      const x = cv.getContext('2d');
      x.fillStyle = '#000'; x.fillRect(0, 0, 2400, 400);
      x.fillStyle = '#fff'; x.font = `${w} 200px "${fam}"`; x.textBaseline = 'middle';
      if (c.spacing) x.wordSpacing = c.spacing;
      x.fillText(c.text, 20, 200);
      const M = mask(cv, r => r > 127);
      let inter = 0, uni = 0;
      for (let k = 0; k < R.grid.length; k++) { inter += R.grid[k] && M.grid[k]; uni += R.grid[k] || M.grid[k]; }
      out.push({ font: `${fam} ${w}`, iou: +(inter / uni).toFixed(3), aspect: +(M.w / M.h).toFixed(2), refAspect: +(R.w / R.h).toFixed(2) });
    }
    return { refBox: [R.w, R.h], out: out.sort((a, b) => b.iou - a.iou) };
  }, { c, ref });
  console.log(`\n== "${c.text}"  ref bbox ${res.refBox.join('x')}`);
  for (const r of res.out) console.log(`${r.iou.toFixed(3)}  ${r.font.padEnd(28)} aspect ${r.aspect} (ref ${r.refAspect})`);
}
await browser.close();
