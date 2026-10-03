import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignRoles } from './roles.js';
import { chunk } from './chunk.js';

const speak = text => text.split(' ').map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.3 }));
const roles = words => words.filter(w => w.role).map(w => `${w.text}:${w.role}`);

test('hinglish: function words never chosen, content words are', () => {
  const w = speak('Bilkul premium black Obsidian aur lapis lazuli. Uska rashi hai Meen yaani Pisces.');
  assignRoles(w, chunk(w, { maxWords: 4 }));
  const r = roles(w);
  assert.ok(r.some(x => x.startsWith('Obsidian')), r.join(' '));
  for (const x of r) assert.ok(!/^(aur|hai|uska|yaani):/i.test(x), x);
});

test('callouts are spaced out and at most one per phrase', () => {
  const w = speak(Array.from({ length: 20 }, () => 'Wonderful Celebration Beautiful').join(' '));
  const phrases = chunk(w, { maxWords: 3 });
  assignRoles(w, phrases, { calloutGap: 6 });
  const times = w.filter(x => x.role === 'callout').map(x => x.start);
  for (let k = 1; k < times.length; k++) assert.ok(times[k] - times[k - 1] >= 6);
  for (const p of phrases) assert.ok(p.wordIdx.filter(i => w[i].role === 'callout').length <= 1);
});

test('callouts can be disabled per style', () => {
  const w = speak('So today Obsidian Celebration really wonderful');
  assignRoles(w, chunk(w), { callout: false });
  assert.ok(!w.some(x => x.role === 'callout'));
});

test('short or stopword-only phrases get nothing', () => {
  const w = speak('ye dekho. hai na');
  assignRoles(w, chunk(w));
  assert.deepEqual(roles(w), []);
});
