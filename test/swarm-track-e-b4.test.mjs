import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { parseReleaseFlags, prepareMacRelease } from '../scripts/prepare-mac-release.mjs';

test('R035: static pages sync language.js?v= SHA-256, localize header nav aria-label, and unify brand accessibility', async () => {
  const languageSource = await readFile(new URL('../website/language.js', import.meta.url), 'utf8');
  const expectedRevision = createHash('sha256').update(languageSource).digest('hex').slice(0, 16);

  for (const page of ['index', 'privacy', 'support']) {
    const html = await readFile(new URL(`../website/${page}.html`, import.meta.url), 'utf8');
    assert.ok(html.includes(`language.js?v=${expectedRevision}`), `${page}.html must reference language.js?v=${expectedRevision}`);

    const window = new Window({ url: 'https://fixture.example/', settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
    try {
      Object.defineProperty(window.navigator, 'languages', { value: ['en-US'], configurable: true });
      window.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, ''));
      /** @type {any} */ (window).fetch = async () => new window.Response(null, { status: 404 });
      window.eval(languageSource);

      const nav = window.document.querySelector('header nav');
      const select = /** @type {import('happy-dom').HTMLSelectElement | null} */ (window.document.getElementById('language'));
      assert.ok(nav && select);
      assert.equal(nav.getAttribute('aria-label'), 'Main navigation');

      select.value = 'zh';
      select.dispatchEvent(new window.Event('change'));
      assert.equal(nav.getAttribute('aria-label'), '主导航');

      select.value = 'ja';
      select.dispatchEvent(new window.Event('change'));
      assert.equal(nav.getAttribute('aria-label'), 'メインナビゲーション');

      const headerBrand = window.document.querySelector('header .brand');
      const footerBrand = window.document.querySelector('footer .brand');
      assert.equal(headerBrand?.getAttribute('aria-label'), 'Codelync');
      assert.equal(footerBrand?.getAttribute('aria-label'), 'Codelync');
      assert.ok(footerBrand?.querySelector('img[src="assets/icon.png"]'));
      assert.equal(footerBrand?.querySelector('span')?.textContent, 'Codelync');
    } finally {
      await window.happyDOM.close();
    }
  }
});

test('R040: parseReleaseFlags validates optional --source-commit and prepareMacRelease rejects symlinked app or notary status', async () => {
  const commit = 'a'.repeat(40);
  const parsed = parseReleaseFlags([
    '--app', '/tmp/Codelync.app',
    '--notary-status', '/tmp/notary.json',
    '--output', '/tmp/out',
    '--team', 'TEAM123456',
    '--source-commit', commit
  ]);
  assert.equal(parsed.sourceCommit, commit);

  assert.throws(() => parseReleaseFlags([
    '--app', '/tmp/Codelync.app',
    '--notary-status', '/tmp/notary.json',
    '--output', '/tmp/out',
    '--team', 'TEAM123456',
    '--source-commit', 'NOT-VALID'
  ]), /40-character lowercase hex/);

  assert.throws(() => parseReleaseFlags([
    '--app', '/tmp/Codelync.app',
    '--notary-status', '/tmp/notary.json',
    '--output', '/tmp/out',
    '--team', 'TEAM123456',
    '--unknown', 'x'
  ]), /optional --source-commit/);

  const dir = await mkdtemp(join(tmpdir(), 'codelync-r040-'));
  try {
    const realApp = join(dir, 'Real.app');
    const symlinkApp = join(dir, 'Codelync.app');
    const notaryFile = join(dir, 'notary.json');
    const symlinkNotary = join(dir, 'notary-link.json');
    await mkdir(join(realApp, 'Contents'), { recursive: true });
    await symlink(realApp, symlinkApp);
    await writeFile(notaryFile, JSON.stringify({ status: 'Accepted', id: 'n1' }));
    await symlink(notaryFile, symlinkNotary);

    await assert.rejects(
      () => prepareMacRelease({ appPath: symlinkApp, notaryStatusPath: notaryFile, outputDir: join(dir, 'out'), team: 'TEAM123456' }),
      /not a symlink/
    );

    await assert.rejects(
      () => prepareMacRelease({ appPath: realApp, notaryStatusPath: symlinkNotary, outputDir: join(dir, 'out'), team: 'TEAM123456' }),
      /not a symlink/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
