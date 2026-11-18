import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCleanArchiveMembers, assertCleanPublicMetadata } from '../scripts/verify-codelync-source.mjs';
import { macTranslations } from '../apps/mac/translations.mjs';

const run = promisify(execFile);

test('R045: assertCleanArchiveMembers rejects .DS_Store, AppleDouble, website/release.json and downloads', () => {
  assertCleanArchiveMembers(['codelync/README.md', 'codelync/website/testflight.json', 'codelync/apps/mac/Codelync.swift']);
  for (const forbidden of [
    'codelync/.DS_Store',
    'codelync/apps/.DS_Store',
    'codelync/src/._secret.mjs',
    'codelync/__MACOSX/foo',
    'codelync/website/release.json',
    'codelync/website/downloads/Codelync-1.0.0-macos-arm64.zip'
  ]) {
    assert.throws(() => assertCleanArchiveMembers([forbidden]), /source ZIP/);
  }
});

test('R045: assertCleanPublicMetadata validates repo docs/testflight.json and rejects leaks or unapproved beta URLs', async () => {
  const repoRoot = new URL('..', import.meta.url).pathname;
  await assertCleanPublicMetadata(repoRoot, { requireDocs: true });

  const dir = await mkdtemp(join(tmpdir(), 'codelync-r045-'));
  try {
    await mkdir(join(dir, 'website'), { recursive: true });
    for (const file of ['README.md', 'README.zh-CN.md', 'README.ja.md', 'SECURITY.md', 'CONTRIBUTING.md']) {
      await writeFile(join(dir, file), 'Codex, Antigravity Desktop and Claude Desktop (Gateway)');
    }
    await writeFile(join(dir, 'website/testflight.json'), JSON.stringify({
      schemaVersion: 2,
      status: 'in-review',
      version: '1.0.0',
      build: '2026111705',
      appId: '6835734876',
      groupId: 'eaa4762f-309c-4938-882e-8f245c7e1c92',
      publicURL: 'https://testflight.apple.com/join/AbCd1234',
      externalApproved: false,
      externalGroupEnabled: true,
      externalGroupContainsBuild: true,
      publishedAt: '2026-11-17T09:12:32Z'
    }));
    await assert.rejects(() => assertCleanPublicMetadata(dir, { requireDocs: true }), /non-null publicURL/);

    await writeFile(join(dir, 'website/testflight.json'), JSON.stringify({
      schemaVersion: 2,
      status: 'in-review',
      version: '1.0.0',
      build: '2026111705',
      appId: '6835734876',
      groupId: 'eaa4762f-309c-4938-882e-8f245c7e1c92',
      publicURL: null,
      externalApproved: false,
      externalGroupEnabled: true,
      externalGroupContainsBuild: true,
      publishedAt: '2026-11-17T09:12:32Z'
    }));
    await writeFile(join(dir, 'README.md'), 'Private leak /Users/private/codelight');
    await assert.rejects(() => assertCleanPublicMetadata(dir, { requireDocs: true }), /Private path or key material/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R045: package-codelync.mjs blocks unapproved website/testflight.json when present in staged files', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r045-pkg-'));
  try {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await mkdir(join(dir, 'src/release'), { recursive: true });
    await mkdir(join(dir, 'website'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'codelync', version: '1.0.0' }));
    await writeFile(join(dir, 'scripts/package-codelync.mjs'), await readFile(new URL('../scripts/package-codelync.mjs', import.meta.url)));
    await writeFile(join(dir, 'src/release/source-snapshot.mjs'), await readFile(new URL('../src/release/source-snapshot.mjs', import.meta.url)));
    await writeFile(join(dir, 'website/testflight.json'), JSON.stringify({
      schemaVersion: 2,
      status: 'coming-soon',
      publicURL: 'https://testflight.apple.com/join/Fake1234'
    }));
    await run('git', ['init', '-q'], { cwd: dir });
    await run('git', ['add', '--all'], { cwd: dir });
    await assert.rejects(() => run(process.execPath, [join(dir, 'scripts/package-codelync.mjs')]), /non-null publicURL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R050: Codelync.swift removes deprecated modifiers and adds VoiceOver accessibility labels across all 3 locales', async () => {
  const swift = await readFile(new URL('../apps/mac/Codelync.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(swift, /\.onCommit\s*\(/u);
  assert.doesNotMatch(swift, /\.foregroundColor\s*\(/u);
  assert.match(swift, /\.foregroundStyle\(device\.revoked \? Color\.secondary : Color\.blue\)/u);
  assert.match(swift, /\.accessibilityIdentifier\("codelync-public-status"\)/u);
  assert.match(swift, /NSLocalizedString\("Connection status"/u);
  assert.match(swift, /\.accessibilityIdentifier\("codelync-pairing-qr"\)/u);
  assert.match(swift, /\.accessibilityLabel\(Text\("Pairing QR code"\)\)/u);
  assert.match(swift, /\.accessibilityLabel\(Text\("Device name"\)\)/u);
  assert.match(swift, /\.accessibilityElement\(children: \.combine\)/u);
  assert.match(swift, /\.accessibilityIdentifier\("codelync-device-status-\\\(device\.id\)"\)/u);

  for (const key of ['Connection status', 'Pairing QR code', 'Device name']) {
    for (const locale of /** @type {const} */ (['en', 'zh-Hans', 'ja'])) {
      const table = /** @type {Record<string, string>} */ (macTranslations[locale]);
      assert.ok(table[key]?.trim(), `Missing ${locale} translation for ${key}`);
    }
  }
});
