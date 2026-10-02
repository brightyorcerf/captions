import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, DEFAULTS } from './chunk.js';

// Build a transcript from text: 0.3s per word, `|` marks a 0.8s pause
function speak(text, rate = 0.3) {
  let t = 0;
  const words = [];
  for (const tok of text.split(/\s+/)) {
    if (tok === '|') { t += 0.8; continue; }
    words.push({ text: tok, start: t, end: t + rate * 0.8 });
    t += rate;
  }
  return words;
}

// Deterministic pseudo-random long transcript (~3 min of fast speech)
function longTalk(n) {
  const vocab = 'so we went to the market and it was honestly the best day of my life, right? then we flew home.'.split(' ');
  let seed = 7, t = 0;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: n }, (_, i) => {
    const w = { text: vocab[i % vocab.length], start: t, end: t + 0.12 + rnd() * 0.2 };
    t = w.end + (rnd() < 0.05 ? 0.6 : 0.02);
    return w;
  });
}

function invariants(words, phrases, o = DEFAULTS) {
  assert.deepEqual(phrases.flatMap(p => p.wordIdx), words.map((_, i) => i), 'every word exactly once, in order');
  for (const [i, p] of phrases.entries()) {
    assert.ok(p.wordIdx.length <= o.maxWords, `phrase ${i} has ${p.wordIdx.length} words`);
    const len = p.wordIdx.map(k => words[k].text).join(' ').length;
    assert.ok(len <= o.maxChars || p.wordIdx.length === 1, `phrase ${i} is ${len} chars`);
    assert.ok(p.end > p.start, `phrase ${i} has positive duration`);
    if (phrases[i + 1]) assert.ok(p.end <= phrases[i + 1].start, `phrase ${i} clears before the next one`);
  }
}

test('empty and single word', () => {
  assert.deepEqual(chunk([]), []);
  const w = speak('hello');
  assert.deepEqual(chunk(w).map(p => p.wordIdx), [[0]]);
});

test('10s clip: breaks on sentences and pauses', () => {
  const w = speak('This is Eclipse. It captions anything | no matter how long the video runs, really.');
  const p = chunk(w);
  invariants(w, p);
  const text = p.map(x => x.wordIdx.map(k => w[k].text).join(' '));
  assert.equal(text[0], 'This is Eclipse.');
  assert.ok(text.includes('It captions anything'), text.join(' / '));
});

test('fast talker never floods the screen', () => {
  const w = speak('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen', 0.12);
  invariants(w, chunk(w));
});

test('does not end a phrase on a weak word', () => {
  const w = speak('we walked all the way over to the old harbour market today');
  for (const p of chunk(w)) assert.notEqual(w[p.wordIdx.at(-1)].text, 'the');
});

test('no lone orphan after a forced split', () => {
  const w = speak('alpha bravo charlie delta echo foxtrot.');
  const sizes = chunk(w).map(p => p.wordIdx.length);
  assert.ok(sizes.every(n => n >= 2), JSON.stringify(sizes));
});

test('3 minute transcript holds every invariant', () => {
  const w = longTalk(700);
  assert.ok(w.at(-1).end > 150);
  invariants(w, chunk(w));
});

test('long silence clears the screen', () => {
  const w = [{ text: 'before', start: 0, end: 0.4 }, { text: 'after', start: 5, end: 5.4 }];
  const [a, b] = chunk(w);
  assert.ok(a.end < 1 && b.start === 5);
});
