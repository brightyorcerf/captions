// Browser preview only (?preview): drive the composition's timeline, and the cut-out subject clips,
// from the video's clock. The renderer never sets the flag; it seeks frame by frame and owns clip timing.
if (new URLSearchParams(location.search).has('preview')) {
  const tl = window.__timelines.main;
  const v = document.getElementById('source');
  const subjects = [...document.querySelectorAll('video.subject')];
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

  // Our own controls: the caption and cut-out layers sit above #source, so its native controls never get a
  // click, and native fullscreen would show the bare video without captions. Fullscreen takes the page's
  // container in the editor (the iframe keeps its aspect ratio there), or this page when opened directly.
  const css = document.head.appendChild(document.createElement('style'));
  css.textContent = `
    #pv { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; display: flex; align-items: center; gap: 8px;
      padding: 18px 10px 8px; font: 12px/1 ui-monospace, monospace; color: #fff;
      background: linear-gradient(transparent, rgba(0,0,0,.65)); transition: opacity .2s; }
    #pv.idle { opacity: 0; }
    #pv button { all: unset; cursor: pointer; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 4px; }
    #pv button:hover, #pv button:focus-visible { background: rgba(255,255,255,.2); }
    #pv svg { width: 18px; height: 18px; fill: #fff; }
    #pv input { flex: 1; min-width: 0; accent-color: #fee300; cursor: pointer; }
    #pv .t { white-space: nowrap; font-variant-numeric: tabular-nums; }
    #tap { position: fixed; inset: 0; z-index: 9; cursor: pointer; }`;
  const icon = d => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const I = {
    play: icon('M8 5v14l11-7z'), pause: icon('M6 5h4v14H6zm8 0h4v14h-4z'),
    sound: icon('M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z'),
    muted: icon('M3 9v6h4l5 5V4L7 9zm18 .4L19.6 8 17 10.6 14.4 8 13 9.4l2.6 2.6-2.6 2.6 1.4 1.4 2.6-2.6 2.6 2.6 1.4-1.4-2.6-2.6z'),
    full: icon('M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z'),
    exit: icon('M8 5h2v5H5V8h3zm6 0h2v3h3v2h-5zM5 14h5v5H8v-3H5zm9 0h5v2h-3v3h-2z'),
  };
  const tap = document.body.appendChild(document.createElement('div'));
  tap.id = 'tap';
  const bar = document.body.appendChild(document.createElement('div'));
  bar.id = 'pv';
  bar.innerHTML = `<button id="pv-play" aria-label="Play"></button><span class="t" id="pv-now">0:00</span>
    <input id="pv-seek" type="range" min="0" step="0.01" value="0" aria-label="Seek">
    <span class="t" id="pv-dur">0:00</span><button id="pv-mute" aria-label="Mute"></button>
    <button id="pv-full" aria-label="Fullscreen"></button>`;
  const $ = id => document.getElementById(id);
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const host = () => window.frameElement?.parentElement ?? document.documentElement;
  const fsDoc = () => (window.frameElement ? parent.document : document);

  const toggle = () => (v.paused || v.ended ? v.play() : v.pause());
  $('pv-play').onclick = toggle;
  tap.onclick = toggle;
  $('pv-mute').onclick = () => { v.muted = !v.muted; };
  $('pv-full').onclick = () => (fsDoc().fullscreenElement ? fsDoc().exitFullscreen() : host().requestFullscreen()).catch(() => {});
  $('pv-seek').oninput = e => { v.currentTime = Number(e.target.value); };
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.key !== ' ') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') v.currentTime = Math.max(0, v.currentTime - 5);
    else if (e.key === 'ArrowRight') v.currentTime = Math.min(v.duration, v.currentTime + 5);
    else if (e.key === 'm') v.muted = !v.muted;
    else if (e.key === 'f') $('pv-full').click();
  });

  const paint = () => {
    const playing = !v.paused && !v.ended;
    $('pv-play').innerHTML = playing ? I.pause : I.play;
    $('pv-play').ariaLabel = playing ? 'Pause' : 'Play';
    $('pv-mute').innerHTML = v.muted ? I.muted : I.sound;
    $('pv-mute').ariaLabel = v.muted ? 'Unmute' : 'Mute';
    const fs = !!fsDoc().fullscreenElement;
    $('pv-full').innerHTML = fs ? I.exit : I.full;
    $('pv-full').ariaLabel = fs ? 'Exit fullscreen' : 'Fullscreen';
  };
  const tick = () => {
    $('pv-now').textContent = fmt(v.currentTime);
    if (document.activeElement !== $('pv-seek')) $('pv-seek').value = v.currentTime;
  };
  v.addEventListener('loadedmetadata', () => { $('pv-seek').max = v.duration; $('pv-dur').textContent = fmt(v.duration); });
  if (v.readyState >= 1) v.dispatchEvent(new Event('loadedmetadata'));
  for (const e of ['play', 'pause', 'ended', 'volumechange']) v.addEventListener(e, paint);
  v.addEventListener('timeupdate', tick);
  fsDoc().addEventListener('fullscreenchange', paint);
  paint();

  // the bar fades while playing and the pointer is still
  let idle;
  const wake = () => {
    bar.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(() => { if (!v.paused) bar.classList.add('idle'); }, 2000);
  };
  for (const e of ['pointermove', 'pointerdown', 'keydown']) addEventListener(e, wake);
  v.addEventListener('pause', wake);
  wake();
}
