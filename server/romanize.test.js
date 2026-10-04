import { test } from 'node:test';
import assert from 'node:assert/strict';
import { romanize, romanizeWords, hasDevanagari } from './romanize.js';

test('common hinglish words use creator spellings', () => {
  assert.equal(romanize('मैंने'), 'maine');
  assert.equal(romanize('में'), 'mein');
  assert.equal(romanize('है।'), 'hai.');
  assert.equal(romanize('नहीं,'), 'nahi,');
});

test('a danda after a dictionary word still uses the dictionary', () => {
  assert.equal(romanize('लिए।'), 'liye.');
  assert.equal(romanize('यार।'), 'yaar.');
});

test('rule-based words: matras, conjuncts, schwa deletion, nasals', () => {
  assert.equal(romanize('राशि'), 'rashi');
  assert.equal(romanize('क्रिस्टल'), 'kristal');
  assert.equal(romanize('मंगवाया'), 'mangwaya');
  assert.equal(romanize('वालों'), 'walon');
  assert.equal(romanize('समझ'), 'samajh');
});

test('long vowels, closed monosyllables, silent h and vowel clusters', () => {
  assert.equal(romanize('पहली'), 'pehli');   // a before silent h -> e
  assert.equal(romanize('रहना'), 'rehna');
  assert.equal(romanize('रहा'), 'raha');     // h keeps its vowel: unchanged
  assert.equal(romanize('बार'), 'baar');     // closed monosyllable: long aa
  assert.equal(romanize('बात'), 'baat');
  assert.equal(romanize('था'), 'tha');       // open: stays short
  assert.equal(romanize('मीन'), 'meen');     // long i/u inside a word: ee/oo
  assert.equal(romanize('दूसरा'), 'doosra');
  assert.equal(romanize('यानी'), 'yani');    // ...but i/u at the end of a word
  assert.equal(romanize('भाई'), 'bhai');     // vowel after a vowel
  assert.equal(romanize('हुआ'), 'hua');
  assert.equal(romanize('हुए'), 'hue');
  assert.equal(romanize('आएगा'), 'aayega');
});

// every Hindi word of the Eclipse reference reel, spelled as its burned-in captions spell it
test('matches the reference reel', () => {
  const ref = {
    'मैंने': 'maine', 'में': 'mein', 'पहली': 'pehli', 'बार': 'baar', 'मंगवाया': 'mangwaya', 'और': 'aur', 'वो': 'wo',
    'भी': 'bhi', 'से': 'se', 'ना': 'na', 'धनु': 'dhanu', 'राशि': 'rashi', 'था': 'tha', 'अपने': 'apne', 'लिए': 'liye',
    'भाई': 'bhai', 'यह': 'ye', 'कितना': 'kitna', 'प्यारा': 'pyara', 'रहा': 'raha', 'है': 'hai', 'यार': 'yaar',
    'बिल्कुल': 'bilkul', 'हैं': 'hain', 'इनके': 'inke', 'तो': 'to', 'दूसरा': 'doosra', 'के': 'ke', 'उसका': 'uska',
    'मीन': 'meen', 'देखो': 'dekho', 'लगे': 'lage', 'हुए': 'hue', 'जो': 'jo', 'उन्हीं': 'unhi', 'वालों': 'walon',
    'बनाया': 'banaya', 'हुआ': 'hua', 'मस्त': 'mast', 'का': 'ka', 'ही': 'hi', 'नहीं': 'nahi', 'आएगा': 'aayega',
    'अगर': 'agar', 'आपको': 'aapko', 'मंगवाना': 'mangwana', 'आप': 'aap', 'मंगवा': 'mangwa', 'सकते': 'sakte',
    'हो': 'ho', 'क्योंकि': 'kyunki', 'उनकी': 'unki', 'सारे': 'sare', 'राशियों': 'rashiyon',
  };
  const wrong = Object.entries(ref).filter(([dev, lat]) => romanize(dev) !== lat).map(([dev, lat]) => `${dev}: ${romanize(dev)} != ${lat}`);
  assert.deepEqual(wrong, []);
});

test('sentence starts are capitalised, latin words untouched', () => {
  const w = ['मैंने', 'life', 'में', 'crystals', 'देखे।', 'ये', 'देखो'].map(text => ({ text }));
  assert.deepEqual(romanizeWords(w).map(x => x.text), ['Maine', 'life', 'mein', 'crystals', 'dekhe.', 'Ye', 'dekho']);
  assert.ok(!w.some(x => hasDevanagari(x.text)));
});
