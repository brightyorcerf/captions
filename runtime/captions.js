// Runs inside the composition page. Builds one paused, seekable GSAP timeline whose
// every position comes from the transcript timestamps embedded in #captions-data.
const { words, phrases, style, mattes = [], duration } = JSON.parse(document.getElementById('captions-data').textContent);
const { motion: m, colors: c, glow, highlight: hl, callout: co } = style;
const layer = document.getElementById('captions');
const calloutLayer = document.getElementById('callouts');
const tl = gsap.timeline({ paused: true });

// word states; every style feature (glow, highlight box) is optional
const on = { opacity: 1, color: c.active, scale: m.activeScale };
const off = { opacity: m.dimOpacity, color: c.text, scale: 1 };
if (glow) { on.textShadow = glow.on; off.textShadow = glow.off; }
if (hl) { on.backgroundColor = hl.on; off.backgroundColor = hl.off; }

function wordEl(parent, i, big = false) {
  const s = parent.appendChild(document.createElement('span'));
  // a callout only reaches the line when it could not go behind the speaker: it stays a keyword there
  s.className = `word${!big && (words[i].role === 'emphasis' || words[i].role === 'callout') ? ' emphasis' : ''}`;
  // a big word stands alone: "BEAUTIFULLY." loses its full stop, the caption line keeps its punctuation
  s.textContent = big ? words[i].text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, '') || words[i].text : words[i].text;
  parent.append(' ');
  return s;
}

phrases.forEach((p, n) => {
  const calloutIdx = p.callout && !p.callout.fallback ? p.callout.idx : undefined;
  const spans = new Map(); // word index -> element
  const blocks = [];

  const line = p.wordIdx.filter(i => i !== calloutIdx);
  if (line.length) {
    const el = layer.appendChild(document.createElement('div'));
    el.className = 'phrase';
    for (const i of line) spans.set(i, wordEl(el, i));
    // while a callout is up, the line sits a little higher (measured: 38-80 px on the reference)
    if (calloutIdx !== undefined && co?.lineLift) el.style.top = `-${co.lineLift}em`;
    gsap.set(el, { yPercent: -50 });
    blocks.push([el, p.start, p.end]);
  }

  if (calloutIdx !== undefined) {
    const el = calloutLayer.appendChild(document.createElement('div'));
    el.className = 'callout';
    spans.set(calloutIdx, wordEl(el, calloutIdx, true));
    // provisional size and place; placeCallout() fits it against the speaker's outline once fonts load
    el.style.fontSize = `${co.size * 100}vmin`;
    el.style.top = `${co.fallbackY * 100}%`;
    el.dataset.phrase = n;
    gsap.set(el, { yPercent: -100 });
    // usually the phrase's span; a camera cut can trim either end (see matte() in pipeline.js)
    blocks.push([el, p.callout.start ?? p.start, p.callout.end]);
  }

  gsap.set([...spans.values()], off);

  for (const [el, start, end] of blocks) {
    if (!m.in && !m.out) { // hard cut in and out, like the reference
      tl.set(el, { autoAlpha: 1 }, start);
      tl.set(el, { autoAlpha: 0 }, end);
      continue;
    }
    const y = gsap.getProperty(el, 'yPercent');
    tl.fromTo(el, { autoAlpha: 0, scale: 0.94, yPercent: y + 10 },
      { autoAlpha: 1, scale: 1, yPercent: y, duration: m.in, ease: 'back.out(2)', immediateRender: false }, start);
    tl.to(el, { autoAlpha: 0, duration: m.out, ease: 'power1.in' }, Math.max(start + m.in, end - m.out));
  }

  // the pop: current word lights up, previous word settles back. transforms/colour only
  // (no layout properties) so seek-by-frame capture never stutters; word padding absorbs the scale.
  p.wordIdx.forEach((i, k) => {
    const s = spans.get(i);
    tl.to(s, { ...on, duration: m.pop, ease: 'back.out(3)' }, words[i].start);
    // settle when the next word starts; a callout outlives its phrase, so it settles on the next word overall
    const next = k + 1 < p.wordIdx.length ? words[p.wordIdx[k + 1]] : i === calloutIdx ? words[i + 1] : null;
    // a callout stays lit at least co.minActive, so a fast talker's big word doesn't just flash yellow
    if (next) tl.to(s, { ...off, duration: m.pop, ease: 'power2.out' }, i === calloutIdx ? Math.max(next.start, words[i].start + (co.minActive ?? 0)) : next.start);
  });
});
tl.set({}, {}, duration); // timeline spans the whole video

// Callout placement, measured with the real font once it has loaded (sizes and positions only, never
// timing, so the timeline above is unaffected). Everything is relative to THIS video's speaker outline:
//  - size: fixed fraction of the short edge, shrunk only past co.width; narrow words (a number) 1.22x
//  - x: long words start at the left margin and are shifted only if they would not reach the head;
//    narrow ones go beside the head (left, unless the right has clearly more room) and tuck co.tuck of
//    their width behind its edge
//  - y: wide words: the head covers co.depth of the letters' height, measured against the median outline
//    under the word and kept between co.minDepth and co.maxDepth in every sampled frame;
//    narrow words sit beside the head, their top level with the top of the head (+ co.narrowOffset)
//  - report: the share of the word's area the speaker hides, per frame
// Each callout reports what it achieved in window.__calloutReport (read by tools/check.mjs).
const ctx = document.createElement('canvas').getContext('2d');
function ink(text, px, spacing) {
  ctx.font = `${px}px Anton`;
  ctx.letterSpacing = `${spacing * px}px`;
  const t = ctx.measureText(text.toUpperCase());
  return { left: t.actualBoundingBoxLeft, w: t.actualBoundingBoxLeft + t.actualBoundingBoxRight - spacing * px,
    asc: t.actualBoundingBoxAscent, desc: t.actualBoundingBoxDescent };
}

function placeCallout(el, m) {
  const W = innerWidth, H = innerHeight, span = el.firstChild, text = span.textContent;
  const spacing = parseFloat(getComputedStyle(el).letterSpacing) / parseFloat(getComputedStyle(el).fontSize) || 0;
  let px = co.size * Math.min(W, H), g = ink(text, px, spacing);
  if (g.w > W * co.width) { px *= (W * co.width) / g.w; g = ink(text, px, spacing); }
  const narrow = co.narrow && g.w < W * co.narrow;
  if (narrow) { px *= co.narrowScale; g = ink(text, px, spacing); }
  el.style.fontSize = `${px}px`;

  const [gw, gh] = [m.median.length, 192], cw = W / gw, ch = H / gh;
  const headL = m.head.left * W, headR = m.head.right * W, margin = co.left * W;
  // left of the head (reading order) unless the right side has clearly more room
  const side = W - headR > 1.3 * headL ? 'right' : 'left';
  let x;
  if (narrow) x = side === 'left' ? headL + co.tuck * g.w - g.w : headR - co.tuck * g.w;
  // a long word must still run under the head, wherever the speaker stands
  else x = Math.max(margin, Math.min(W - margin - g.w, headL + co.tuck * g.w - g.w));
  x = Math.max(margin * 0.5, Math.min(W - margin * 0.5 - g.w, x));

  // the outline under the word: its highest point decides how much of the letters is hidden. A spike a
  // few columns wide (a hair tuft, a raised finger) is skipped: on the reference-style interview a tuft
  // decided the depth, and the word sat above the head with only the tuft overlapping it
  const c0 = Math.max(0, Math.floor(x / cw)), c1 = Math.min(gw, Math.ceil((x + g.w) / cw));
  const spike = Math.min(Math.round((co.spike ?? 0) * gw), Math.floor((c1 - c0) * 0.2));
  const under = f => f.slice(c0, c1).sort((a, b) => a - b)[spike] * ch;
  const inkH = g.asc + g.desc;
  const depthAt = (bottom, f) => Math.max(0, Math.min(1, (bottom - under(f)) / inkH));
  let bottom = narrow ? m.head.top * H + (1 + co.narrowOffset) * inkH : under(m.median) + co.depth * inkH;
  // keep the word inside the frame
  bottom = Math.max(bottom, H * co.top + inkH);
  // the speaker moves: if some frames would leave the word uncovered or swallowed, nudge toward the middle
  const depths = () => m.frames.map(f => depthAt(bottom, f)).sort((a, b) => a - b);
  for (let k = 0; k < 20 && !narrow; k++) {
    const d = depths();
    if (d[0] < co.minDepth && d.at(-1) < co.maxDepth) bottom += inkH * 0.03;
    else if (d.at(-1) > co.maxDepth && d[0] > co.minDepth) bottom -= inkH * 0.03;
    else break;
  }

  // position the element so its ink lands at (x, bottom): left edge at the ink's left, baseline from the DOM
  gsap.set(el, { yPercent: 0 });
  Object.assign(el.style, { left: `${x + g.left}px`, right: 'auto', textAlign: 'left', top: '0px' });
  const probe = el.appendChild(document.createElement('i'));
  probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  const baseline = probe.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
  probe.remove();
  el.style.top = `${bottom - g.desc - baseline}px`;

  // how much of the word the speaker hides in each sampled frame (the outline is solid below its top)
  const hidden = f => {
    let a = 0;
    for (let c = c0; c < c1; c++) {
      const span = Math.min(x + g.w, (c + 1) * cw) - Math.max(x, c * cw);
      a += span * Math.max(0, bottom - Math.max(bottom - inkH, f[c] * ch));
    }
    return a / (g.w * inkH);
  };
  const stat = v => (v.sort((a, b) => a - b), { min: v[0], median: v[v.length >> 1], max: v.at(-1) });
  const report = { word: text, side: narrow ? side : 'span', narrow, x: x / W, top: (bottom - inkH) / H, width: g.w / W,
    depth: stat(m.frames.map(f => depthAt(bottom, f))), hidden: stat(m.frames.map(hidden)) };
  // behind the speaker, yet readable: some of the word is hidden in every frame, never most of it
  report.ok = report.hidden.min >= co.minHidden && report.hidden.max <= co.maxHidden;
  window.__calloutReport.push(report);
  el.dataset.hidden = report.hidden.median.toFixed(2);
}

window.__calloutReport = [];
if (co) document.fonts.ready.then(() => {
  for (const el of calloutLayer.children) {
    const m = mattes.find(x => x.phrase === Number(el.dataset.phrase));
    if (m?.head) placeCallout(el, m);
  }
  window.__calloutsPlaced = true;
});

window.__timelines = window.__timelines || {};
window.__timelines.main = tl;
tl.seek(0);
