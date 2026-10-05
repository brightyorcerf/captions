// Re-run an existing job from a later step without re-transcribing or re-matting cached windows.
// usage: node tools/rerun.mjs jobs/<id> [from=chunk] [to=compose] [--keyterms Astrotalk]
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadJob, runJob } from '../server/pipeline.js';

const { values: o, positionals: [dir, from = 'chunk', to = 'compose'] } = parseArgs({ allowPositionals: true,
  options: { style: { type: 'string', default: 'eclipse' }, keyterms: { type: 'string' } } });
const job = await loadJob(resolve(dir), { styleName: o.style, keyterms: o.keyterms?.split(',') });
await runJob(job, e => process.stdout.write(`\r${e.step} ${e.progress != null ? `${e.progress}%` : e.status}`.padEnd(40)), from, to);
for (const w of job.warnings ?? []) console.warn(`\n⚠ ${w.message}`);
console.log(`\n✓ ${job.dir}`);
