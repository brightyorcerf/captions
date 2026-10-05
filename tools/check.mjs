// Rule checks on composed jobs, the same for every video (nothing here knows about the reference):
//   behind   every callout is partly hidden by the speaker in every sampled frame, never mostly hidden
//   fallback callouts that could not go behind the speaker are listed (they render in the line instead)
//   frame    every caption line and callout stays inside the frame and callouts clear the caption line
//   sync     at each word's start timestamp, that word (and only that word) is highlighted
//   keywords every sentence of 3+ words has a word in the keyword font
// usage: node tools/check.mjs jobs/<id> [jobs/<id> ...]    exit code 1 if any rule fails
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import http from 'node:http';
import { extname, join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const HF = resolve(import.meta.dirname, '../node_modules/hyperframes/bin/hyperframes.mjs');
const chrome = process.env.CHROME ?? execFileSync(process.execPath, [HF, 'browser', 'path']).toString().trim().split('\n').at(-1);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm' };

let failed = 0;
const browser = await puppeteer.launch({ executablePath: chrome });
for (const dir of process.argv.slice(2).map(d => resolve(d))) {
  // served over http, not file://, so fonts load exactly as in the renderer
  const server = http.createServer((req, res) => {
    const f = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!f.startsWith(dir) || !existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' });
    createReadStream(f).pipe(res);
  }).listen(0);
  const page = await browser.newPage();
  const [W, H] = (await import('node:fs')).readFileSync(join(dir, 'index.html'), 'utf8')
    .match(/data-width="(\d+)" data-height="(\d+)"/).slice(1).map(Number);
  await page.setViewport({ width: W, height: H });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForFunction(() => window.__calloutsPlaced || !document.querySelector('.callout'), { timeout: 30000 }).catch(() => {});

  const r = await page.evaluate(() => {
    const { words, phrases, style } = JSON.parse(document.getElementById('captions-data').textContent);
    const lit = (() => { const e = document.body.appendChild(document.createElement('i')); e.style.color = style.colors.active; const c = getComputedStyle(e).color; e.remove(); return c; })();
    const tl = window.__timelines.main, W = innerWidth, H = innerHeight;
    const out = { callouts: window.__calloutReport ?? [], fallbacks: [], frame: [], sync: { ok: 0, bad: [] }, keywords: { sentences: 0, with: 0, missing: [] } };
    for (const p of phrases) if (p.callout?.fallback) out.fallbacks.push(`${words[p.callout.idx].text}: ${p.callout.fallback}`);

    const visible = () => [...document.querySelectorAll('.phrase, .callout')].filter(e => getComputedStyle(e).visibility === 'visible');
    const active = () => [...document.querySelectorAll('.word')].filter(s => s.closest('.phrase, .callout') && getComputedStyle(s.closest('.phrase, .callout')).visibility === 'visible'
      && getComputedStyle(s).color === lit);
    phrases.forEach(p => {
      tl.seek((p.start + p.end) / 2);
      const els = visible(), boxes = els.map(e => [e.className, e.firstElementChild ? [...e.children].reduce((b, s) => {
        // the text itself, not its highlight padding
        const q = s.getBoundingClientRect(), cs = getComputedStyle(s), px = parseFloat(cs.paddingLeft), py = parseFloat(cs.paddingTop);
        return [Math.min(b[0], q.left + px), Math.min(b[1], q.top + py), Math.max(b[2], q.right - px), Math.max(b[3], q.bottom - py)];
      }, [W, H, 0, 0]) : null]);
      for (const [cls, b] of boxes) if (b && (b[0] < -1 || b[1] < -1 || b[2] > W + 1 || b[3] > H + 1))
        out.frame.push(`${cls} "${p.wordIdx.map(i => words[i].text).join(' ')}" leaves the frame`);
      const line = boxes.find(([c]) => c === 'phrase')?.[1], call = boxes.find(([c]) => c === 'callout')?.[1];
      if (line && call && call[3] > line[1]) out.frame.push(`callout over the caption line at ${p.start.toFixed(1)}s`);
      p.wordIdx.forEach(i => {
        tl.seek(words[i].start + 0.017);
        // a big word may stay lit a little past the next word's start (callout.minActive)
        const a = active().filter(s => !s.closest('.callout') || s.textContent === words[i].text).map(s => s.textContent);
        if (a.length === 1 && a[0] === words[i].text) out.sync.ok++; else out.sync.bad.push(`${words[i].start.toFixed(2)}s "${words[i].text}" → [${a.join(', ')}]`);
      });
    });

    // sentences: . ? ! or a pause over 0.7 s; callouts are not in the line, so they don't count
    let s = [];
    const close = () => {
      if (s.length >= 3) { out.keywords.sentences++; if (s.some(i => words[i].role === 'emphasis')) out.keywords.with++; else out.keywords.missing.push(s.map(i => words[i].text).join(' ')); }
      s = [];
    };
    words.forEach((w, i) => {
      if (s.length && w.start - words[s.at(-1)].end > 0.7) close();
      if (w.role !== 'callout') s.push(i);
      if (/[.!?…]["')\]]*$/.test(w.text)) close();
    });
    close();
    return out;
  });
  await page.close();
  server.close();

  const fails = [];
  const pct = v => `${Math.round(v * 100)}%`;
  console.log(`\n${dir.split(/[\\/]/).at(-1)}  (${W}×${H})`);
  for (const c of r.callouts) {
    console.log(`  behind   ${c.ok ? '✓' : '✗'} ${c.word.padEnd(14)} ${c.side.padEnd(5)} ${c.narrow ? 'narrow' : 'wide  '}  hidden ${pct(c.hidden.min)}–${pct(c.hidden.max)} (median ${pct(c.hidden.median)})  head covers ${pct(c.depth.median)} of the letters`);
    if (!c.ok) fails.push(`callout ${c.word}`);
  }
  for (const f of r.fallbacks) console.log(`  fallback ⚠ ${f}`);
  console.log(`  frame    ${r.frame.length ? '✗' : '✓'} ${r.frame.length ? r.frame.join('; ') : 'all text inside the frame, callouts clear of the line'}`);
  console.log(`  sync     ${r.sync.bad.length ? '✗' : '✓'} ${r.sync.ok}/${r.sync.ok + r.sync.bad.length} words highlighted at their timestamp${r.sync.bad.length ? `: ${r.sync.bad.slice(0, 3).join('; ')}` : ''}`);
  console.log(`  keywords ${r.keywords.missing.length ? '✗' : '✓'} ${r.keywords.with}/${r.keywords.sentences} sentences have a keyword${r.keywords.missing.length ? `; missing: ${r.keywords.missing.slice(0, 2).join(' | ')}` : ''}`);
  if (r.frame.length) fails.push('frame');
  if (r.sync.bad.length) fails.push('sync');
  if (r.keywords.missing.length) fails.push('keywords');
  if (fails.length) failed++;
}
await browser.close();
process.exit(failed ? 1 : 0);
