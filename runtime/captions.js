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

function wordEl(parent, i) {
  const s = parent.appendChild(document.createElement('span'));
  s.className = `word${words[i].role === 'emphasis' ? ' emphasis' : ''}`;
  s.textContent = words[i].text;
  parent.append(' ');
  return s;
}

phrases.forEach((p, n) => {
  const calloutIdx = p.callout?.idx;
  const spans = new Map(); // word index -> element
  const blocks = [];

  const line = p.wordIdx.filter(i => i !== calloutIdx);
  if (line.length) {
    const el = layer.appendChild(document.createElement('div'));
    el.className = 'phrase';
    for (const i of line) spans.set(i, wordEl(el, i));
    gsap.set(el, { yPercent: -50 });
    blocks.push([el, p.end]);
  }

  if (calloutIdx !== undefined) {
    const el = calloutLayer.appendChild(document.createElement('div'));
    el.className = 'callout';
    spans.set(calloutIdx, wordEl(el, calloutIdx));
    // sit it on the speaker's head so the head eclipses its lower part
    const chars = words[calloutIdx].text.length;
    // fit the word to the frame width, capped by the short edge so landscape doesn't get giant words
    const fit = (co.width * 100) / (chars * co.charWidth);
    const head = mattes.find(x => x.phrase === n)?.headTop;
    el.style.fontSize = `min(${fit}vw, ${co.maxSize * 100}vmin)`;
    el.style.top = head == null ? `${co.fallbackY * 100}%` : `calc(${head * 100}% + ${co.headOverlap}em)`;
    gsap.set(el, { yPercent: -100 });
    blocks.push([el, p.callout.end]);
  }

  gsap.set([...spans.values()], off);

  for (const [el, end] of blocks) {
    const y = gsap.getProperty(el, 'yPercent');
    tl.fromTo(el, { autoAlpha: 0, scale: 0.94, yPercent: y + 10 },
      { autoAlpha: 1, scale: 1, yPercent: y, duration: m.in, ease: 'back.out(2)', immediateRender: false }, p.start);
    tl.to(el, { autoAlpha: 0, duration: m.out, ease: 'power1.in' }, Math.max(p.start + m.in, end - m.out));
  }

  // the pop: current word lights up, previous word settles back. transforms/colour only
  // (no layout properties) so seek-by-frame capture never stutters; word padding absorbs the scale.
  p.wordIdx.forEach((i, k) => {
    const s = spans.get(i);
    tl.to(s, { ...on, duration: m.pop, ease: 'back.out(3)' }, words[i].start);
    // settle when the next word starts; a callout outlives its phrase, so it settles on the next word overall
    const next = k + 1 < p.wordIdx.length ? words[p.wordIdx[k + 1]] : i === calloutIdx ? words[i + 1] : null;
    if (next) tl.to(s, { ...off, duration: m.pop, ease: 'power2.out' }, next.start);
  });
});
tl.set({}, {}, duration); // timeline spans the whole video

window.__timelines = window.__timelines || {};
window.__timelines.main = tl;
tl.seek(0);
