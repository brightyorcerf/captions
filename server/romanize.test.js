import { test } from 'node:test';
import assert from 'node:assert/strict';
import { romanize, romanizeWords, hasDevanagari } from './romanize.js';

test('common hinglish words use creator spellings', () => {
  assert.equal(romanize('मैंने'), 'maine');
  assert.equal(romanize('में'), 'mein');
  assert.equal(romanize('है।'), 'hai.');
  assert.equal(romanize('नहीं,'), 'nahi,');
});

test('rule-based words: matras, conjuncts, schwa deletion, nasals', () => {
  assert.equal(romanize('पहली'), 'pahli');
  assert.equal(romanize('बार'), 'bar');
  assert.equal(romanize('राशि'), 'rashi');
  assert.equal(romanize('क्रिस्टल'), 'kristal');
  assert.equal(romanize('मंगवाया'), 'mangwaya');
  assert.equal(romanize('वालों'), 'walon');
  assert.equal(romanize('समझ'), 'samajh');
});

test('sentence starts are capitalised, latin words untouched', () => {
  const w = ['मैंने', 'life', 'में', 'crystals', 'देखे।', 'ये', 'देखो'].map(text => ({ text }));
  assert.deepEqual(romanizeWords(w).map(x => x.text), ['Maine', 'life', 'mein', 'crystals', 'dekhe.', 'Ye', 'dekho']);
  assert.ok(!w.some(x => hasDevanagari(x.text)));
});
