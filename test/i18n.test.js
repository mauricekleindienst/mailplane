'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveLocale, translator, LOCALES } = require('../src/i18n');

test('system language picks a supported locale, else English', () => {
  assert.equal(resolveLocale('system', 'de-AT'), 'de');
  assert.equal(resolveLocale('system', 'fr-FR'), 'en');
  assert.equal(resolveLocale('en', 'de-DE'), 'en');
  assert.equal(resolveLocale('xx', 'de-DE'), 'en');
});

test('German: exact strings, folder nouns, patterns, whitespace kept', () => {
  const t = translator('de');
  assert.equal(t('Archive'), 'Archivieren');
  assert.equal(t('Archive', { folder: true }), 'Archiv');
  assert.equal(t('  Reply  '), '  Antworten  ');
  assert.equal(t('3 unread'), '3 ungelesen');
  assert.equal(t('Search Inbox · Alice'), 'Posteingang durchsuchen · Alice');
  assert.equal(t('Nothing matches “x” in Sent.'), 'Nichts passt zu „x“ in Gesendet.');
  assert.equal(t('Something only the user wrote'), 'Something only the user wrote');
});

test('English is the identity', () => {
  const t = translator('en');
  assert.equal(t('Archive'), 'Archive');
});

test('every German pattern keeps its placeholders', () => {
  for (const [src, dst] of LOCALES.de.patterns) {
    const names = s => (s.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(names(src), names(dst), src);
  }
});
