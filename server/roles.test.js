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

test('latin-only callouts: english words and numbers, never romanised hindi, never repeated', () => {
  const t = (text, hi) => ({ text, hi, start: 0, end: 0 });
  const words = [t('intro'), t('words'), t('here'), t('mangwaya', true), t('crystals'), t('obsidian'), t('crystals'), t('12')];
  words.forEach((w, i) => { w.start = i * 4; });
  const phrases = [[0, 1, 2], [3, 4], [5], [6], [7]].map(wordIdx => ({ wordIdx }));
  assignRoles(words, phrases, { calloutMin: 8, calloutGap: 3, emphasisMin: 7, calloutLatinOnly: true });
  const callouts = words.filter(w => w.role === 'callout').map(w => w.text);
  assert.ok(!callouts.includes('mangwaya'));
  assert.equal(callouts.filter(c => c === 'crystals').length, 1);
  assert.ok(callouts.includes('12'));
});

test('brand names are in-line keywords, never callouts', () => {
  const w = speak('Maine Astrotalk Store se mangwaya. Bilkul premium Obsidian stones');
  assignRoles(w, chunk(w, { maxWords: 3 }), { keyterms: ['Astrotalk'], calloutMin: 8, calloutGap: 0 });
  assert.equal(w[1].role, 'emphasis');
});

test('every sentence gets a keyword, punctuated or separated by a pause', () => {
  const w = speak('Ye dekho mangwaya. kitna pyara lag raha hai yaar. so happy with this purchase');
  w.slice(-5).forEach(x => { x.start += 2; x.end += 2; }); // unpunctuated, after a pause
  const phrases = chunk(w, { maxWords: 3 });
  assignRoles(w, phrases, { callout: false });
  const sentences = [[0, 3], [3, 9], [9, 14]];
  for (const [a, b] of sentences) assert.ok(w.slice(a, b).some(x => x.role === 'emphasis'), w.slice(a, b).map(x => x.text).join(' '));
});
