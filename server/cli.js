// Headless batch mode: npm run caption -- a.mp4 b.mov --style eclipse --out out/
import { access, copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createJob, listStyles, runJob } from './pipeline.js';

const { values: o, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    style: { type: 'string', default: 'eclipse' },
    out: { type: 'string', default: 'out' },
    language: { type: 'string' },
    keyterms: { type: 'string' },
    layout: { type: 'string' }, // 9:16 (crop around the speaker) | original; default comes from the style
    yes: { type: 'boolean', default: false }, // allow sending more than MAX_STT_MINUTES to the paid API
    strict: { type: 'boolean', default: false }, // exit non-zero when a callout could not go behind the speaker
    'no-render': { type: 'boolean', default: false }, // stop after compose: inspect with `hyperframes snapshot`
  },
});

if (!files.length) {
  console.log(`usage: npm run caption -- <video...> [--style ${(await listStyles()).join('|')}] [--out dir] [--language en]
       [--keyterms "Glido,FramesNFlights"] [--layout 9:16|original] [--yes] [--strict] [--no-render]
A transcript next to the video (clip.transcript.json) is used instead of the API.`);
  process.exit(1);
}
if (o.layout && !['9:16', 'original'].includes(o.layout)) { console.error('--layout must be 9:16 or original'); process.exit(1); }

const exists = f => access(f).then(() => true, () => false);
await mkdir(o.out, { recursive: true });
let failed = 0;
for (const file of files) {
  const name = basename(file, extname(file));
  const sidecar = join(dirname(file), `${name}.transcript.json`);
  const t0 = Date.now();
  try {
    const job = await createJob({
      id: `${name}-${t0}`, ext: extname(file).toLowerCase(), styleName: o.style, source: file,
      language: o.language, keyterms: o.keyterms?.split(',').map(s => s.trim()),
      transcriptFile: (await exists(sidecar)) ? sidecar : undefined, allowLong: o.yes, layout: o.layout,
    });
    await runJob(job, e => process.stdout.write(`\r${name}: ${e.step} ${e.progress != null ? `${e.progress}%` : e.status}`.padEnd(60)),
      'audio', o['no-render'] ? 'compose' : 'render');
    if (job.reframe) console.log(job.reframe.mode === 'crop'
      ? `\n↳ 9:16: cropped ${job.reframe.width}px wide at x=${job.reframe.x}, speaker at ${Math.round(job.reframe.centre * 100)}% of the width`
      : `\n↳ 9:16: whole frame over a blurred fill (${job.reframe.reason})`);
    for (const w of job.warnings ?? []) console.warn(`\n⚠ ${w.message}`);
    if (o.strict && job.warnings?.length) throw new Error(`${job.warnings.length} warning(s) with --strict`);
    if (o['no-render']) { console.log(`\n✓ composed ${job.dir}`); continue; }
    const dest = join(o.out, `${name}.${o.style}.mp4`);
    await copyFile(join(job.dir, 'output.mp4'), dest);
    console.log(`\n✓ ${dest}  (${job.meta.duration.toFixed(1)}s video, ${job.phrases.length} phrases, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  } catch (err) {
    failed++;
    console.error(`\n✗ ${file}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
