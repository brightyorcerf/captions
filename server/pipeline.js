// upload → audio → transcribe → chunk → compose → render. Shared by the HTTP server and the CLI.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chunk } from './chunk.js';
import { assignRoles } from './roles.js';
import { hasDevanagari, romanizeWords } from './romanize.js';
import { pickProvider, transcribe } from './transcribe.js';

const run = promisify(execFile);
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const JOBS = join(ROOT, 'jobs');
const CACHE = join(JOBS, '.cache');
const MAX_SECONDS = 600;
const USAGE = join(CACHE, 'usage.json');

/** Speech-to-text is billed per minute: refuse long files unless asked, so a stray 10-minute upload can't eat the quota. */
async function guardCredits(seconds, allowLong) {
  const max = Number(process.env.MAX_STT_MINUTES || 5);
  if (!allowLong && seconds > max * 60)
    throw new Error(`${(seconds / 60).toFixed(1)} min of audio would be sent for transcription, the limit is ${max} min (raise MAX_STT_MINUTES, or pass --yes to the CLI)`);
}

/** Running total of audio sent to the paid API, kept next to the transcript cache. */
async function logUsage(seconds) {
  const u = await readFile(USAGE, 'utf8').then(JSON.parse, () => ({ seconds: 0, calls: [] }));
  u.seconds += seconds;
  u.calls.push({ at: new Date().toISOString(), provider: pickProvider(), seconds: Math.round(seconds * 10) / 10 });
  await writeFile(USAGE, JSON.stringify(u, null, 1));
  console.log(`[stt] sent ${seconds.toFixed(1)}s to ${pickProvider()}, ${(u.seconds / 60).toFixed(1)} min in total on this machine`);
  return { seconds, totalSeconds: u.seconds };
}
const STEPS = ['audio', 'transcribe', 'chunk', 'matte', 'compose', 'render'];

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

const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');

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

/**
 * Copies a style's fonts ("family/weight", from @fontsource) into the job so renders need no network.
 * font-display is forced to block so no frame is ever captured with a fallback font.
 */
async function bundleFonts(dir, fonts = []) {
  await mkdir(join(dir, 'fonts'), { recursive: true });
  const css = [];
  for (const f of fonts) {
    if (!/^[a-z0-9-]+\/\d{3}$/.test(f)) throw new Error(`bad font "${f}", use family/weight e.g. "montserrat/700"`);
    const [family, weight] = f.split('/');
    const pkg = join(ROOT, 'node_modules/@fontsource', family);
    const src = await readFile(join(pkg, `${weight}.css`), 'utf8').catch(() => {
      throw new Error(`font "${f}" not installed, run: npm install @fontsource/${family}`);
    });
    for (const [, file] of src.matchAll(/url\(\.\/files\/([\w.-]+\.woff2)\)/g)) await copyFile(join(pkg, 'files', file), join(dir, 'fonts', file));
    css.push(src.replace(/,\s*url\(\.\/files\/[\w.-]+\.woff\) format\('woff'\)/g, '')
      .replaceAll('url(./files/', 'url(fonts/').replace(/font-display:\s*\w+/g, 'font-display: block'));
  }
  await writeFile(join(dir, 'fonts.css'), css.join('\n'));
}

async function compose(job) {
  const { dir, meta, style, words, phrases, input, mattes = [] } = job;
  // inlined (not linked) so the renderer's lint sees the timeline registration
  const runtime = await readFile(join(ROOT, 'runtime/captions.js'), 'utf8');
  await copyFile(join(ROOT, 'runtime/captions.css'), join(dir, 'captions.css'));
  await copyFile(join(ROOT, 'runtime/preview.js'), join(dir, 'preview.js'));
  await copyFile(join(ROOT, 'styles', job.styleName, 'style.css'), join(dir, 'style.css'));
  // bundled, not CDN: renders work offline and can't change under us
  await copyFile(join(ROOT, 'node_modules/gsap/dist/gsap.min.js'), join(dir, 'gsap.min.js'));
  await bundleFonts(dir, style.fonts);
  const { width: W, height: H, duration: D } = meta;
  await writeFile(join(dir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${W}, height=${H}">
  <script src="gsap.min.js"></script>
  <link rel="stylesheet" href="fonts.css">
  <link rel="stylesheet" href="captions.css">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}">
    <video id="source" class="clip" data-start="0" data-duration="${D}" data-track-index="0" data-has-audio="true" src="${input}" playsinline></video>
    <div id="callouts"></div>
${mattes.map((m, k) => `    <video id="subject-${k}" class="clip subject" data-start="${m.start}" data-duration="${m.duration}" data-track-index="1" src="${m.src}" muted playsinline></video>`).join('\n')}
    <div id="captions" style="--y: ${style.position[orientation(meta)]}; --font-scale: ${style.fontScale}"></div>
  </div>
  <script type="application/json" id="captions-data">${json({ words, phrases, style, mattes, duration: D })}</script>
  <script>
${runtime}
  </script>
  <script src="preview.js"></script>
</body>
</html>
`);
}

const exists = f => access(f).then(() => true, () => false);
// run the CLI's JS entry with this node: .bin shims are shell scripts that execFile can't start on Windows
const HF_CLI = [join(ROOT, 'node_modules/hyperframes/bin/hyperframes.mjs')];
const HF_ENV = { ...process.env, HYPERFRAMES_SKIP_SKILLS: '1' };
const hf = (...args) => run(process.execPath, [...HF_CLI, ...args],
  { env: HF_ENV, maxBuffer: 1 << 26 });

/**
 * The speaker's outline during a callout, as seen from above: for every column of a 108×192 grid, the
 * first row the person occupies (192 = nobody in that column). One contour per 1/10 s, plus their
 * per-column median. The runtime places each word against these, so "behind the head" holds wherever
 * the speaker stands and however they move.
 */
const GRID = [108, 192];
async function silhouette(file, fps = 10) {
  const [gw, gh] = GRID;
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-c:v', 'libvpx-vp9', '-i', file, '-vf', `${fps > 1 ? `fps=${fps},` : ''}alphaextract,scale=${gw}:${gh}`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
  const frames = [];
  for (let o = 0; o + gw * gh <= stdout.length; o += gw * gh) {
    frames.push(Array.from({ length: gw }, (_, x) => {
      for (let y = 0; y < gh - 1; y++) if (stdout[o + y * gw + x] > 128 && stdout[o + (y + 1) * gw + x] > 128) return y;
      return gh;
    }));
  }
  const median = Array.from({ length: gw }, (_, x) => frames.map(f => f[x]).sort((p, q) => p - q)[frames.length >> 1] ?? gh);
  const top = Math.min(...median);
  // the head: columns within 8% of the frame height of the highest point
  const head = median.flatMap((y, x) => (y <= top + gh * 0.08 ? [x] : []));
  return {
    frames, median,
    head: top < gh ? { top: top / gh, left: head[0] / gw, right: (head.at(-1) + 1) / gw } : null,
  };
}

/**
 * Text-behind-subject: for every callout window, cut the speaker out of the frame so the big word
 * can sit between the background and the person. Matting is the slow step, so: only callout windows,
 * all of them in ONE model run (model start-up is ~15s), at half resolution and 15 fps. The mask is
 * then applied to full-resolution frames so the person stays sharp. Results are cached per window.
 *
 * Never silent: a window whose cut-out failed, found nobody, or found the head too low for a word to
 * sit behind it falls back to an in-line keyword, and the job carries a warning saying so.
 */
const MATTE_FPS = 15;
const RENDER_FPS = 30; // hyperframes' default composition rate
const HEAD_TOO_LOW = 0.5; // head top below mid-frame: a word behind it would collide with the caption line
async function matte(job) {
  job.mattes = [];
  job.warnings = (job.warnings ?? []).filter(w => w.kind !== 'callout');
  if (!job.style.callout) return;
  const { dir, meta } = job;
  const q = t => Math.round(t * MATTE_FPS) / MATTE_FPS; // snap to the matte frame grid so offsets are exact
  const wins = job.phrases.flatMap((p, phrase) => {
    if (!p.callout) return [];
    delete p.callout.fallback;
    const start = q(p.callout.start), duration = Math.max(q(p.callout.end) - start, 1 / MATTE_FPS);
    return [{ phrase, start, duration, src: `subject-${start.toFixed(3)}-${duration.toFixed(3)}.webm` }];
  });
  const todo = [];
  for (const w of wins) if (!(await exists(join(dir, w.src)))) todo.push(w);

  let failure;
  if (todo.length) {
    const strip = join(dir, '.matte-in.mp4'), mask = join(dir, '.matte-mask.webm');
    const select = todo.map(w => `between(t,${w.start},${(w.start + w.duration - 0.001).toFixed(3)})`).join('+');
    try {
      await run('ffmpeg', ['-y', '-v', 'error', '-i', join(dir, job.input), '-an', '-vf',
        `fps=${MATTE_FPS},select='${select}',setpts=N/(${MATTE_FPS}*TB),scale=-2:960`, '-c:v', 'libx264', '-preset', 'veryfast', strip]);
      await hf('remove-background', strip, '-o', mask, '--quality', 'fast');
      let offset = 0;
      for (const w of todo) {
        // the half-resolution mask is upscaled onto full-resolution frames; a 1.5 px blur hides the stair-stepping
        await run('ffmpeg', ['-y', '-v', 'error', '-ss', `${w.start}`, '-t', `${w.duration}`, '-i', join(dir, job.input),
          '-ss', `${offset}`, '-t', `${w.duration}`, '-c:v', 'libvpx-vp9', '-i', mask, '-filter_complex',
          `[1:v]alphaextract,scale=${meta.width}:${meta.height},gblur=sigma=1.5[a];[0:v]scale=${meta.width}:${meta.height}[v];[v][a]alphamerge,format=yuva420p`,
          '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '0', '-crf', '32', '-auto-alt-ref', '0',
          join(dir, w.src)]);
        offset += w.duration;
      }
    } catch (err) {
      failure = err.message.split('\n').find(Boolean) ?? 'unknown error';
      console.warn(`[matte] failed: ${failure}`);
    } finally {
      await rm(strip, { force: true }); await rm(mask, { force: true });
    }
  }

  for (const w of wins) {
    const p = job.phrases[w.phrase], word = job.words[p.callout.idx].text;
    const sil = (await exists(join(dir, w.src))) ? await silhouette(join(dir, w.src)) : null;
    const reason = !sil ? `the speaker cut-out failed (${failure ?? 'no output'})`
      : !sil.head ? 'no person was found in the frame'
      : sil.head.top > HEAD_TOO_LOW ? `the head is too low in the frame (${Math.round(sil.head.top * 100)}% down)`
      : null;
    if (reason) {
      // shown in the line as a keyword rather than in front of the speaker's face
      p.callout.fallback = reason;
      job.warnings.push({ kind: 'callout', phrase: w.phrase, word, at: w.start, reason,
        message: `"${word}" at ${w.start.toFixed(1)}s can't go behind the speaker: ${reason}. It is shown in the caption line instead.` });
      continue;
    }
    // the renderer expects ceil(duration × 30) frames from a clip and waits forever for a missing one, so
    // declare what the file really holds, in whole frames (1.4000000000000021 s asked for a 43rd frame)
    const real = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(dir, w.src)])).stdout);
    const k = Math.round(w.start * RENDER_FPS), n = Math.floor(real * RENDER_FPS + 1e-6);
    job.mattes.push({ ...w, start: Number(((k + 0.001) / RENDER_FPS).toFixed(5)), duration: Number(((n - 0.5) / RENDER_FPS).toFixed(5)), ...sil });
  }
}

/**
 * UGC layout: any video wider than 9:16 becomes a 1080×1920 vertical frame, cropped around the speaker.
 * The speaker is found by cutting the person out of ~12 frames spread over the clip (cheap: tiny frames,
 * one model run) and taking the median head centre. The crop is fixed, not panning: a steady frame
 * reads better than a jittery follow, and talking heads rarely cross the frame.
 * Returns an ffmpeg filter, or null when the video is already vertical.
 */
const UGC = [1080, 1920];
async function reframe(job) {
  const { width: W, height: H, duration } = job.meta;
  if (H / W >= 1.7) return null; // already 9:16 (or taller)
  const cw = Math.min(W, Math.round((H * 9) / 16 / 2) * 2);
  let centre = 0.5;
  const strip = join(job.dir, '.reframe-in.mp4'), mask = join(job.dir, '.reframe-mask.webm');
  try {
    const n = 12;
    await run('ffmpeg', ['-y', '-v', 'error', '-i', join(job.dir, job.input), '-an', '-vf', `fps=${n / duration},scale=-2:360`,
      '-frames:v', `${n}`, '-c:v', 'libx264', '-preset', 'veryfast', strip]);
    await hf('remove-background', strip, '-o', mask, '--quality', 'fast');
    const { frames } = await silhouette(mask, 1);
    const centres = frames.map(f => {
      const top = Math.min(...f);
      if (top >= GRID[1]) return null;
      const head = f.flatMap((y, x) => (y <= top + GRID[1] * 0.08 ? [x] : []));
      return (head[0] + head.at(-1) + 1) / 2 / GRID[0];
    }).filter(c => c != null).sort((a, b) => a - b);
    if (!centres.length) throw new Error('no person found');
    centre = centres[centres.length >> 1];
  } catch (err) {
    const reason = err.message.split('\n')[0];
    job.warnings.push({ kind: 'reframe', reason,
      message: `Couldn't find the speaker to frame the 9:16 crop (${reason}), so the centre of the frame is used.` });
  } finally {
    await rm(strip, { force: true }); await rm(mask, { force: true });
  }
  const x = Math.round(Math.max(0, Math.min(W - cw, centre * W - cw / 2)) / 2) * 2;
  job.reframe = { centre, x, width: cw };
  return `crop=${cw}:${H}:${x}:0,scale=${UGC[0]}:${UGC[1]}:flags=lanczos,setsar=1`;
}

function render(job, emit) {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, [...HF_CLI, 'render', job.dir, '-o', join(job.dir, 'output.mp4'), '--quality', 'delivery'], { env: HF_ENV });
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
export async function createJob({ id, ext, styleName = 'eclipse', source, language, keyterms, transcriptFile, allowLong, layout }) {
  const dir = join(JOBS, id);
  await mkdir(dir, { recursive: true });
  const input = `input${ext}`;
  if (source) await copyFile(source, join(dir, input));
  const style = await loadStyle(styleName);
  return { id, dir, input, styleName, style, language, keyterms, transcriptFile, allowLong, layout: layout ?? style.layout ?? 'original', state: null };
}

/** Runs the pipeline from `from` to `to`. Re-running from 'chunk' re-uses the (edited) transcript: no API call. */
export async function runJob(job, emit = () => {}, from = 'audio', to = 'render') {
  const steps = STEPS.slice(STEPS.indexOf(from), STEPS.indexOf(to) + 1);
  const tell = e => { job.state = e; emit(e); };
  let step;
  try {
    for (step of steps) {
      tell({ step, status: 'running' });
      if (step === 'audio') {
        job.meta = await probe(join(job.dir, job.input));
        job.warnings = [];
        await run('ffmpeg', ['-y', '-v', 'error', '-i', join(job.dir, job.input), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', join(job.dir, 'audio.mp3')]);
        const crop = job.layout === '9:16' ? await reframe(job) : null;
        // normalise once: H.264 with a keyframe every second seeks frame-accurately in the renderer and
        // plays in every browser preview (phone HEVC / sparse-keyframe uploads otherwise freeze)
        await run('ffmpeg', ['-y', '-v', 'error', '-i', join(job.dir, job.input), ...(crop ? ['-vf', crop] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
          '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', join(job.dir, 'source.mp4')]);
        job.input = 'source.mp4';
        if (crop) job.meta = { ...job.meta, width: UGC[0], height: UGC[1] };
      }
      if (step === 'transcribe') {
        // 1. a transcript shipped next to the video (samples, test clips): no key, no credits
        let t = job.transcriptFile ? JSON.parse(await readFile(job.transcriptFile, 'utf8')) : null;
        // 2. cache by content hash + everything that changes the result: same request never pays twice
        let cached;
        if (!t) {
          const req = JSON.stringify([pickProvider(), job.language ?? null, [...(job.keyterms ?? [])].sort()]);
          const key = createHash('sha256').update(await sha256(join(job.dir, 'audio.mp3'))).update(req).digest('hex');
          cached = join(CACHE, `${key}.json`);
          t = await readFile(cached, 'utf8').then(JSON.parse, () => null);
        }
        // 3. the API, behind a spending guard
        if (!t) {
          await guardCredits(job.meta.duration, job.allowLong);
          t = await transcribe(join(job.dir, 'audio.mp3'), { language: job.language, keyterms: job.keyterms });
          await mkdir(CACHE, { recursive: true });
          await writeFile(cached, JSON.stringify(t));
          job.usage = await logUsage(job.meta.duration);
        }
        if (!t.words.length) throw new Error('no speech found in this video');
        job.words = t.words;
        // Hindi may come back in Devanagari; Hinglish reels are captioned in Latin script
        if (job.words.some(w => hasDevanagari(w.text))) romanizeWords(job.words);
        job.language = t.language;
      }
      if (step === 'chunk') {
        const opts = chunkOptions(job.style, job.meta);
        // auto-pick keywords once; after that the editor owns them
        if (!job.rolesSet) {
          assignRoles(job.words, chunk(job.words, opts), { ...job.style.roles, callout: !!job.style.callout, keyterms: job.keyterms });
          job.rolesSet = true;
        }
        // callout words are lifted out of the line: they count as words of the phrase but take no line width
        job.phrases = chunk(job.words, { ...opts, free: i => job.style.callout && job.words[i].role === 'callout' });
        // a callout lives exactly as long as its phrase (measured: 0.9–1.8 s, hard cut in and out)
        if (job.style.callout) {
          for (const p of job.phrases) {
            const idx = p.wordIdx.find(i => job.words[i].role === 'callout');
            if (idx !== undefined) p.callout = { idx, start: p.start, end: p.end };
          }
        }
        await writeFile(join(job.dir, 'transcript.json'), JSON.stringify({ words: job.words, phrases: job.phrases }, null, 1));
      }
      if (step === 'matte') await matte(job);
      if (step === 'compose') await compose(job);
      if (step === 'render') await render(job, tell);
    }
    tell({ step: to, status: 'done' });
  } catch (err) {
    tell({ step, status: 'error', error: err.message });
    throw err;
  }
}

/** Re-opens a job folder written by an earlier run (transcript.json + source.mp4), e.g. to re-run from 'chunk'. */
export async function loadJob(dir, { styleName = 'eclipse', keyterms, layout } = {}) {
  const { words } = JSON.parse(await readFile(join(dir, 'transcript.json'), 'utf8'));
  const style = await loadStyle(styleName);
  return { id: dir.split(/[\/]/).at(-1), dir, input: 'source.mp4', styleName, style, keyterms, words,
    layout: layout ?? style.layout ?? 'original', meta: await probe(join(dir, 'source.mp4')), state: null };
}
