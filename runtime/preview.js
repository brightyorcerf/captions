// Browser preview only (?preview): drive the composition's timeline, and the cut-out subject clips,
// from the video's clock. The renderer never sets the flag; it seeks frame by frame and owns clip timing.
if (new URLSearchParams(location.search).has('preview')) {
  const tl = window.__timelines.main;
  const v = document.getElementById('source');
  const subjects = [...document.querySelectorAll('video.subject')];
  v.controls = true;
  (function sync() {
    const t = v.currentTime;
    tl.seek(t);
    for (const s of subjects) {
      const local = t - Number(s.dataset.start);
      const live = local >= 0 && local < Number(s.dataset.duration);
      s.style.visibility = live ? 'visible' : 'hidden';
      if (live && Math.abs(s.currentTime - local) > 0.08) s.currentTime = local;
      if (live && !v.paused && s.paused) s.play().catch(() => {});
      if ((!live || v.paused) && !s.paused) s.pause();
    }
    requestAnimationFrame(sync);
  })();
}
