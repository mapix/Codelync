import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { installClaudeOwnerBridge } from '../src/adapters/claude-owner-bridge.mjs';

test('native Gateway marker binds initial mode/profile and refuses credential epoch drift without leaking provider data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-owner-gate-')), artifact = join(dir, 'app.asar'), meta = join(dir, '_meta.json'), runtimePath = join(dir, 'runtime.json');
  await writeFile(artifact, 'fixture shipped artifact'); await writeFile(meta, JSON.stringify({ appliedId: 'original-profile' }));
  const expectedAsarSha256 = createHash('sha256').update('fixture shipped artifact').digest('hex');
  let epoch = 0;
  const main = { Hft: () => ({ type: '3p', getProvider: () => ({ creds: { provider: 'gateway', apiKey: 'synthetic-secret-key' } }), managesProviderRouting: () => true,
    accountIdOverride: () => 'native-account', orgUuidOverride: () => 'native-org', credentialEpoch: () => epoch }),
    Lut: () => ({ inference: { provider: 'gateway', baseUrl: 'https://private.invalid', credential: { kind: 'static' } }, codeSurface: { enabled: true }, chatSurface: { enabled: true } }),
    Fut: () => ({ type: 'local' }), Wdt: () => meta, bdt: () => true, r3: () => 'allowed' };
  const app = /** @type {any} */ (new EventEmitter()); app.getVersion = () => '4.16336.0'; app.getAppPath = () => artifact; app.getPath = () => dir;
  const manager = new EventEmitter(); const nativeRequire = createRequire(import.meta.url);
  const hostRequire = (/** @type {string} */ path) => path === 'original-fs' ? fs : path.includes('index.chunk-Du-Wqi0E') ? main
    : path.includes('index.chunk-CqaSnEfn') ? { claudeCodeSessionManager: manager } : path.includes('index.chunk-vuRwhTdh') ? { n: manager } : nativeRequire(path);
  let bridge;
  try {
    bridge = await installClaudeOwnerBridge({ electron: { app }, hostRequire, runtimePath, expectedAsarSha256 });
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8')), body = JSON.stringify({ version: 1, method: 'owner.status', params: {} });
    const request = () => fetch(runtime.origin + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer ' + runtime.accessToken, 'Content-Type': 'application/json' }, body });
    const before = await (await request()).json(); assert.equal(before.ok, true); assert.match(runtime.gatewayMarker, /^[a-f0-9]{64}$/);
    epoch++; const after = await (await request()).json(); assert.equal(after.ok, false); assert.equal(after.error.code, 'source-profile-changed'); assert.equal(after.effectMayHaveOccurred, false);
    assert.equal(JSON.stringify(after).includes('synthetic-secret-key'), false); assert.equal(JSON.stringify(after).includes('private.invalid'), false);
  } finally { await bridge?.deactivate(); await rm(dir, { recursive: true, force: true }); }
});

test('readonly stock snapshot bounds an expanded native tail, preserves headers and reuses original renderer IPC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-existing-native-')), artifact = join(dir, 'app.asar'), meta = join(dir, '_meta.json'), runtimePath = join(dir, 'runtime.json');
  await writeFile(artifact, 'fixture shipped artifact'); await writeFile(meta, JSON.stringify({ appliedId: 'original-profile' }));
  const expectedAsarSha256 = createHash('sha256').update('fixture shipped artifact').digest('hex');
  const original = { sessionId: 'native-session', createdAt: 1, query: null }, header = { sessionId: original.sessionId, isRunning: false };
  const manager = /** @type {any} */ (new EventEmitter()); manager.sessions = new Map([[original.sessionId, original]]); manager.permissionBroker = { pendingPermissions: new Map() };
  const originalListener = () => {}; manager.on('event', originalListener);
  let reads = 0;
  /** @type {any[]} */ let nativeMessages = Array.from({ length: 512 }, (_, index) => ({ type: 'assistant', uuid: 'native-' + index, message: { content: 'whole message ' + index } }));
  const native = { LocalSessions: { getTranscriptTail: async (/** @type {string} */ id, /** @type {number} */ limit) => { assert.equal(id, original.sessionId); assert.equal(limit, 32); reads++; return { messages: nativeMessages, hasMore: false }; }, getSession: async () => header } };
  const wc = /** @type {any} */ (new EventEmitter()); wc.isDestroyed = () => false; wc.getURL = () => 'app://localhost/new';
  wc.mainFrame = { executeJavaScript: (/** @type {string} */ script) => runInNewContext(script, { location: new URL(wc.getURL()), window: { 'claude.web': native } }) };
  const main = { Hft: () => ({ type: '3p', getProvider: () => ({ creds: { provider: 'gateway' } }), managesProviderRouting: () => true }),
    Lut: () => ({ inference: { provider: 'gateway', baseUrl: 'https://private.invalid', credential: { kind: 'static' } }, codeSurface: { enabled: true } }), Fut: () => ({ type: 'local' }), Wdt: () => meta, bdt: () => true, r3: () => 'allowed' };
  const app = /** @type {any} */ (new EventEmitter()); app.getVersion = () => '4.16336.0'; app.getAppPath = () => artifact; app.getPath = () => dir;
  const nativeRequire = createRequire(import.meta.url);
  const hostRequire = (/** @type {string} */ path) => {
    if (/index.chunk-(yo8W6L7k|DzkpfKOD)/.test(path)) throw Error('Native API factory must not be loaded');
    return path === 'original-fs' ? fs : path.includes('index.chunk-Du-Wqi0E') ? main : path.includes('index.chunk-CqaSnEfn') ? { claudeCodeSessionManager: manager }
      : path.includes('index.chunk-vuRwhTdh') ? { n: manager } : nativeRequire(path);
  };
  let bridge;
  try {
    bridge = await installClaudeOwnerBridge({ electron: { app, webContents: { getAllWebContents: () => [wc] } }, hostRequire, runtimePath, expectedAsarSha256, readOnly: true });
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
    const snapshot = async () => (await fetch(runtime.origin + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer ' + runtime.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, method: 'code.snapshot', params: { sessionId: original.sessionId } }) })).json();
    const reply = await snapshot(); assert.equal(reply.ok, true); assert.equal(reads, 1);
    assert.equal(runtime.readOnly, true); assert.equal(runtime.mutationAllowed, false);
    assert.equal(reply.result.messages.length, 32); assert.equal(reply.result.messages[0].uuid, 'native-480'); assert.equal(reply.result.messages.at(-1).uuid, 'native-511');
    assert.equal(reply.result.hasMore, true); assert.equal(reply.result.header.sessionId, original.sessionId); assert.equal(reply.result.header.isRunning, false);
    nativeMessages = Array(2049).fill({ type: 'assistant' });
    const oversized = await snapshot(); assert.equal(oversized.ok, false); assert.equal(oversized.error.code, 'claude-invalid-tail-window'); assert.equal(oversized.effectMayHaveOccurred, false);
    nativeMessages = [{ type: 'assistant', uuid: 'large-native', message: { content: 'x'.repeat(1024 * 1024 + 1) } }];
    const largeText = await snapshot(); assert.equal(largeText.ok, false); assert.equal(largeText.error.code, 'claude-text-too-large'); assert.equal(largeText.effectMayHaveOccurred, false);
    assert.equal(wc.eventNames().length, 0); assert.equal(manager.listenerCount('event'), 2); assert.equal(app.listenerCount('before-quit'), 1);
    await bridge.deactivate(); assert.deepEqual(manager.listeners('event'), [originalListener]); assert.equal(app.listenerCount('before-quit'), 0);
  } finally { await bridge?.deactivate(); await rm(dir, { recursive: true, force: true }); }
});
