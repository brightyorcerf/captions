// Times each pipeline step on one video: node --env-file-if-exists=.env tools/timeit.mjs <video> [--no-render]
// Uses the transcript cache like any run, so a video transcribed before costs no credits.
import { extname } from 'node:path';
import { createJob, runJob } from '../server/pipeline.js';

const [file, flag] = process.argv.slice(2);
const job = await createJob({ id: `timeit-${Date.now()}`, ext: extname(file).toLowerCase(), source: file });
let last = Date.now(), cur;
const t0 = last;
await runJob(job, e => {
  if (e.step === cur && e.status === 'running') return;
  if (cur) console.log(`${cur.padEnd(10)} ${((Date.now() - last) / 1000).toFixed(1)}s`);
  cur = e.status === 'running' ? e.step : null;
  last = Date.now();
}, 'audio', flag === '--no-render' ? 'compose' : 'render');
console.log(`total      ${((Date.now() - t0) / 1000).toFixed(1)}s  ${job.dir}`);
for (const w of job.warnings) console.log(`warning: ${w.message}`);
