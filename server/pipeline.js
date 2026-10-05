// upload → audio → transcribe → chunk → compose → render. Shared by the HTTP server and the CLI.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chunk, spreadTimes } from './chunk.js';
import { cropX, follow, track } from './follow.js';
import { assignRoles } from './roles.js';
import { hasDevanagari, romanizeWords } from './romanize.js';
import { matteFrames, matteVideo, modelSize } from './segment.js';
import { tidyWords } from './tidy.js';
import { pickProvider, transcribe } from './transcribe.js';

const execFileP = promisify(execFile);
// ffmpeg/ffprobe errors: lead with the tool's own stderr and exit code, not the command line, which is all the UI shows
const run = (cmd, args, opts) => execFileP(cmd, args, opts).catch(err => {
  const code = typeof err.code === 'number' ? `exit 0x${(err.code >>> 0).toString(16)}` : err.code ?? err.signal;
  err.message = `${cmd} failed (${code}): ${err.stderr?.trim().split('\n').pop() || 'no error output'}`;
  throw err;
});
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
async function logUsage(seconds, provider) {
  const u = await readFile(USAGE, 'utf8').then(JSON.parse, () => ({ seconds: 0, calls: [] }));
  u.seconds += seconds;
  u.calls.push({ at: new Date().toISOString(), provider, seconds: Math.round(seconds * 10) / 10 });
  await writeFile(USAGE, JSON.stringify(u, null, 1));
  console.log(`[stt] sent ${seconds.toFixed(1)}s to ${provider}, ${(u.seconds / 60).toFixed(1)} min in total on this machine`);
  return { seconds, totalSeconds: u.seconds };
}
const STEPS = ['audio', 'transcribe', 'chunk', 'matte', 'compose', 'render'];

export const listStyles = async () =>
  (await readdir(join(ROOT, 'styles'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);

export async function loadStyle(name) {
  if (!(await listStyles()).includes(name)) throw new Error(`unknown style "${name}"`);
  return JSON.parse(await readFile(join(ROOT, 'styles', name, 'style.json'), 'utf8'));
}

/**
 * Caption-line fonts a custom look can pick from. Each is bundled (@fontsource) and its average glyph
 * width measured, because the chunker uses that width to decide how many words fit on one line.
 */
export const FONTS = {
  montserrat: { family: 'Montserrat', font: 'montserrat/700', charWidth: 0.56 },
  inter: { family: 'Inter', font: 'inter/700', charWidth: 0.515 },
  poppins: { family: 'Poppins', font: 'poppins/700', charWidth: 0.544 },
};

const badRequest = msg => Object.assign(new Error(msg), { status: 400 });

/**
 * A custom look on top of a style: highlight colour, caption-line font, and words behind the speaker
 * on or off. Keywords and callouts keep the style's display font. Returns a new style; throws on bad input.
 */
export function customizeStyle(style, { accent, font, behind } = {}) {
  const s = structuredClone(style);
  if (accent != null) {
    if (!/^#[0-9a-f]{6}$/i.test(accent)) throw badRequest(`highlight colour must look like #fee300, got "${accent}"`);
    const [r, g, b] = [1, 3, 5].map(k => parseInt(accent.slice(k, k + 2), 16));
    s.colors = { ...s.colors, active: accent.toLowerCase() };
    if (s.highlight) s.highlight = { on: `rgba(${r},${g},${b},0.30)`, off: `rgba(${r},${g},${b},0)` };
  }
  if (font != null) {
    const f = FONTS[font];
    if (!f) throw badRequest(`font must be one of ${Object.keys(FONTS).join(', ')}`);
    const lineFonts = new Set(Object.values(FONTS).map(x => x.font));
    s.fonts = [f.font, ...s.fonts.filter(x => !lineFonts.has(x))];
    s.lineFamily = f.family;
    s.charWidth = f.charWidth;
  }
  if (behind === false) delete s.callout; // no callouts: no cut-out, nothing behind the speaker
  return s;
}

async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height:stream_side_data=rotation:stream_tags=rotate:format=duration,start_time', '-of', 'json', file]);
  const { streams: [s] = [], format } = JSON.parse(stdout);
  if (!s) throw new Error('no video stream found');
  const rot = Math.abs(Number(s.side_data_list?.find(d => 'rotation' in d)?.rotation ?? s.tags?.rotate ?? 0));
  const [width, height] = rot === 90 || rot === 270 ? [s.height, s.width] : [s.width, s.height]; // phone footage
  const duration = Number(format.duration);
  if (!(duration > 0)) throw new Error('could not read video duration');
  if (duration > MAX_SECONDS) throw new Error(`video is ${Math.round(duration)}s, max is ${MAX_SECONDS}s`);
  return { width, height, duration, startTime: Number(format.start_time) || 0 };
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
  // a custom font replaces the caption line's family; the value comes from FONTS, never from the request
  const css = await readFile(join(ROOT, 'styles', job.styleName, 'style.css'), 'utf8');
  await writeFile(join(dir, 'style.css'), style.lineFamily ? `${css}\n.phrase { font-family: "${style.lineFamily}", sans-serif; }\n` : css);
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
/**
 * The speaker's outline during a callout, as seen from above: for every column of a 108×192 grid, the
 * first row the person occupies (192 = nobody in that column). One contour per 1/10 s, plus their
 * per-column median. The runtime places each word against these, so "behind the head" holds wherever
 * the speaker stands and however they move.
 */
const GRID = [108, 192];
/** One contour from a matte read through `at(x, y)` on the grid (0-255, 255 = person). */
function contour(at) {
  const [gw, gh] = GRID;
  return Array.from({ length: gw }, (_, x) => {
    for (let y = 0; y < gh - 1; y++) if (at(x, y) > 128 && at(x, y + 1) > 128) return y;
    return gh;
  });
}
/** Contour of a w×h matte in memory, point-sampled onto the grid. */
const contourOf = (m, w, h) => contour((x, y) => m[Math.floor(((y + 0.5) * h) / GRID[1]) * w + Math.floor(((x + 0.5) * w) / GRID[0])]);

async function silhouette(file, fps = 10) {
  const [gw, gh] = GRID;
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-c:v', 'libvpx-vp9', '-i', file, '-vf', `${fps > 1 ? `fps=${fps},` : ''}alphaextract,scale=${gw}:${gh}`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
  const frames = [];
  for (let o = 0; o + gw * gh <= stdout.length; o += gw * gh) frames.push(contour((x, y) => stdout[o + y * gw + x]));
  const median = Array.from({ length: gw }, (_, x) => frames.map(f => f[x]).sort((p, q) => p - q)[frames.length >> 1] ?? gh);
  return { frames, median, head: headOf(median) };
}

/**
 * The highest head in an outline: the connected run of columns within 8% of the frame height of the
 * highest point. Connected, so with two people side by side it is one head, not the span across both.
 */
function headOf(contour) {
  const [gw, gh] = GRID, top = Math.min(...contour);
  if (top >= gh) return null;
  let l = contour.indexOf(top), r = l;
  while (l > 0 && contour[l - 1] <= top + gh * 0.08) l--;
  while (r < gw - 1 && contour[r + 1] <= top + gh * 0.08) r++;
  return { top: top / gh, left: l / gw, right: (r + 1) / gw };
}

/**
 * Text-behind-subject: for every callout window, cut the speaker out of the frame so the big word
 * can sit between the background and the person. Only callout windows are cut out, all of them in one
 * model pass at the model's 512 px and 15 fps; the matte is then applied to full-resolution frames so
 * the person stays sharp. Results are cached per window.
 *
 * A camera cut inside a window would leave the word placed against the previous shot's speaker, so the
 * word is shown only on the side of the cut where it is spoken.
 *
 * Never silent: a window whose cut-out failed, found nobody, or found the head too low for a word to
 * sit behind it falls back to an in-line keyword, and the job carries a warning saying so.
 */
const MATTE_FPS = 15;
const RENDER_FPS = 30; // hyperframes' default composition rate
const HEAD_TOO_LOW = 0.5; // head top below mid-frame: a word behind it would collide with the caption line
const HEAD_TOO_HIGH = 0.04; // head cut by the top edge (a close-up): a word behind it would be almost all hidden
const MIN_SHOW = 0.5; // shortest a big word may stay up once a camera cut has trimmed it
/**
 * A word is placed once against the speaker's outline, so the speaker must be there in every frame it is
 * up, near their usual place. Catches what cut detection can't: a dissolve to other footage (the sports
 * interview's EXPRESSING sat over a crowd, then a stranger), someone walking through.
 */
function unsteady(sil) {
  // a stray frame (a hand raised above the head, a matte glitch) is tolerated; 15% of them is not
  const heads = sil.frames.map(headOf), centre = h => (h.left + h.right) / 2, many = n => n > 0.15 * heads.length;
  if (many(heads.filter(h => !h).length)) return 'the speaker leaves the shot while it would be on screen';
  if (many(heads.filter(h => h && (Math.abs(centre(h) - centre(sil.head)) > 0.2 || Math.abs(h.top - sil.head.top) > 0.12)).length))
    return 'the speaker moves too much while it would be on screen';
  return null;
}
async function matte(job) {
  job.mattes = [];
  job.warnings = (job.warnings ?? []).filter(w => w.kind !== 'callout');
  if (!job.style.callout) return;
  const { dir, meta } = job;
  for (const p of job.phrases) {
    if (!p.callout) continue;
    delete p.callout.fallback;
    delete p.callout.cut;
    for (let c; (c = (job.cuts ?? []).find(t => t > p.callout.start + 0.04 && t < p.callout.end - 0.04)) !== undefined;) {
      const said = job.words[p.callout.idx].start;
      if (said >= c && p.callout.end - c >= MIN_SHOW) p.callout.start = c;
      else if (said < c && c - p.callout.start >= MIN_SHOW) p.callout.end = c;
      else { p.callout.cut = c; break; }
    }
  }
  const q = t => Math.round(t * MATTE_FPS) / MATTE_FPS; // snap to the matte frame grid so offsets are exact
  const wins = job.phrases.flatMap((p, phrase) => {
    if (!p.callout) return [];
    const start = q(p.callout.start), duration = Math.max(q(p.callout.end) - start, 1 / MATTE_FPS);
    // "modnet" in the name: cut-outs cached by an older model (u2net, which lost heads) are never reused
    return [{ phrase, start, duration, src: `subject-modnet-${start.toFixed(3)}-${duration.toFixed(3)}.webm` }];
  });
  const todo = [];
  for (const w of wins) if (job.phrases[w.phrase].callout.cut === undefined && !(await exists(join(dir, w.src)))) todo.push(w);

  let failure;
  if (todo.length) {
    const mask = join(dir, '.matte-mask.mkv');
    const select = todo.map(w => `between(t,${w.start},${(w.start + w.duration - 0.001).toFixed(3)})`).join('+');
    try {
      await matteVideo(join(dir, job.input), `fps=${MATTE_FPS},select='${select}',setpts=N/(${MATTE_FPS}*TB)`,
        modelSize(meta.width, meta.height), MATTE_FPS, mask);
      let offset = 0;
      for (const w of todo) {
        // the 512 px matte is upscaled onto full-resolution frames; a light blur hides the stair-stepping
        await run('ffmpeg', ['-y', '-v', 'error', '-ss', `${w.start}`, '-t', `${w.duration}`, '-i', join(dir, job.input),
          '-ss', `${offset}`, '-t', `${w.duration}`, '-i', mask, '-filter_complex',
          `[1:v]format=gray,scale=${meta.width}:${meta.height}:flags=bicubic,gblur=sigma=2[a];[0:v]scale=${meta.width}:${meta.height}[v];[v][a]alphamerge,format=yuva420p`,
          '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '0', '-crf', '32', '-auto-alt-ref', '0',
          join(dir, w.src)]);
        offset += w.duration;
      }
    } catch (err) {
      failure = err.message.split('\n').find(Boolean) ?? 'unknown error';
      console.warn(`[matte] failed: ${failure}`);
    } finally {
      await rm(mask, { force: true });
    }
  }

  for (const w of wins) {
    const p = job.phrases[w.phrase], word = job.words[p.callout.idx].text;
    const sil = p.callout.cut === undefined && (await exists(join(dir, w.src))) ? await silhouette(join(dir, w.src)) : null;
    const reason = p.callout.cut !== undefined ? `the camera cuts to another shot at ${p.callout.cut.toFixed(1)}s, before it could be read`
      : !sil ? `the speaker cut-out failed (${failure ?? 'no output'})`
      : !sil.head ? 'no person was found in the frame'
      : sil.head.top > HEAD_TOO_LOW ? `the head is too low in the frame (${Math.round(sil.head.top * 100)}% down)`
      : sil.head.top < HEAD_TOO_HIGH ? 'the head reaches the top of the frame, so there is no room for a word behind it'
      : unsteady(sil);
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
 * Camera cuts, in seconds of the input's own timeline: ffmpeg's scene score on small frames. A flash or a
 * whip pan can score like a cut, so cuts closer than half a second to each other or to the ends are dropped.
 */
const CUT_SCORE = 0.3;
async function findCuts(file, { duration, startTime }) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-an', '-vf',
    `scale=160:-2,select='gt(scene,${CUT_SCORE})',showinfo`, '-f', 'null', '-'], { maxBuffer: 1 << 24 });
  const out = [];
  for (const [, t] of stderr.matchAll(/pts_time:([\d.]+)/g)) {
    const s = Number(t) - startTime;
    if (s > 0.5 && s < duration - 0.5 && (!out.length || s - out.at(-1) >= 0.5)) out.push(Number(s.toFixed(3)));
  }
  return out;
}

/**
 * UGC layout: any video wider than 9:16 becomes a 1080×1920 vertical frame, cropped around the speaker.
 * The head is located twice a second with the cut-out model on small frames (about 40 ms a frame),
 * and the crop follows it like a camera operator would (see follow.js): still while the speaker stays
 * near the middle, a smooth capped pan when the camera or the speaker drifts, a jump on a camera cut.
 * A fixed crop put the reference interview's speaker at the frame edge after a slow pan. Mostly close-ups
 * (head cut by the top edge), or nobody found, fit the whole frame over a blurred fill instead.
 * Returns an ffmpeg filter, or null when the video is already vertical.
 */
const UGC = [1080, 1920];
async function reframe(job) {
  const { width: W, height: H, duration, startTime } = job.meta;
  if (H / W >= 1.7) return null; // already 9:16 (or taller)
  const cw = Math.min(W, Math.round((H * 9) / 16 / 2) * 2);
  // fit: the whole frame across the middle, a blurred, darkened copy filling above and below
  const fit = `split[a][b];[a]scale=${UGC[0]}:${UGC[1]}:force_original_aspect_ratio=increase,crop=${UGC[0]}:${UGC[1]},boxblur=24,eq=brightness=-0.12[bg];`
    + `[b]scale=${UGC[0]}:-2:flags=lanczos[fg];[bg][fg]overlay=0:(H-h)/2,setsar=1`;
  try {
    // twice a second: at once a second a quick reframe by the camera read as a jump to another person
    const step = 0.5, size = modelSize(W, H, 256);
    const samples = [];
    await matteFrames(join(job.dir, job.input), `fps=${1 / step}`, size, (m, k) => {
      const h = headOf(contourOf(m, ...size));
      samples.push({ t: k * step, centre: h ? (h.left + h.right) / 2 : null, top: h?.top });
    });
    const found = samples.filter(s => s.centre != null);
    if (found.length < 3) throw new Error('no person found');
    // a video that is mostly close-up (head cut by the top of the frame) cropped to 9:16 is just an
    // enlarged face with no room above the head for a callout: fit the whole frame instead
    const top = found.map(s => s.top).sort((a, b) => a - b)[found.length >> 1];
    if (top < 0.04) {
      job.reframe = { mode: 'fit', reason: 'close-up', top };
      return fit;
    }
    const times = samples.map(s => s.t);
    const keys = follow(times, track(samples, job.cuts), job.cuts, cw / W);
    const x = cropX(keys.map(k => ({ ...k, t: k.t + startTime })), W, cw); // crop's t is the input's own clock
    job.reframe = { mode: 'crop', width: cw, top, keys, moves: keys.length - 1, samples };
    return `crop=w=${cw}:h=${H}:x='${x}':y=0,scale=${UGC[0]}:${UGC[1]}:flags=lanczos,setsar=1`;
  } catch (err) {
    const reason = err.message.split('\n')[0];
    job.warnings.push({ kind: 'reframe', reason,
      message: `Couldn't find the speaker to frame the 9:16 crop (${reason}), so the whole frame is shown over a blurred fill.` });
    job.reframe = { mode: 'fit', reason };
    return fit;
  }
}

// hyperframes pins one capture worker on machines with 8 GB or less. Measured on one (20 s clip):
// 1 worker 230 s, 3 workers 104 s, 4 workers 110 s and only 0.3 GB left free. Each worker costs about
// 0.65 GB, so as many as fit in the memory free right now, with 1 GB spare, up to 3. Parallel capture on
// a busy 8 GB machine can still time out loading the page, so a failed parallel render is resumed with
// one worker: the segments it finished are kept, and the result is never worse than before
async function render(job, emit) {
  const workers = Math.max(1, Math.min(3, Math.floor((freemem() / 2 ** 30 - 1) / 0.65)));
  try {
    await renderWith(job, emit, workers);
  } catch (err) {
    if (workers === 1) throw err;
    console.warn(`[render] ${workers} workers failed (${err.message.split('\n').at(-1).slice(0, 200)}), resuming with 1`);
    await renderWith(job, emit, 1, true);
  }
}

function renderWith(job, emit, workers, resume = false) {
  return new Promise((ok, fail) => {
    // clips over 20 s are captured in 10 s segments with a fresh browser each: one long-lived Chrome decoding
    // the source and every cut-out grows until an 8 GB machine stalls (the 50 s reference stalled ~frame 750)
    const env = { ...HF_ENV, HF_SEGMENTED_CAPTURE: 'true', HF_SEGMENTED_MIN_SECONDS: '20', HF_SEGMENT_FRAMES: '300', HF_SEGMENT_BROWSER_RECYCLE: '1' };
    const p = spawn(process.execPath, [...HF_CLI, 'render', job.dir, '-o', join(job.dir, 'output.mp4'), '--quality', 'delivery',
      '--browser-timeout', '180', ...(workers > 1 ? ['--workers', `${workers}`, '--no-low-memory-mode'] : []), ...(resume ? ['--resume'] : [])], { env });
    emit({ step: 'render', status: 'running', progress: 0, workers });
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

/** Word timestamps for the job's audio.mp3, from the cheapest source that has them. */
async function transcribeAudio(job) {
  // 1. a transcript shipped next to the video (samples, test clips): no key, no credits
  if (job.transcriptFile) return JSON.parse(await readFile(job.transcriptFile, 'utf8'));
  // 2. cache by content hash + everything that changes the result: same request never pays twice
  const req = JSON.stringify([pickProvider(undefined, job.apiKey), job.language ?? null, [...(job.keyterms ?? [])].sort()]);
  const key = createHash('sha256').update(await sha256(join(job.dir, 'audio.mp3'))).update(req).digest('hex');
  const cached = join(CACHE, `${key}.json`);
  const hit = await readFile(cached, 'utf8').then(JSON.parse, () => null);
  if (hit) return hit;
  // 3. the API, behind a spending guard
  await guardCredits(job.meta.duration, job.allowLong);
  const t = await transcribe(join(job.dir, 'audio.mp3'), { language: job.language, keyterms: job.keyterms, apiKey: job.apiKey });
  await mkdir(CACHE, { recursive: true });
  await writeFile(cached, JSON.stringify(t));
  job.usage = await logUsage(job.meta.duration, pickProvider(undefined, job.apiKey));
  return t;
}

/** Creates a job folder. `source` is copied in unless the caller already wrote `input<ext>` there. */
export async function createJob({ id, ext, styleName = 'default', custom, source, language, keyterms, transcriptFile, allowLong, layout, apiKey }) {
  const dir = join(JOBS, id);
  await mkdir(dir, { recursive: true });
  const input = `input${ext}`;
  if (source) await copyFile(source, join(dir, input));
  const style = customizeStyle(await loadStyle(styleName), custom);
  return { id, dir, input, styleName, style, custom, language, keyterms, transcriptFile, allowLong, apiKey, layout: layout ?? style.layout ?? 'original', state: null };
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
        [, job.cuts] = await Promise.all([
          run('ffmpeg', ['-y', '-v', 'error', '-i', join(job.dir, job.input), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', join(job.dir, 'audio.mp3')]),
          findCuts(join(job.dir, job.input), job.meta),
        ]);
        // transcription only needs the audio: it runs while the video is reframed and re-encoded
        if (steps.includes('transcribe')) (job.transcript = transcribeAudio(job)).catch(() => {}); // awaited in its own step
        const crop = job.layout === '9:16' ? await reframe(job) : null;
        // normalise once: H.264 with a keyframe every second seeks frame-accurately in the renderer and
        // plays in every browser preview (phone HEVC / sparse-keyframe uploads otherwise freeze)
        await run('ffmpeg', ['-y', '-v', 'error', '-i', join(job.dir, job.input), ...(crop ? ['-vf', crop] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
          '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', join(job.dir, 'source.mp4')]);
        job.input = 'source.mp4';
        if (crop) job.meta = { ...job.meta, width: UGC[0], height: UGC[1] };
      }
      if (step === 'transcribe') {
        const t = await (job.transcript ?? transcribeAudio(job));
        delete job.transcript;
        let words = t.words.map(w => ({ ...w })); // the cached transcript stays as transcribed
        // Hindi may come back in Devanagari; Hinglish reels are captioned in Latin script
        if (words.some(w => hasDevanagari(w.text))) romanizeWords(words);
        words = tidyWords(words); // no "uh", no "m-moved"
        if (!words.length) throw new Error('no speech found in this video');
        job.words = spreadTimes(words);
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
        // a callout lives as long as its phrase (hard cut in and out), and never less than the reference's
        // shortest (0.9 s): with a fast talker the phrase is gone in 0.5 s and the word would only flash
        if (job.style.callout) {
          const starts = job.phrases.filter(p => p.wordIdx.some(i => job.words[i].role === 'callout')).map(p => p.start);
          for (const p of job.phrases) {
            const idx = p.wordIdx.find(i => job.words[i].role === 'callout');
            if (idx === undefined) continue;
            const next = starts.find(s => s > p.start) ?? job.meta.duration;
            p.callout = { idx, start: p.start, end: Math.max(p.end, Math.min(p.start + (job.style.callout.minHold ?? 0), next, job.meta.duration)) };
          }
        }
        await writeFile(join(job.dir, 'transcript.json'), JSON.stringify({ words: job.words, phrases: job.phrases, cuts: job.cuts }, null, 1));
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
export async function loadJob(dir, { styleName = 'default', keyterms, layout } = {}) {
  const { words, cuts = [] } = JSON.parse(await readFile(join(dir, 'transcript.json'), 'utf8'));
  spreadTimes(words);
  const style = await loadStyle(styleName);
  return { id: dir.split(/[\/]/).at(-1), dir, input: 'source.mp4', styleName, style, keyterms, words, cuts,
    layout: layout ?? style.layout ?? 'original', meta: await probe(join(dir, 'source.mp4')), state: null };
}
