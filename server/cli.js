// Headless batch mode: npm run caption -- a.mp4 b.mov --style eclipse --out out/
import { copyFile, mkdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createJob, listStyles, runJob } from './pipeline.js';

const { values: o, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    style: { type: 'string', default: 'eclipse' },
    out: { type: 'string', default: 'out' },
    language: { type: 'string' },
    keyterms: { type: 'string' },
    'no-render': { type: 'boolean', default: false }, // stop after compose: inspect with `hyperframes snapshot`
  },
});

if (!files.length) {
  console.log(`usage: npm run caption -- <video...> [--style ${(await listStyles()).join('|')}] [--out dir] [--language en] [--keyterms "Glido,FramesNFlights"] [--no-render]`);
  process.exit(1);
}

await mkdir(o.out, { recursive: true });
let failed = 0;
for (const file of files) {
  const name = basename(file, extname(file));
  const t0 = Date.now();
  try {
    const job = await createJob({
      id: `${name}-${t0}`, ext: extname(file).toLowerCase(), styleName: o.style, source: file,
      language: o.language, keyterms: o.keyterms?.split(',').map(s => s.trim()),
    });
    await runJob(job, e => process.stdout.write(`\r${name}: ${e.step} ${e.progress != null ? `${e.progress}%` : e.status}`.padEnd(60)),
      'audio', o['no-render'] ? 'compose' : 'render');
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
