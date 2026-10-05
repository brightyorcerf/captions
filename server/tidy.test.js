import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tidyWords, unstutter } from './tidy.js';

const say = text => text.split(' ').map((t, i) => ({ text: t, start: i * 0.3, end: i * 0.3 + 0.2 }));
const read = words => words.map(w => w.text).join(' ');

test('filler sounds are dropped, timing of the rest is kept', () => {
  const words = say('uh, doing it uh easily.');
  const out = tidyWords(words);
  assert.equal(read(out), 'doing it easily.');
  assert.deepEqual(out.map(w => w.start), [words[1].start, words[2].start, words[4].start]);
  assert.equal(read(words), 'uh, doing it uh easily.', 'input untouched');
});

test('a filler ending a sentence hands its full stop to the previous word', () => {
  assert.equal(read(tidyWords(say('the games, uh. Then we'))), 'the games. Then we');
  assert.equal(read(tidyWords(say('really? um. Then'))), 'really? Then');
});

test('a sentence that started with a filler starts with a capital', () => {
  assert.equal(read(tidyWords(say('Um, so we went. Uh, then'))), 'So we went. Then');
  assert.equal(read(tidyWords(say('and um so'))), 'and so');
});

test('stutters collapse, real hyphenated words stay', () => {
  assert.equal(unstutter('m-moved'), 'moved');
  assert.equal(unstutter('m-m-moved'), 'moved');
  assert.equal(unstutter('I-I'), 'I');
  assert.equal(unstutter('Th-the'), 'The');
  for (const w of ['fifty-five', 'so-so', 're-read', 'co-op', 'well-known', 'x-ray']) assert.equal(unstutter(w), w);
  assert.equal(read(tidyWords(say('because you m-moved,'))), 'because you moved,');
});
