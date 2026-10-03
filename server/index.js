// Plain node:http server: static UI, job API, SSE progress. No framework needed for six routes.
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { JOBS, ROOT, createJob, listStyles, runJob } from './pipeline.js';

const PORT = Number(process.env.PORT) || 3030;
const HOST = process.env.HOST || '127.0.0.1'; // local only unless you opt in
const MAX_UPLOAD = 1024 ** 3; // 1 GB
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};
const jobs = new Map(); // ponytail: in-memory, single process; a restart forgets jobs (files stay on disk)

const send = (res, code, body, type = 'application/json') =>
  res.writeHead(code, { 'content-type': type }).end(typeof body === 'string' ? body : JSON.stringify(body));

// Static files with Range support (the preview <video> needs it to seek)
async function serveFile(req, res, root, rel, extra = {}) {
  const file = normalize(join(root, rel));
  if (!file.startsWith(root + sep)) return send(res, 403, { error: 'forbidden' });
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) return send(res, 404, { error: 'not found' });
  const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store', ...extra };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : s.size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), s.size - 1) : s.size - 1;
    if (start > end || start < 0) return res.writeHead(416, { 'content-range': `bytes */${s.size}` }).end();
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${s.size}`, 'content-length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': s.size });
  createReadStream(file).pipe(res);
}

const start = (job, from) => runJob(job, job.emit, from).catch(err => console.error(`[job ${job.id}]`, err.message));

async function readJson(req, limit = 5e6) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > limit) throw new Error('body too large'); }
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('invalid json'), { status: 400 }); }
}

const routes = {
  'GET /api/styles': async (req, res) => send(res, 200, await listStyles()),

  'GET /api/samples': async (req, res) =>
    send(res, 200, (await readdir(join(ROOT, 'samples/output')).catch(() => [])).filter(f => f.endsWith('.mp4')).sort()),

  // Raw body upload (no multipart parser needed): POST /api/jobs?name=clip.mp4&style=eclipse
  'POST /api/jobs': async (req, res, url) => {
    const ext = extname(url.searchParams.get('name') ?? '').toLowerCase();
    if (!VIDEO_EXT.has(ext)) return send(res, 415, { error: `unsupported file type "${ext}", use mp4, mov or webm` });
    if (Number(req.headers['content-length']) > MAX_UPLOAD) return send(res, 413, { error: 'file too large (1 GB max)' });
    const styleName = url.searchParams.get('style') || 'eclipse';
    if (!(await listStyles()).includes(styleName)) return send(res, 400, { error: `unknown style "${styleName}"` });

    const id = randomUUID();
    const job = await createJob({ id, ext, styleName, language: url.searchParams.get('language') || undefined,
      keyterms: url.searchParams.get('keyterms')?.split(',').map(s => s.trim()).filter(Boolean) });
    let size = 0;
    try {
      await pipeline(req, async function* (src) {
        for await (const c of src) { if ((size += c.length) > MAX_UPLOAD) throw new Error('file too large'); yield c; }
      }, createWriteStream(join(job.dir, job.input)));
    } catch (err) {
      await rm(job.dir, { recursive: true, force: true });
      return send(res, 413, { error: err.message });
    }
    job.listeners = new Set();
    job.emit = e => { for (const r of job.listeners) r.write(`data: ${JSON.stringify(e)}\n\n`); };
    jobs.set(id, job);
    start(job);
    send(res, 201, { id });
  },

  'GET /api/jobs/:id/events': (req, res, url, job) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    if (job.state) res.write(`data: ${JSON.stringify(job.state)}\n\n`);
    job.listeners.add(res);
    req.on('close', () => job.listeners.delete(res));
  },

  'GET /api/jobs/:id': (req, res, url, job) => send(res, 200, {
    state: job.state, meta: job.meta, words: job.words, phrases: job.phrases, style: job.styleName,
    previewUrl: `/jobs/${job.id}/index.html?preview`,
  }),

  // Edited transcript: re-chunk, re-compose, re-render. No transcription call.
  'PUT /api/jobs/:id/transcript': async (req, res, url, job) => {
    if (job.state?.status === 'running') return send(res, 409, { error: 'job is still running' });
    const { words } = await readJson(req);
    if (!Array.isArray(words) || words.length !== job.words?.length || words.some(w => typeof w?.text !== 'string' || !w.text.trim())
      || words.some(w => w.role != null && !['emphasis', 'callout'].includes(w.role)))
      return send(res, 400, { error: 'words must match the original transcript: non-empty text, role emphasis|callout or none' });
    words.forEach((w, i) => { // timings stay server-owned
      job.words[i].text = w.text.trim().slice(0, 60);
      if (w.role) job.words[i].role = w.role; else delete job.words[i].role;
    });
    start(job, 'chunk');
    send(res, 202, { ok: true });
  },

  'GET /api/jobs/:id/output.mp4': (req, res, url, job) =>
    serveFile(req, res, job.dir, 'output.mp4', { 'content-disposition': `attachment; filename="captioned-${job.styleName}.mp4"` }),
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const m = /^\/api\/jobs\/([\w-]+)(\/.*)?$/.exec(url.pathname);
    const key = `${req.method} ${m ? `/api/jobs/:id${m[2] ?? ''}` : url.pathname}`;
    if (routes[key]) {
      const job = m && jobs.get(m[1]);
      if (m && !job) return send(res, 404, { error: 'job not found' });
      return await routes[key](req, res, url, job);
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (url.pathname.startsWith('/samples/')) return serveFile(req, res, join(ROOT, 'samples'), url.pathname.slice(9));
    // composition files for the preview iframe (input video, index.html, captions.js …)
    const jm = /^\/jobs\/([\w-]+)\/([\w.-]+)$/.exec(url.pathname);
    if (jm) return jobs.has(jm[1]) ? serveFile(req, res, join(JOBS, jm[1]), jm[2]) : send(res, 404, { error: 'not found' });
    return serveFile(req, res, join(ROOT, 'web'), url.pathname === '/' ? 'index.html' : url.pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, err.status ?? 500, { error: err.message });
  }
}).listen(PORT, HOST, () => console.log(`eclipse captions → http://localhost:${PORT}`));

await mkdir(JOBS, { recursive: true });
