// ---------- constellation background ----------
const sky = document.getElementById('sky');
const ctx = sky.getContext('2d');
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
let stars = [];

function resize() {
  sky.width = innerWidth * devicePixelRatio;
  sky.height = innerHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  const n = Math.round((innerWidth * innerHeight) / 22000);
  stars = Array.from({ length: n }, () => ({
    x: Math.random() * innerWidth,
    y: Math.random() * innerHeight,
    r: Math.random() * 2 + 1,
    vx: (Math.random() - 0.5) * 0.15,
    vy: (Math.random() - 0.5) * 0.15,
    // mostly white, a few black hints
    c: Math.random() < 0.18 ? '#191919' : '#ffffff',
  }));
}

function draw() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  for (const s of stars) {
    s.x = (s.x + s.vx + innerWidth) % innerWidth;
    s.y = (s.y + s.vy + innerHeight) % innerHeight;
  }
  ctx.lineWidth = 1;
  for (let i = 0; i < stars.length; i++) {
    for (let j = i + 1; j < stars.length; j++) {
      const d = Math.hypot(stars[i].x - stars[j].x, stars[i].y - stars[j].y);
      if (d < 110) {
        ctx.strokeStyle = `rgba(255,255,255,${0.35 * (1 - d / 110)})`;
        ctx.beginPath(); ctx.moveTo(stars[i].x, stars[i].y); ctx.lineTo(stars[j].x, stars[j].y); ctx.stroke();
      }
    }
  }
  for (const s of stars) {
    ctx.fillStyle = s.c;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
  }
  if (!still) requestAnimationFrame(draw);
}
addEventListener('resize', () => { resize(); if (still) draw(); });
resize(); draw();

// ---------- upload ----------
const form = document.getElementById('upload');
const file = document.getElementById('file');
const dropText = document.getElementById('drop-text');
const go = form.querySelector('.go');

function pick(f) {
  if (!f) return;
  const dt = new DataTransfer(); dt.items.add(f); file.files = dt.files;
  dropText.textContent = `${f.name} · ${(f.size / 1e6).toFixed(1)} MB`;
  form.classList.add('has-file');
  go.disabled = false;
}
file.addEventListener('change', () => pick(file.files[0]));
for (const ev of ['dragenter', 'dragover']) form.addEventListener(ev, e => { e.preventDefault(); form.classList.add('dragging'); });
for (const ev of ['dragleave', 'drop']) form.addEventListener(ev, e => { e.preventDefault(); form.classList.remove('dragging'); });
form.addEventListener('drop', e => pick(e.dataTransfer.files[0]));

form.addEventListener('submit', async e => {
  e.preventDefault();
  go.disabled = true; go.textContent = 'Uploading…';
  try {
    const f = file.files[0];
    const q = new URLSearchParams({ name: f.name, style: form.elements.style.value });
    const res = await fetch(`/api/jobs?${q}`, { method: 'POST', body: f });
    if (!res.ok) throw new Error((await res.json()).error);
    const { id } = await res.json();
    openJob(id, file.files[0].name);
  } catch (err) {
    dropText.textContent = `Upload failed: ${err.message}`;
    go.disabled = false;
  } finally {
    go.textContent = 'Caption';
  }
});

// ---------- samples ----------
fetch('/api/samples').then(r => r.json()).then(files => {
  if (!files.length) return;
  document.querySelector('#samples .sample-grid').replaceChildren(...files.map(f => {
    const fig = document.createElement('figure');
    const v = Object.assign(document.createElement('video'), { src: `/samples/output/${f}#t=1.2`, controls: true, preload: 'metadata', playsInline: true });
    const cap = document.createElement('figcaption');
    cap.textContent = f.replace(/\.mp4$/, '');
    fig.append(v, cap);
    return fig;
  }));
  document.getElementById('samples').hidden = false;
  document.querySelector('a.samples').hidden = false;
}).catch(() => {});

// ---------- workspace ----------
const landing = document.getElementById('landing');
const ws = document.getElementById('workspace');
const steps = [...document.querySelectorAll('#steps li')];
const phrasesEl = document.getElementById('phrases');
const rerender = document.getElementById('rerender');
const exportBtn = document.getElementById('export');
const statusEl = document.getElementById('status');
let job = null;

// style picker lists whatever is in styles/: adding a style needs no UI change
fetch('/api/styles').then(r => r.json()).then(names => {
  form.elements.style.replaceChildren(...names.map(n => new Option(n, n, n === 'eclipse', n === 'eclipse')));
}).catch(() => {});

const samples = document.getElementById('samples');
document.getElementById('back').onclick = () => { ws.hidden = true; landing.hidden = false; samples.hidden = !samples.querySelector('figure'); };

function openJob(id, name) {
  job = { id, words: [] };
  landing.hidden = true; ws.hidden = false; samples.hidden = true;
  document.getElementById('job-name').textContent = name;
  const es = new EventSource(`/api/jobs/${id}/events`);
  let loaded = false;
  es.onmessage = ({ data }) => {
    const { step, status, error, progress } = JSON.parse(data);
    const i = steps.findIndex(li => li.dataset.step === step);
    steps.forEach((li, k) => {
      li.className = k < i || status === 'done' ? 'done' : k === i ? (error ? 'failed' : 'active') : '';
      li.dataset.label ??= li.textContent;
      li.textContent = li.dataset.label + (k === i && progress != null ? ` ${progress}%` : '');
    });
    statusEl.textContent = error ? `${step} failed: ${error}` : '';
    if (step === 'render' && !loaded) { loaded = true; loadJob(); } // composition exists from here on
    if (status === 'done' || error) es.close();
    if (status === 'done') { exportBtn.href = `/api/jobs/${id}/output.mp4`; exportBtn.setAttribute('aria-disabled', 'false'); }
  };
}

async function loadJob() {
  const data = await (await fetch(`/api/jobs/${job.id}`)).json();
  job.words = data.words;
  document.querySelector('.preview').style.aspectRatio = `${data.meta.width} / ${data.meta.height}`;
  document.getElementById('preview').src = data.previewUrl;
  renderPhrases(data.phrases);
}

const ROLES = [null, 'emphasis', 'callout'];

function renderPhrases(phrases) {
  phrasesEl.replaceChildren(...phrases.map(p => {
    const div = document.createElement('div');
    div.className = 'phrase';
    div.innerHTML = `<span class="t">${p.start.toFixed(2)}s – ${p.end.toFixed(2)}s</span>`;
    for (const wi of p.wordIdx) {
      const b = document.createElement('button');
      b.className = `word ${job.words[wi].role ?? ''}`; b.textContent = job.words[wi].text;
      b.oncontextmenu = e => {
        e.preventDefault();
        const w = job.words[wi];
        w.role = ROLES[(ROLES.indexOf(w.role ?? null) + 1) % ROLES.length] ?? undefined;
        b.className = `word ${w.role ?? ''}`;
        rerender.disabled = false;
      };
      b.onclick = () => {
        if (b.isContentEditable) return;
        b.contentEditable = 'true'; b.focus();
        getSelection().selectAllChildren(b); // typing replaces the word
      };
      b.onblur = () => {
        b.contentEditable = 'false';
        const t = b.textContent.trim();
        if (t && t !== job.words[wi].text) { job.words[wi].text = t; rerender.disabled = false; }
        else b.textContent = job.words[wi].text;
      };
      b.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); b.blur(); }
        if (e.key === 'Escape') { b.textContent = job.words[wi].text; b.blur(); }
      };
      div.append(b);
    }
    return div;
  }));
}

rerender.onclick = async () => {
  rerender.disabled = true;
  exportBtn.setAttribute('aria-disabled', 'true');
  await fetch(`/api/jobs/${job.id}/transcript`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ words: job.words.map(({ text, role }) => ({ text, role })) }),
  });
  openJob(job.id, document.getElementById('job-name').textContent);
};
