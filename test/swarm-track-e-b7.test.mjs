import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SERVER_COMMIT, verifyDesktopRuntimeManifest } from '../scripts/build-desktop-runtime.mjs';
import { readEmbeddedPushConfig, validateMobilePushArtifact } from '../scripts/verify-mobile-push.mjs';

const execute = promisify(execFile);

test('R065: DesktopStdinFramer discards individual >16 KiB lines across chunks without dropping subsequent commands', { skip: process.platform !== 'darwin' }, async () => {
  const source = await readFile(new URL('../native/remote-desktop/Sources/CodelyncDesktopHost/main.swift', import.meta.url), 'utf8');
  const declarations = source.split('// BEGIN CODELYNC DESKTOP STDIN FRAMER\n')[1]?.split('// END CODELYNC DESKTOP STDIN FRAMER')[0];
  assert.ok(declarations);
  const directory = await mkdtemp(join(tmpdir(), 'codelync-r065-stdin-'));
  try {
    const script = join(directory, 'stdin-framer.swift');
    await writeFile(script, 'import Foundation\n' + declarations + String.raw`
var framer = DesktopStdinFramer(maxLineBytes: 16_384)
let big = Data(repeating: 65, count: 20_000) + Data([10]) + Data(#"{"operation":"status"}"#.utf8) + Data([10])
let out1 = framer.append(big)
precondition(out1.count == 1 && String(decoding: out1[0], as: UTF8.self) == #"{"operation":"status"}"#)

let chunkA = Data(repeating: 66, count: 12_000)
let chunkB = Data(repeating: 67, count: 8_000) + Data([13, 10]) + Data(#"{"operation":"stop"}"#.utf8) + Data([13, 10])
precondition(framer.append(chunkA).isEmpty)
let out2 = framer.append(chunkB)
precondition(out2.count == 1 && String(decoding: out2[0], as: UTF8.self) == #"{"operation":"stop"}"#)

precondition(framer.append(Data(repeating: 68, count: 16_384) + Data([10])).count == 1)
precondition(framer.append(Data(#"{"id":"tail"}"#.utf8)).isEmpty)
let tail = framer.flush()
precondition(tail != nil && String(decoding: tail!, as: UTF8.self) == #"{"id":"tail"}"#)
print("r065-stdin-framer-passed")
`);
    const sdk = await execute('/usr/bin/xcrun', ['--show-sdk-path']);
    const result = await execute('/usr/bin/xcrun', ['swift', '-sdk', sdk.stdout.trim(), script], { timeout: 30000 });
    assert.match(result.stdout, /r065-stdin-framer-passed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('R065: verifyDesktopRuntimeManifest validates SHA-256 hashes and rejects mismatched binaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r065-manifest-'));
  try {
    for (const bundle of ['LiveKitWebRTC.framework', 'RustLiveKitFFI.framework', 'LiveKit_LiveKit.bundle']) {
      await mkdir(join(dir, bundle), { recursive: true });
    }
    await mkdir(join(dir, 'desktop-licenses'), { recursive: true });
    await writeFile(join(dir, 'desktop-licenses/livekit-server.txt'), 'Apache-2.0');
    await writeFile(join(dir, 'desktop-licenses/livekit-swift.txt'), 'Apache-2.0');
    const hostBytes = Buffer.from('fixture-desktop-host');
    const serverBytes = Buffer.from('fixture-livekit-server');
    await writeFile(join(dir, 'CodelyncDesktopHost'), hostBytes);
    await writeFile(join(dir, 'livekit-server'), serverBytes);
    const hashes = {
      CodelyncDesktopHost: createHash('sha256').update(hostBytes).digest('hex'),
      'livekit-server': createHash('sha256').update(serverBytes).digest('hex')
    };
    await writeFile(join(dir, 'desktop-runtime.json'), JSON.stringify({
      version: 1,
      server: '1.13.11',
      serverCommit: DEFAULT_SERVER_COMMIT,
      swiftSDK: '2.19.0',
      hashes
    }) + '\n');

    const verified = await verifyDesktopRuntimeManifest(dir);
    assert.equal(verified.hashes.CodelyncDesktopHost, hashes.CodelyncDesktopHost);

    await writeFile(join(dir, 'CodelyncDesktopHost'), Buffer.from('tampered-desktop-host'));
    await assert.rejects(() => verifyDesktopRuntimeManifest(dir), /SHA-256 mismatch for CodelyncDesktopHost/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const nativeBin = new URL('../native/bin', import.meta.url).pathname;
  let hasLocalRuntime = false;
  try { await access(join(nativeBin, 'desktop-runtime.json')); hasLocalRuntime = true; } catch { hasLocalRuntime = false; }
  if (hasLocalRuntime) {
    const localManifest = await verifyDesktopRuntimeManifest(nativeBin);
    assert.equal(localManifest.version, 1);
  }
});

test('R070: verify-mobile-push validates CFBundleDisplayName and fails closed with explicit EXConstants config errors', async () => {
  const base = {
    info: { CFBundleIdentifier: 'com.learnings.codelync', CFBundleDisplayName: 'Codelync', DTPlatformName: 'iphoneos' },
    entitlements: { 'aps-environment': 'production', 'application-identifier': 'TEAM.com.learnings.codelync', 'com.apple.developer.team-identifier': 'TEAM' },
    profile: { Entitlements: { 'aps-environment': 'production', 'application-identifier': 'TEAM.com.learnings.codelync' }, TeamIdentifier: ['TEAM'], ExpirationDate: '2099-01-01' },
    config: { extra: { app: { codelyncPushEnvironment: 'production' } } },
    environment: 'production'
  };
  assert.equal(validateMobilePushArtifact(base).signed, true);

  const wrongDisplay = structuredClone(base);
  wrongDisplay.info.CFBundleDisplayName = 'CodeLight';
  assert.throws(() => validateMobilePushArtifact(wrongDisplay), /push-requires-codelync-device-artifact/);

  const badConfigObj = structuredClone(base);
  badConfigObj.config = /** @type {any} */ (null);
  assert.throws(() => validateMobilePushArtifact(badConfigObj), /push-embedded-config-invalid/);

  const dir = await mkdtemp(join(tmpdir(), 'codelync-r070-push-'));
  try {
    await assert.rejects(() => readEmbeddedPushConfig(dir), /push-embedded-config-missing/);
    await mkdir(join(dir, 'EXConstants.bundle'), { recursive: true });
    await writeFile(join(dir, 'EXConstants.bundle/app.config'), '{invalid-json');
    await assert.rejects(() => readEmbeddedPushConfig(dir), /push-embedded-config-invalid/);
    await writeFile(join(dir, 'EXConstants.bundle/app.config'), '[]');
    await assert.rejects(() => readEmbeddedPushConfig(dir), /push-embedded-config-invalid/);
    await writeFile(join(dir, 'EXConstants.bundle/app.config'), JSON.stringify({ extra: { app: { codelyncPushEnvironment: 'production' } } }));
    const parsed = await readEmbeddedPushConfig(dir);
    assert.equal(parsed.extra.app.codelyncPushEnvironment, 'production');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const pushSource = await readFile(new URL('../scripts/verify-mobile-push.mjs', import.meta.url), 'utf8');
  assert.match(pushSource, /if \(info\.CFBundleDisplayName !== 'Codelync'\) throw Error\('push-requires-codelync-device-artifact'\)/u);
});
