import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FONTS, customizeStyle, loadStyle } from './pipeline.js';

const base = await loadStyle('default');

test('no overrides: the default style, untouched and not shared', () => {
  const s = customizeStyle(base);
  assert.deepEqual(s, base);
  assert.notEqual(s, base);
});

test('highlight colour drives the active word and its box', () => {
  const s = customizeStyle(base, { accent: '#FF4D6D' });
  assert.equal(s.colors.active, '#ff4d6d');
  assert.equal(s.highlight.on, 'rgba(255,77,109,0.30)');
  assert.equal(s.highlight.off, 'rgba(255,77,109,0)');
  assert.equal(base.colors.active, '#fee300'); // the base style is not mutated
});

test('font swaps the caption line only, with its measured width', () => {
  const s = customizeStyle(base, { font: 'inter' });
  assert.deepEqual(s.fonts, ['inter/700', 'anton/400']); // keywords and callouts keep Anton
  assert.equal(s.lineFamily, 'Inter');
  assert.equal(s.charWidth, FONTS.inter.charWidth);
});

test('words behind the speaker can be turned off', () => {
  assert.ok(customizeStyle(base, { behind: true }).callout);
  assert.equal(customizeStyle(base, { behind: false }).callout, undefined);
});

test('bad input is refused with a 400', () => {
  for (const bad of [{ accent: 'red' }, { accent: '#fee30' }, { accent: '#fee300;}' }, { font: 'comic-sans' }, { font: '../x' }])
    assert.throws(() => customizeStyle(base, bad), e => e.status === 400, JSON.stringify(bad));
});
