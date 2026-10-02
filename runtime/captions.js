// Runs inside the composition page. Builds one paused, seekable GSAP timeline whose
// every position comes from the transcript timestamps embedded in #captions-data.
const { words, phrases, style, duration } = JSON.parse(document.getElementById('captions-data').textContent);
const { motion: m, colors: c, glow } = style;
const layer = document.getElementById('captions');
const tl = gsap.timeline({ paused: true });

for (const p of phrases) {
  const el = layer.appendChild(document.createElement('div'));
  el.className = 'phrase';
  const spans = p.wordIdx.map(i => {
    const s = el.appendChild(document.createElement('span'));
    s.className = 'word';
    s.textContent = words[i].text;
    el.append(' ');
    return s;
  });
  gsap.set(el, { yPercent: -50 });
  gsap.set(spans, { marginLeft: '0em', marginRight: '0em', opacity: m.dimOpacity, color: c.text, textShadow: glow.off });

  // phrase enters
  tl.fromTo(el, { autoAlpha: 0, scale: 0.92, yPercent: -40 },
    { autoAlpha: 1, scale: 1, yPercent: -50, duration: m.in, ease: 'back.out(2)', immediateRender: false }, p.start);

  // the pop: current word scales up and glows, previous word settles back and dims
  // margins grow with the scale so the popped word pushes its neighbours aside instead of overlapping them
  spans.forEach((s, k) => {
    const room = `${(s.textContent.length * style.charWidth * (m.activeScale - 1)) / 2}em`;
    tl.to(s, { scale: m.activeScale, marginLeft: room, marginRight: room, opacity: 1, color: c.active, textShadow: glow.on, duration: m.pop, ease: 'back.out(3)' },
      words[p.wordIdx[k]].start);
    if (k + 1 < spans.length) {
      tl.to(s, { scale: 1, marginLeft: '0em', marginRight: '0em', opacity: m.dimOpacity, color: c.text, textShadow: glow.off, duration: m.pop, ease: 'power2.out' },
        words[p.wordIdx[k + 1]].start);
    }
  });

  // phrase clears before the next one begins
  tl.to(el, { autoAlpha: 0, duration: m.out, ease: 'power1.in' }, Math.max(p.start + m.in, p.end - m.out));
}
tl.set({}, {}, duration); // timeline spans the whole video

window.__timelines = window.__timelines || {};
window.__timelines.main = tl;
tl.seek(0);

// Browser preview (?preview): drive the same timeline from the video's clock.
// The renderer never sets this flag; it seeks frame by frame instead.
if (new URLSearchParams(location.search).has('preview')) {
  const v = document.getElementById('source');
  v.controls = true;
  (function sync() { tl.seek(v.currentTime); requestAnimationFrame(sync); })();
}
