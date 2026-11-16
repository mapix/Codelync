import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { installClaudeOwnerBridge } from '../src/adapters/claude-owner-bridge.mjs';

test('readonly manifest/status and owner admission deny every native mutation before any method/factory call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-readonly-')), artifact = join(dir, 'app.asar'), metadata = join(dir, 'meta.json'), runtimePath = join(dir, 'runtime.json');
  await writeFile(artifact, 'readonly fixture'); await writeFile(metadata, JSON.stringify({ appliedId: 'fixture' }));
  const app = /** @type {any} */ (new EventEmitter()); app.getVersion = () => '4.16336.0'; app.getAppPath = () => artifact; app.getPath = () => dir;
  const main = { Hft: () => ({ type: '3p', getProvider: () => ({ creds: { provider: 'gateway' } }), managesProviderRouting: () => true }),
    Lut: () => ({ inference: { provider: 'gateway', baseUrl: 'https://fixture.invalid', credential: { kind: 'static' } }, codeSurface: { enabled: true }, chatSurface: { enabled: true } }),
    Fut: () => ({ type: 'local' }), Wdt: () => metadata, bdt: () => true, r3: () => 'allowed' };
  const manager = new EventEmitter(), nativeRequire = createRequire(import.meta.url);
  const hostRequire = (/** @type {string} */ path) => {
    if (/index.chunk-(yo8W6L7k|DzkpfKOD)/.test(path)) throw Error('native factory not allowed');
    return path === 'original-fs' ? fs : path.includes('index.chunk-Du-Wqi0E') ? main : path.includes('index.chunk-CqaSnEfn') ? { claudeCodeSessionManager: manager }
      : path.includes('index.chunk-vuRwhTdh') ? { n: manager } : nativeRequire(path);
  };
  const bridge = await installClaudeOwnerBridge({ electron: { app }, hostRequire, runtimePath, readOnly: true,
    expectedAsarSha256: createHash('sha256').update('readonly fixture').digest('hex') });
  try {
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8')); assert.equal(runtime.readOnly, true); assert.equal(runtime.mutationAllowed, false);
    const call = async (/** @type {string} */ method) => (await fetch(runtime.origin + '/rpc', { method: 'POST', headers: { Authorization: 'Bearer ' + runtime.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, method, commandId: 'operation-one', params: { sessionId: 'unknown' } }) })).json();
    const status = await call('owner.status'); assert.equal(status.result.readOnly, true); assert.equal(status.result.mutationAllowed, false);
    for (const method of ['code.send', 'code.interrupt', 'code.permission', 'code.settings', 'cowork.send', 'cowork.interrupt', 'cowork.settings']) {
      const reply = await call(method); assert.equal(reply.ok, false); assert.equal(reply.error.code, 'native-read-only'); assert.equal(reply.effectMayHaveOccurred, false);
    }
    assert.equal(manager.listenerCount('event'), 0); assert.equal(app.listenerCount('before-quit'), 1);
  } finally { await bridge.deactivate(); await rm(dir, { recursive: true, force: true }); }
});
