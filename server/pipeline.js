// upload → audio → transcribe → chunk → compose → render. Shared by the HTTP server and the CLI.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chunk } from './chunk.js';
import { assignRoles } from './roles.js';
import { transcribe } from './transcribe.js';

const run = promisify(execFile);
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const JOBS = join(ROOT, 'jobs');
const CACHE = join(JOBS, '.cache');
const MAX_SECONDS = 600;
export const STEPS = ['audio', 'transcribe', 'chunk', 'matte', 'compose', 'render'];

export const listStyles = async () =>
  (await readdir(join(ROOT, 'styles'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);

export async function loadStyle(name) {
  if (!(await listStyles()).includes(name)) throw new Error(`unknown style "${name}"`);
  return JSON.parse(await readFile(join(ROOT, 'styles', name, 'style.json'), 'utf8'));
}

async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height:stream_side_data=rotation:stream_tags=rotate:format=duration', '-of', 'json', file]);
  const { streams: [s] = [], format } = JSON.parse(stdout);
  if (!s) throw new Error('no video stream found');
  const rot = Math.abs(Number(s.side_data_list?.find(d => 'rotation' in d)?.rotation ?? s.tags?.rotate ?? 0));
  const [width, height] = rot === 90 || rot === 270 ? [s.height, s.width] : [s.width, s.height]; // phone footage
  const duration = Number(format.duration);
  if (!(duration > 0)) throw new Error('could not read video duration');
  if (duration > MAX_SECONDS) throw new Error(`video is ${Math.round(duration)}s, max is ${MAX_SECONDS}s`);
  return { width, height, duration };
}

const sha256 = file => new Promise((ok, fail) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
});

/** Layout-dependent chunk limits: how many characters fit on the configured number of lines. */
export function chunkOptions(style, { width, height }) {
  const fontPx = style.fontScale * Math.min(width, height);
  const perLine = (width * 0.86) / (fontPx * style.charWidth * (1 + (style.motion.activeScale - 1) / 2));
  return { ...style.chunk, maxChars: Math.floor(perLine * style.maxLines) };
}

function orientation({ width, height }) {
  const r = height / width;
  return r > 1.2 ? 'portrait' : r < 0.83 ? 'landscape' : 'square';
}

const json = v => JSON.stringify(v).replace(/</g, '\\u003c'); // safe inside <script>

async function compose(job) {
  const { dir, meta, style, words, phrases, input, mattes = [] } = job;
  await copyFile(join(ROOT, 'runtime/captions.js'), join(dir, 'captions.js'));
  await copyFile(join(ROOT, 'runtime/captions.css'), join(dir, 'captions.css'));
  await copyFile(join(ROOT, 'styles', job.styleName, 'style.css'), join(dir, 'style.css'));
  const { width: W, height: H, duration: D } = meta;
  await writeFile(join(dir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${W}, height=${H}">
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <link rel="stylesheet" href="captions.css">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}">
    <video id="source" class="clip" data-start="0" data-duration="${D}" data-track-index="0" data-has-audio="true" src="${input}" playsinline></video>
    <div id="callouts"></div>
${mattes.map(m => `    <video class="clip subject" data-start="${m.start}" data-duration="${m.duration}" data-track-index="1" src="${m.src}" muted playsinline></video>`).join('\n')}
    <div id="captions" style="--y: ${style.position[orientation(meta)]}; --font-scale: ${style.fontScale}"></div>
  </div>
  <script type="application/json" id="captions-data">${json({ words, phrases, style, mattes, duration: D })}</script>
  <script src="captions.js"></script>
</body>
</html>
`);
}

const exists = f => access(f).then(() => true, () => false);
const hf = (...args) => run(join(ROOT, 'node_modules/.bin/hyperframes'), args,
  { env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' }, maxBuffer: 1 << 26 });

/** Fraction of frame height where the subject's head starts, read from the matte's first frame. */
async function headTop(file) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-c:v', 'libvpx-vp9', '-i', file, '-frames:v', '1',
    '-vf', 'alphaextract,scale=108:192', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 1 << 20 });
  for (let y = 0; y < 192; y++) {
    let solid = 0;
    for (let x = 0; x < 108; x++) if (stdout[y * 108 + x] > 128) solid++;
    if (solid >= 3) return y / 192;
  }
  return null;
}

/**
 * Text-behind-subject: for every phrase holding a callout, cut the speaker out of the frame so the
 * big word can sit between the background and the person. Only those windows are matted (it is the
 * slow step), at half resolution; the mask is then applied to full-resolution frames so the person stays sharp.
 */
async function matte(job) {
  job.mattes = [];
  if (!job.style.callout?.behindSubject) return;
  const { dir, meta } = job;
  for (const [n, p] of job.phrases.entries()) {
    if (!p.callout) continue;
    const start = +p.callout.start.toFixed(3), duration = +(p.callout.end - p.callout.start).toFixed(3);
    const src = `subject-${start}-${duration}.webm`;
    const out = join(dir, src);
    if (!(await exists(out))) {
      const half = join(dir, `.half-${n}.mp4`), mask = join(dir, `.mask-${n}.webm`);
      try {
        await run('ffmpeg', ['-y', '-v', 'error', '-ss', `${start}`, '-i', join(dir, job.input), '-t', `${duration}`,
          '-vf', 'scale=-2:960', '-an', '-c:v', 'libx264', '-preset', 'veryfast', half]);
        await hf('remove-background', half, '-o', mask, '--quality', 'fast');
        await run('ffmpeg', ['-y', '-v', 'error', '-ss', `${start}`, '-i', join(dir, job.input), '-t', `${duration}`,
          '-c:v', 'libvpx-vp9', '-i', mask, '-filter_complex',
          `[1:v]alphaextract,scale=${meta.width}:${meta.height}[a];[0:v]scale=${meta.width}:${meta.height}[v];[v][a]alphamerge,format=yuva420p`,
          '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '0', '-crf', '32', '-auto-alt-ref', '0', out]);
      } catch (err) {
        // ponytail: no matte -> callout simply renders in front of the speaker
        console.warn(`[matte] phrase ${n} skipped: ${err.message.split('\n')[0]}`);
        continue;
      } finally {
        await rm(half, { force: true }); await rm(mask, { force: true });
      }
    }
    job.mattes.push({ phrase: n, src, start, duration, headTop: await headTop(out) });
  }
}

function render(job, emit) {
  const bin = join(ROOT, 'node_modules/.bin/hyperframes');
  return new Promise((ok, fail) => {
    const p = spawn(bin, ['render', job.dir, '-o', join(job.dir, 'output.mp4'), '--quality', 'delivery'], {
      env: { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' },
    });
    let log = '';
    const onData = d => {
      log = (log + d).slice(-4000);
      const pct = String(d).match(/(\d{1,3})%/g)?.at(-1);
      if (pct) emit({ step: 'render', status: 'running', progress: parseInt(pct, 10) });
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', fail);
    p.on('close', code => (code === 0 ? ok() : fail(new Error(`hyperframes render exited ${code}\n${log.slice(-800)}`))));
  });
}

/** Creates a job folder. `source` is copied in unless the caller already wrote `input<ext>` there. */
export async function createJob({ id, ext, styleName = 'eclipse', source, language, keyterms }) {
  const dir = join(JOBS, id);
  await mkdir(dir, { recursive: true });
  const input = `input${ext}`;
  if (source) await copyFile(source, join(dir, input));
  return { id, dir, input, styleName, style: await loadStyle(styleName), language, keyterms, state: null };
}

/** Runs the pipeline from `from` onwards. Re-running from 'chunk' re-uses the (edited) transcript: no API call. */
export async function runJob(job, emit = () => {}, from = 'audio') {
  const steps = STEPS.slice(STEPS.indexOf(from));
  const tell = e => { job.state = e; emit(e); };
  let step;
  try {
    for (step of steps) {
      tell({ step, status: 'running' });
      if (step === 'audio') {
        job.meta = await probe(join(job.dir, job.input));
        await run('ffmpeg', ['-y', '-v', 'error', '-i', join(job.dir, job.input), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', join(job.dir, 'audio.mp3')]);
      }
      if (step === 'transcribe') {
        // cache by content hash: same video never pays for transcription twice
        const cached = join(CACHE, `${await sha256(join(job.dir, 'audio.mp3'))}${job.language ? `-${job.language}` : ''}.json`);
        let t = await readFile(cached, 'utf8').then(JSON.parse, () => null);
        if (!t) {
          t = await transcribe(join(job.dir, 'audio.mp3'), { language: job.language, keyterms: job.keyterms });
          await mkdir(CACHE, { recursive: true });
          await writeFile(cached, JSON.stringify(t));
        }
        if (!t.words.length) throw new Error('no speech found in this video');
        job.words = t.words;
        job.language = t.language;
      }
      if (step === 'chunk') {
        const opts = chunkOptions(job.style, job.meta);
        // auto-pick keywords once; after that the editor owns them
        if (!job.rolesSet) {
          assignRoles(job.words, chunk(job.words, opts), { ...job.style.roles, callout: !!job.style.callout });
          job.rolesSet = true;
        }
        // callout words are lifted out of the line, so they don't count toward its limits
        job.phrases = chunk(job.words, { ...opts, free: i => job.style.callout && job.words[i].role === 'callout' });
        // a callout lives in its own layer, so it may outlast its phrase (until the next callout)
        if (job.style.callout) {
          let next = job.meta.duration;
          for (const p of [...job.phrases].reverse()) {
            const idx = p.wordIdx.find(i => job.words[i].role === 'callout');
            if (idx === undefined) continue;
            p.callout = { idx, start: p.start, end: Math.min(Math.max(p.end, job.words[idx].end + job.style.callout.hold), next) };
            next = p.start;
          }
        }
        await writeFile(join(job.dir, 'transcript.json'), JSON.stringify({ words: job.words, phrases: job.phrases }, null, 1));
      }
      if (step === 'matte') await matte(job);
      if (step === 'compose') await compose(job);
      if (step === 'render') await render(job, tell);
    }
    tell({ step: 'render', status: 'done' });
  } catch (err) {
    tell({ step, status: 'error', error: err.message });
    throw err;
  }
}
