// Person segmentation with MODNet (portrait matting, Apache-2.0), run in-process with onnxruntime.
// Replaces hyperframes' u2net_human_seg: ~5x faster on CPU (130 vs 700 ms a frame) and, being trained on
// people framed head to waist, it keeps the head solid where u2net lost it for whole stretches.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODEL = {
  url: 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx',
  sha256: '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9',
  file: join(homedir(), '.cache', 'captions', 'modnet.onnx'),
};

/** Downloads the model once (25 MB) and checks it against the pinned hash. */
async function modelPath() {
  const ok = async () => createHash('sha256').update(await readFile(MODEL.file)).digest('hex') === MODEL.sha256;
  if (await ok().catch(() => false)) return MODEL.file;
  await mkdir(join(MODEL.file, '..'), { recursive: true });
  const tmp = `${MODEL.file}.${process.pid}.part`;
  const res = await fetch(MODEL.url);
  if (!res.ok) throw new Error(`could not download the cut-out model (${res.status})`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, MODEL.file);
  if (!(await ok())) { await rm(MODEL.file, { force: true }); throw new Error('the downloaded cut-out model failed its checksum'); }
  return MODEL.file;
}

let session;
const load = () => (session ??= (async () => {
  const ort = await import('onnxruntime-node');
  return { ort, s: await ort.InferenceSession.create(await modelPath()) };
})().catch(err => { session = undefined; throw err; }));

/** Model input size for a frame shape: long side `long` (MODNet's own is 512), both sides multiples of 32 (its stride). */
export function modelSize(width, height, long = 512) {
  const k = long / Math.max(width, height), r = v => Math.max(32, Math.round((v * k) / 32) * 32);
  return [r(width), r(height)];
}

/** One RGB frame (w×h×3 bytes) -> its matte (w×h bytes, 255 = person). */
async function matteFrame({ ort, s }, rgb, w, h) {
  const n = w * h, x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) x[c * n + i] = rgb[i * 3 + c] / 127.5 - 1;
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, h, w]) });
  const m = out[s.outputNames[0]].data, a = Buffer.alloc(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(Math.min(1, Math.max(0, m[i])) * 255);
  return a;
}

/**
 * Mattes every frame ffmpeg's filter `vf` yields from `input` (which must end at w×h) and hands each matte to
 * `onFrame(matte, index)`. Frames stream through: a long video never sits in memory.
 */
export async function matteFrames(input, vf, [w, h], onFrame) {
  const model = await load();
  // passthrough: frames dropped by a select filter must not be refilled with duplicates
  const ff = spawn('ffmpeg', ['-v', 'error', '-i', input, '-an', '-vf', `${vf},scale=${w}:${h}`, '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  let err = '';
  ff.stderr.on('data', d => { err += d; });
  const exited = new Promise(ok => ff.on('close', ok));
  const size = w * h * 3;
  let buf = Buffer.alloc(0), k = 0;
  try {
    for await (const chunk of ff.stdout) {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= size) {
        await onFrame(await matteFrame(model, buf.subarray(0, size), w, h), k++);
        buf = buf.subarray(size);
      }
    }
  } catch (e) {
    ff.kill();
    throw e;
  }
  const code = await exited;
  if (code !== 0) throw new Error(`ffmpeg failed (exit ${code}): ${err.trim().split('\n').pop() || 'no error output'}`);
  return k;
}

/** Like matteFrames, but writes the mattes as a lossless greyscale video at `fps`. */
export async function matteVideo(input, vf, size, fps, output) {
  const enc = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', size.join('x'), '-r', `${fps}`, '-i', '-', '-c:v', 'ffv1', output]);
  let err = '';
  enc.stderr.on('data', d => { err += d; });
  const exited = new Promise(ok => enc.on('close', ok));
  enc.stdin.on('error', () => {}); // a dead encoder is reported by its exit code below
  try {
    await matteFrames(input, vf, size, m => new Promise(ok => (enc.stdin.write(m) ? ok() : enc.stdin.once('drain', ok))));
  } finally {
    enc.stdin.end();
  }
  const code = await exited;
  if (code !== 0) throw new Error(`ffmpeg failed (exit ${code}): ${err.trim().split('\n').pop() || 'no error output'}`);
}
