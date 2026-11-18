import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { collectSigningTargets } from '../scripts/sign-mac-app.mjs';

const MACHO_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x00, 0x00, 0x00]);

test('R025: collectSigningTargets skips symlinks and orders inner binaries, bundles and main executables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r025-'));
  try {
    const app = join(dir, 'Codelync.app');
    await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
    await mkdir(join(app, 'Contents/Resources/runtime'), { recursive: true });
    await mkdir(join(app, 'Contents/Resources/LiveKit_LiveKit.bundle'), { recursive: true });
    await mkdir(join(app, 'Contents/PlugIns/Helper.bundle/Contents'), { recursive: true });
    await mkdir(join(app, 'Contents/Frameworks/LiveKitWebRTC.framework/Versions/A/Resources'), { recursive: true });

    const mainBinary = join(app, 'Contents/MacOS/Codelync');
    const nodeBinary = join(app, 'Contents/Resources/runtime/node');
    const frameworkBinary = join(app, 'Contents/Frameworks/LiveKitWebRTC.framework/Versions/A/LiveKitWebRTC');
    await writeFile(mainBinary, MACHO_MAGIC);
    await writeFile(nodeBinary, MACHO_MAGIC);
    await writeFile(frameworkBinary, MACHO_MAGIC);
    await writeFile(join(app, 'Contents/Resources/LiveKit_LiveKit.bundle/PrivacyInfo.xcprivacy'), '<plist/>');
    await writeFile(join(app, 'Contents/PlugIns/Helper.bundle/Contents/Info.plist'), '<plist/>');
    await writeFile(join(app, 'Contents/Frameworks/LiveKitWebRTC.framework/Versions/A/Resources/Info.plist'), '<plist/>');
    await symlink('A', join(app, 'Contents/Frameworks/LiveKitWebRTC.framework/Versions/Current'));
    await symlink('Versions/Current/Resources', join(app, 'Contents/Frameworks/LiveKitWebRTC.framework/Resources'));
    await symlink('Versions/Current/LiveKitWebRTC', join(app, 'Contents/Frameworks/LiveKitWebRTC.framework/LiveKitWebRTC'));

    const targets = await collectSigningTargets(app);
    assert.deepEqual(targets.mainBinaries, [mainBinary]);
    assert.equal(targets.innerBinaries.length, 2);
    assert.ok(targets.innerBinaries.includes(frameworkBinary));
    assert.ok(targets.innerBinaries.includes(nodeBinary));
    assert.deepEqual(targets.bundles, [
      join(app, 'Contents/Frameworks/LiveKitWebRTC.framework'),
      join(app, 'Contents/PlugIns/Helper.bundle')
    ].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b)));
    assert.ok(!targets.bundles.includes(join(app, 'Contents/Resources/LiveKit_LiveKit.bundle')));

    const signSource = await readFile(new URL('../scripts/sign-mac-app.mjs', import.meta.url), 'utf8');
    const innerIdx = signSource.indexOf('for (const binary of innerBinaries)');
    const bundleIdx = signSource.indexOf('for (const bundle of bundles)');
    const mainIdx = signSource.indexOf('for (const binary of mainBinaries)');
    const verifyDeepIdx = signSource.indexOf("['--verify', '--deep', '--strict', app]");
    const verifyTargetsIdx = signSource.indexOf("['--verify', '--strict', target]");
    assert.ok(innerIdx > 0 && bundleIdx > innerIdx && mainIdx > bundleIdx && verifyDeepIdx > mainIdx && verifyTargetsIdx > verifyDeepIdx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** @param {{ release?: unknown, beta?: unknown }} payloads */
async function loadWebsite({ release = null, beta = null } = {}) {
  const window = new Window({ url: 'https://fixture.example/', settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  Object.defineProperty(window.navigator, 'languages', { value: ['en-US'], configurable: true });
  /** @type {{ id: unknown, fn: Function, delay?: number }[]} */
  const timers = [];
  /** @type {unknown[]} */
  const cleared = [];
  let nextTimerId = 1;
  /** @type {any} */ (window).setTimeout = (/** @type {Function} */ fn, /** @type {number} */ delay) => {
    const id = nextTimerId++;
    timers.push({ id, fn, delay });
    return id;
  };
  /** @type {any} */ (window).clearTimeout = (/** @type {unknown} */ id) => {
    cleared.push(id);
  };
  /** @type {any} */ (window).fetch = async (/** @type {string} */ url) => {
    if (url === 'release.json' && release) return new window.Response(JSON.stringify(release), { status: 200 });
    if (url === 'testflight.json' && beta) return new window.Response(JSON.stringify(beta), { status: 200 });
    return new window.Response(null, { status: 404 });
  };
  const html = await readFile(new URL('../website/index.html', import.meta.url), 'utf8');
  window.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, ''));
  window.eval(await readFile(new URL('../website/language.js', import.meta.url), 'utf8'));
  window.eval(await readFile(new URL('../website/japanese.js', import.meta.url), 'utf8'));
  window.eval(await readFile(new URL('../website/app.js', import.meta.url), 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 20));
  return { window, timers, cleared };
}

test('R030: verifiedBeta fails closed when non-available status contains a non-null publicURL and shows verified available links across languages', async () => {
  const invalid = await loadWebsite({
    beta: {
      schemaVersion: 2,
      status: 'in-review',
      version: '1.9.2',
      build: '2026111702',
      appId: '6835734876',
      groupId: 'eaa4762f-309c-4938-882e-8f245c7e1c92',
      publicURL: 'https://testflight.apple.com/join/AbCd1234',
      externalApproved: false,
      externalGroupEnabled: true,
      externalGroupContainsBuild: true,
      publishedAt: '2026-11-17T09:12:32Z'
    }
  });
  try {
    const join = /** @type {import('happy-dom').HTMLElement | null} */ (invalid.window.document.getElementById('join-testflight'));
    assert.ok(join);
    assert.equal(join.hidden, true);
    assert.equal(join.getAttribute('href'), null);
  } finally {
    await invalid.window.happyDOM.close();
  }

  const available = await loadWebsite({
    beta: {
      schemaVersion: 2,
      status: 'available',
      version: '1.9.2',
      build: '2026111702',
      appId: '6835734876',
      groupId: 'eaa4762f-309c-4938-882e-8f245c7e1c92',
      publicURL: 'https://testflight.apple.com/join/AbCd1234',
      externalApproved: true,
      externalGroupEnabled: true,
      externalGroupContainsBuild: true,
      publishedAt: '2026-11-17T09:12:32Z'
    }
  });
  try {
    const join = /** @type {import('happy-dom').HTMLElement | null} */ (available.window.document.getElementById('join-testflight'));
    assert.ok(join);
    assert.equal(join.hidden, false);
    assert.equal(join.getAttribute('href'), 'https://testflight.apple.com/join/AbCd1234');
    const select = /** @type {import('happy-dom').HTMLSelectElement | null} */ (available.window.document.getElementById('language'));
    assert.ok(select);
    select.value = 'ja';
    select.dispatchEvent(new available.window.Event('change'));
    assert.equal(join.hidden, false);
    assert.match(available.window.document.getElementById('testflight-status')?.textContent ?? '', /TestFlight/);
  } finally {
    await available.window.happyDOM.close();
  }
});

test('R030: copy-hash uses aria-live, resets after timeout, and index.html app.js?v= matches SHA-256', async () => {
  const html = await readFile(new URL('../website/index.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../website/app.js', import.meta.url), 'utf8');
  const expectedRevision = createHash('sha256').update(appSource).digest('hex').slice(0, 16);
  assert.ok(html.includes(`app.js?v=${expectedRevision}`));

  const sha256 = 'a'.repeat(64);
  const { window, timers, cleared } = await loadWebsite({
    release: {
      version: '0.7.2',
      filename: 'Codelync-0.7.2-macos-arm64.zip',
      bytes: 10485760,
      sha256,
      notarization: 'Accepted',
      stapled: true,
      gatekeeperAccepted: true
    }
  });
  try {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: async () => {} },
      configurable: true
    });
    const copyButton = /** @type {import('happy-dom').HTMLButtonElement | null} */ (window.document.getElementById('copy-hash'));
    assert.ok(copyButton);
    assert.equal(copyButton.disabled, false);
    assert.equal(copyButton.getAttribute('aria-live'), 'polite');
    assert.equal(copyButton.textContent, 'Copy checksum');

    copyButton.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(copyButton.textContent, 'Copied');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 2500);

    copyButton.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(cleared.includes(timers[0].id));
    assert.equal(timers.length, 2);

    timers[1].fn();
    assert.equal(copyButton.textContent, 'Copy checksum');
  } finally {
    await window.happyDOM.close();
  }
});
