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
    // while a callout is up, the line sits a little higher (measured: 38-80 px on the reference)
    if (calloutIdx !== undefined && co?.lineLift) el.style.top = `-${co.lineLift}em`;
    gsap.set(el, { yPercent: -50 });
    blocks.push([el, p.end]);
  }

  if (calloutIdx !== undefined) {
    const el = calloutLayer.appendChild(document.createElement('div'));
    el.className = 'callout';
    spans.set(calloutIdx, wordEl(el, calloutIdx));
    // fixed size (a fraction of the short edge), shrunk later only if the word is too wide; see fitCallouts
    el.style.fontSize = `${co.size * 100}vmin`;
    if (co.left != null) Object.assign(el.style, { left: `${co.left * 100}%`, right: 'auto', textAlign: 'left' });
    // baseline just below the top of the speaker's head, so the head eclipses the bottom of the letters
    const head = mattes.find(x => x.phrase === n)?.headTop;
    el.style.top = head == null ? `${co.fallbackY * 100}%` : `calc(${head * 100}% + ${co.headOverlap}em)`;
    if (head != null) el.dataset.head = head;
    gsap.set(el, { yPercent: -100 });
    blocks.push([el, p.callout.end]);
  }

  gsap.set([...spans.values()], off);

  for (const [el, end] of blocks) {
    if (!m.in && !m.out) { // hard cut in and out, like the reference
      tl.set(el, { autoAlpha: 1 }, p.start);
      tl.set(el, { autoAlpha: 0 }, end);
      continue;
    }
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

// Measured with the real font once it has loaded (sizes and positions only, never timing, so the
// timeline above is unaffected): shrink callouts wider than co.width of the frame; narrow ones
// (a number, a short word) sit beside the head rather than above it, so they drop lower.
function fitCallouts() {
  for (const el of calloutLayer.children) {
    const span = el.firstChild, pad = parseFloat(getComputedStyle(span).paddingLeft) * 2;
    const w = span.getBoundingClientRect().width - pad, max = innerWidth * co.width;
    if (w > max) el.style.fontSize = `${(co.size * 100 * max) / w}vmin`;
    if (!co.narrow || w >= innerWidth * co.narrow) continue;
    // narrow: bigger, further in, level with the head instead of above it
    el.style.fontSize = `${co.size * co.narrowScale * 100}vmin`;
    el.style.left = `${co.narrowLeft * 100}%`;
    const head = el.dataset.head;
    if (head) el.style.top = `calc(${head * 100}% + ${co.headOverlapNarrow}em)`;
  }
}
if (co) document.fonts.ready.then(fitCallouts);

window.__timelines = window.__timelines || {};
window.__timelines.main = tl;
tl.seek(0);
