import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import { macTranslations, macLocalNetworkDescriptions } from '../apps/mac/translations.mjs';

test('Mac supplies the same complete copy and native network permission in all three languages', () => {
  const keys = Object.keys(macTranslations.en).sort();
  for (const language of /** @type {const} */ (['en', 'zh-Hans', 'ja'])) {
    assert.deepEqual(Object.keys(macTranslations[language]).sort(), keys);
    assert.ok(Object.values(macTranslations[language]).every(value => typeof value === 'string' && value.trim()));
    assert.ok(macLocalNetworkDescriptions[language]);
  }
  assert.equal(macTranslations.ja['Quit'], '終了');
  assert.equal(macTranslations.ja['Not verified yet'], '未検証');
});

/** @param {string} page @param {string[]} languages @param {string|null} [saved] */
async function website(page, languages, saved = null) {
  const window = new Window({ url: 'https://fixture.example/', settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  Object.defineProperty(window.navigator, 'languages', { value: languages, configurable: true });
  if (saved) window.localStorage.setItem('codelync-language', saved);
  const html = await readFile(new URL(`../website/${page}.html`, import.meta.url), 'utf8');
  window.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, ''));
  window.fetch = async () => new window.Response(null, { status: 404 });
  window.eval(await readFile(new URL('../website/language.js', import.meta.url), 'utf8'));
  if (page === 'index') {
    window.eval(await readFile(new URL('../website/japanese.js', import.meta.url), 'utf8'));
    window.eval(await readFile(new URL('../website/app.js', import.meta.url), 'utf8'));
  }
  return window;
}

test('website follows ordered system languages, honors saved overrides and returns to automatic mode', async () => {
  const window = await website('index', ['fr-FR', 'ja-JP']);
  try {
    assert.equal(window.document.documentElement.lang, 'ja');
    const status = window.document.getElementById('testflight-status'); assert.ok(status);
    assert.match(status.textContent ?? '', /近日公開/);
    const select = window.document.querySelector('select'); assert.ok(select);
    assert.equal(select.value, 'system');
    select.value = 'en'; select.dispatchEvent(new window.Event('change'));
    assert.equal(window.localStorage.getItem('codelync-language'), 'en');
    assert.equal(window.document.documentElement.lang, 'en');
    Object.defineProperty(window.navigator, 'languages', { value: ['zh-TW'], configurable: true });
    window.dispatchEvent(new window.Event('languagechange'));
    assert.equal(window.document.documentElement.lang, 'en');
    select.value = 'system'; select.dispatchEvent(new window.Event('change'));
    assert.equal(window.localStorage.getItem('codelync-language'), null);
    assert.equal(window.document.documentElement.lang, 'zh-CN');
    Object.defineProperty(window.navigator, 'languages', { value: ['ja-JP'], configurable: true });
    window.dispatchEvent(new window.Event('languagechange'));
    assert.equal(window.document.documentElement.lang, 'ja');
  } finally { await window.happyDOM.close(); }
});

test('privacy and support show only the selected language and use the same saved choice', async () => {
  for (const page of ['privacy', 'support']) {
    const window = await website(page, ['zh-CN'], 'ja');
    try {
      const blocks = /** @type {import('happy-dom').HTMLElement[]} */ ([...window.document.querySelectorAll('[data-language]')]);
      const visible = blocks.filter(block => !block.hidden);
      assert.equal(visible.length, 1); assert.equal(visible[0].dataset.language, 'ja');
      assert.equal(window.document.documentElement.lang, 'ja');
      assert.match(window.document.title, page === 'privacy' ? /プライバシー/ : /サポート/);
    } finally { await window.happyDOM.close(); }
  }
});
