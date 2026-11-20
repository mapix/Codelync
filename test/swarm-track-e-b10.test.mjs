import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractSwiftLocalizationKeys,
  isExpoBuildOnlyPicomatchAdvisory,
  validateMacLocalizationParity,
  validatePublicTestflightManifest
} from '../scripts/audit-public-release.mjs';

test('R095: docs align with 1.0.2/2026112001, three-Desktop scope, copy-update inputs, and R080/R085 tooling', async () => {
  const [pkgRaw, testflightRaw, buildDoc, releaseDoc, notifDoc, selfHostEn, selfHostZh] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../website/testflight.json', import.meta.url), 'utf8'),
    readFile(new URL('../docs/BUILD-AND-VERIFY.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/PUBLIC-RELEASE.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/NOTIFICATIONS.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/SELF-HOSTING.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/SELF-HOSTING.zh-CN.md', import.meta.url), 'utf8')
  ]);
  const pkg = JSON.parse(pkgRaw);
  const beta = JSON.parse(testflightRaw);
  assert.equal(pkg.version, '1.0.2');
  assert.equal(pkg.codelyncBuild, '2026112001');
  assert.ok(['1.0.0', '1.0.1', '1.0.2'].includes(beta.version));
  assert.match(beta.build, /^202611(?:1[78]|20)\d{2}$/);

  assert.match(buildDoc, /1\.0\.2/);
  assert.match(buildDoc, /2026112001/);
  assert.match(buildDoc, /pnpm security:release/);
  assert.match(buildDoc, /Codex, Antigravity Desktop and Claude Desktop \(Gateway\)/);

  assert.match(releaseDoc, /pnpm security:release/);
  assert.match(releaseDoc, /render-manifests\.py/);
  assert.match(releaseDoc, /site\/language\.js/);
  assert.match(releaseDoc, /site\/japanese\.js/);
  assert.match(releaseDoc, /site\/testflight\.json/);
  assert.doesNotMatch(releaseDoc, /only the four landing assets/);

  assert.match(notifDoc, /1\.0\.2/);
  assert.match(notifDoc, /2026112001/);
  assert.match(notifDoc, /Codex, Antigravity Desktop and Claude Desktop \(Gateway\)/);
  assert.match(notifDoc, /verify-mobile-push\.mjs/);

  assert.match(selfHostEn, /\.env`? key allowlist/i);
  assert.match(selfHostEn, /\.local/);
  assert.match(selfHostZh, /键名白名单/);
  assert.match(selfHostZh, /\.local/);
});

test('R100: validatePublicTestflightManifest validates website/testflight.json against schema and rejects violations', async () => {
  const valid = await validatePublicTestflightManifest();
  assert.equal(valid.schemaVersion, 2);
  assert.ok(['1.0.0', '1.0.1', '1.0.2'].includes(valid.version));
  assert.match(valid.build, /^202611(?:1[78]|20)\d{2}$/);

  const dir = await mkdtemp(join(tmpdir(), 'codelync-tf-schema-'));
  try {
    await mkdir(join(dir, 'website/schema'), { recursive: true });
    const schema = await readFile(new URL('../website/schema/testflight.schema.json', import.meta.url), 'utf8');
    await writeFile(join(dir, 'website/schema/testflight.schema.json'), schema);

    await writeFile(join(dir, 'website/testflight.json'), JSON.stringify({
      ...valid,
      status: 'available',
      externalApproved: false,
      publicURL: 'https://testflight.apple.com/join/abcd1234'
    }));
    await assert.rejects(validatePublicTestflightManifest(dir), /Invalid website\/testflight\.json/);

    await writeFile(join(dir, 'website/testflight.json'), JSON.stringify({
      ...valid,
      extraPrivateField: 'leak'
    }));
    await assert.rejects(validatePublicTestflightManifest(dir), /Invalid website\/testflight\.json/);

    await writeFile(join(dir, 'website/testflight.json'), JSON.stringify({
      ...valid,
      status: 'in-review',
      publicURL: 'https://testflight.apple.com/join/abcd1234'
    }));
    await assert.rejects(validatePublicTestflightManifest(dir), /Invalid website\/testflight\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R100: validateMacLocalizationParity enforces EN/ZH/JA parity and full Codelync.swift UI key coverage', async () => {
  const swift = await readFile(new URL('../apps/mac/Codelync.swift', import.meta.url), 'utf8');
  const extracted = extractSwiftLocalizationKeys(swift);
  for (const key of ['Start', 'Pause', 'Settings', 'Quit', 'Codex', 'Cloudflare', 'Relay', '/s', 'Connection status', 'Pairing QR code', 'Device name']) {
    assert.ok(extracted.includes(key), `Expected extracted Swift key: ${key}`);
  }

  const parity = await validateMacLocalizationParity();
  assert.ok(parity.keyCount >= 113);
  assert.ok(parity.swiftKeysChecked >= 60);

  const dir = await mkdtemp(join(tmpdir(), 'codelync-mac-i18n-'));
  try {
    await mkdir(join(dir, 'apps/mac'), { recursive: true });
    await writeFile(join(dir, 'apps/mac/Codelync.swift'), 'struct V: View { var body: some View { Text("Untranslated Label") } }\n');
    await writeFile(join(dir, 'apps/mac/translations.mjs'), `
      export const macTranslations = { en: { Start: 'Start' }, 'zh-Hans': { Start: '开始' }, ja: { Start: '開始' } };
      export const macLocalNetworkDescriptions = { en: 'a', 'zh-Hans': 'b', ja: 'c' };
    `);
    await assert.rejects(validateMacLocalizationParity(dir), /Untranslated Label/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isExpoBuildOnlyPicomatchAdvisory allows only Expo CLI / Metro build-time paths for advisory 1247710', () => {
  assert.equal(isExpoBuildOnlyPicomatchAdvisory({
    id: 1247710,
    module_name: 'picomatch',
    findings: [
      { paths: ['apps__mobile>expo>@expo/cli>picomatch'] },
      { paths: ['apps__mobile>expo>@expo/metro>metro>jest-worker>jest-util>picomatch'] }
    ]
  }), true);

  assert.equal(isExpoBuildOnlyPicomatchAdvisory({
    id: 1247710,
    module_name: 'picomatch',
    findings: [
      { paths: ['apps__mobile>expo>@expo/cli>picomatch', 'packages__relay>some-dep>picomatch'] }
    ]
  }), false);

  assert.equal(isExpoBuildOnlyPicomatchAdvisory({
    id: 1247710,
    module_name: 'picomatch',
    findings: [{ paths: ['picomatch'] }]
  }), false);

  assert.equal(isExpoBuildOnlyPicomatchAdvisory({
    id: 1247710,
    module_name: 'picomatch',
    findings: []
  }), false);

  assert.equal(isExpoBuildOnlyPicomatchAdvisory({
    id: 9999999,
    module_name: 'picomatch',
    findings: [{ paths: ['apps__mobile>expo>@expo/cli>picomatch'] }]
  }), false);
});
