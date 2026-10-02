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
    const res = await fetch('/api/jobs', { method: 'POST', body: new FormData(form) });
    if (!res.ok) throw new Error(await res.text());
    const { id } = await res.json();
    openJob(id, file.files[0].name);
  } catch (err) {
    dropText.textContent = `Upload failed: ${err.message}`;
    go.disabled = false;
  } finally {
    go.textContent = 'Caption';
  }
});

// ---------- workspace ----------
const landing = document.getElementById('landing');
const ws = document.getElementById('workspace');
const steps = [...document.querySelectorAll('#steps li')];
const phrasesEl = document.getElementById('phrases');
const rerender = document.getElementById('rerender');
const exportBtn = document.getElementById('export');
let job = null;

document.getElementById('back').onclick = () => { ws.hidden = true; landing.hidden = false; };

function openJob(id, name) {
  job = { id, words: [] };
  landing.hidden = true; ws.hidden = false;
  document.getElementById('job-name').textContent = name;
  const es = new EventSource(`/api/jobs/${id}/events`);
  es.onmessage = ({ data }) => {
    const { step, status, error } = JSON.parse(data);
    const i = steps.findIndex(li => li.dataset.step === step);
    steps.forEach((li, k) => { li.className = k < i || status === 'done' ? 'done' : k === i ? 'active' : ''; });
    if (step === 'compose' && status !== 'running') loadJob();
    if (status === 'done' || error) es.close();
    if (status === 'done') { exportBtn.href = `/api/jobs/${id}/output.mp4`; exportBtn.setAttribute('aria-disabled', 'false'); }
  };
}

async function loadJob() {
  const data = await (await fetch(`/api/jobs/${job.id}`)).json();
  job.words = data.words;
  document.getElementById('preview').src = data.previewUrl;
  renderPhrases(data.phrases);
}

function renderPhrases(phrases) {
  phrasesEl.replaceChildren(...phrases.map(p => {
    const div = document.createElement('div');
    div.className = 'phrase';
    div.innerHTML = `<span class="t">${p.start.toFixed(2)}s – ${p.end.toFixed(2)}s</span>`;
    for (const wi of p.wordIdx) {
      const b = document.createElement('button');
      b.className = 'word'; b.textContent = job.words[wi].text;
      b.onclick = () => { b.contentEditable = 'true'; b.focus(); };
      b.onblur = () => {
        b.contentEditable = 'false';
        const t = b.textContent.trim();
        if (t && t !== job.words[wi].text) { job.words[wi].text = t; rerender.disabled = false; }
        else b.textContent = job.words[wi].text;
      };
      b.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); b.blur(); } };
      div.append(b);
    }
    return div;
  }));
}

rerender.onclick = async () => {
  rerender.disabled = true;
  exportBtn.setAttribute('aria-disabled', 'true');
  await fetch(`/api/jobs/${job.id}/transcript`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ words: job.words }),
  });
  openJob(job.id, document.getElementById('job-name').textContent);
};
