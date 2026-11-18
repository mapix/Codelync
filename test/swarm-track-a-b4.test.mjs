import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DesktopHostProcess } from '../src/codelync/desktop-host.mjs';
import { DesktopRelay } from '../src/codelync/desktop-relay.mjs';
import { CloudflareAccess } from '../src/network/public-access.mjs';
import { writeDurablePrivateJson } from '../src/codelync/discovery-persistence.mjs';
import { ConnectionChannelsManager } from '../src/network/connection-channels.mjs';

/** @typedef {Record<string,any>} Value */

test('R031: DesktopHostProcess rejects request() after close(), settles on exited child, and coalesces close()', async t => {
  const host = new DesktopHostProcess({ binary: '/nonexistent-host-binary-for-test' });
  t.after(async () => { await host.close(); });

  // Manually wire a real Node child that exits cleanly on stdin.end().
  const child = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.on('data', d => { const msg = JSON.parse(d.toString()); if (msg.operation === 'ping') console.log(JSON.stringify({ id: msg.id, ok: true, result: { pong: true } })); }); process.stdin.on('end', () => process.exit(0));"], { stdio: ['pipe', 'pipe', 'pipe'] });
  host.start = () => {};
  host.child = /** @type {any} */ (child);

  // If child already exited before close(), close() settles immediately without hanging.
  const exitedChild = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await once(exitedChild, 'exit');
  const alreadyExitedHost = new DesktopHostProcess({ binary: '/unused' });
  alreadyExitedHost.child = /** @type {any} */ (exitedChild);
  await alreadyExitedHost.close();
  assert.equal(alreadyExitedHost.child, null);
  await assert.rejects(alreadyExitedHost.request('displays'), { code: 'desktop-host-unavailable' });

  // Concurrent close() shares shutdown promise and rejects request() while closing.
  const pendingReq = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('late')), 20_000);
    host.pending.set('p1', { resolve: () => {}, reject, timer });
  });
  const c1 = host.close();
  const c2 = host.close();
  await assert.rejects(pendingReq, { code: 'desktop-host-unavailable' });
  await assert.rejects(host.request('displays'), { code: 'desktop-host-unavailable' });
  await Promise.all([c1, c2]);
  assert.equal(host.child, null);
});

test('R031: DesktopRelay.close() is safe on spawn failure and stops start() when closed mid-startup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r031-relay-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const relay = new DesktopRelay({ state: dir, binary: '/nonexistent-livekit-binary-for-test' });
  const startPromise = relay.start({ mode: 'local', url: '', apiKey: '', apiSecret: '' });
  await assert.rejects(startPromise, { code: 'desktop-relay-unavailable' });
  // configPath is cleaned up on close.
  await relay.close();

  // Calling close() before external/local start prevents spawn/return.
  const closedRelay = new DesktopRelay({ state: dir, binary: process.execPath });
  await closedRelay.close();
  await assert.rejects(closedRelay.start({ mode: 'external', url: 'wss://media.example', apiKey: 'key-1', apiSecret: 's'.repeat(64) }), { code: 'desktop-relay-unavailable' });
});

test('R036: CloudflareAccess cleans up reject/log handle on spawn failure and shuts down cleanly after tunnel URL', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r036-cf-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  // 1) Missing binary -> spawn error clears reject and closes tunnel.log.
  const bad = new CloudflareAccess({ binary: '/nonexistent-cloudflared-binary-for-test', upstream: 'http://127.0.0.1:1', state: dir });
  await assert.rejects(bad.start(), /cloudflare-start-failed/);
  assert.equal(bad.reject, null);
  await bad.close();
  assert.ok(await stat(join(dir, 'tunnel.log')));

  // 2) Real child emitting trycloudflare URL -> resolves URL, clears reject, and closes log cleanly on close().
  const scriptPath = join(dir, 'fake-cf.mjs');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(scriptPath, "console.error('INF +--------------------------------------------------------------------------------------------+'); console.error('INF |  https://fixture-r036.trycloudflare.com                                                  |'); process.stdin.resume(); setInterval(() => {}, 1000);");
  const good = new CloudflareAccess({ binary: process.execPath, upstream: 'http://127.0.0.1:1', state: dir });
  // Override binary invocation? Instead spawn script via a small wrapper shell or pass node flag — use sh wrapper!
  const shPath = join(dir, 'cf.sh');
  await writeFile(shPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}"\n`, { mode: 0o755 });
  good.options = { ...good.options, binary: shPath };

  const url = await good.start();
  assert.equal(url, 'https://fixture-r036.trycloudflare.com');
  assert.equal(good.reject, null);
  await good.close();
  const logText = await readFile(join(dir, 'tunnel.log'), 'utf8');
  assert.ok(logText.includes('fixture-r036.trycloudflare.com'));
});

test('R036: ConnectionChannels cancels armed verification retryTimers immediately on transport connected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r036-channels-'));
  let mode = /** @type {'pass'|'fail'|'hang'} */ ('pass');
  let probeCount = 0;
  let abortedProbes = 0;
  /** @type {Array<{ resolve: () => void }>} */
  const probeGates = [];
  /** @type {EventEmitter & { start: () => Promise<string>, activate: () => void, pauseReconnect: () => void, close: () => void }} */
  const transport = Object.assign(new EventEmitter(), {
    async start() { return 'https://relay.example/r/' + 'a'.repeat(24); },
    activate() {},
    pauseReconnect() {},
    close() {},
  });

  const manager = new ConnectionChannelsManager({
    state: dir,
    cloudflared: 'unused',
    upstreamFor: () => 'http://127.0.0.1:1',
    startLocal: async () => ({ channels: [], close() {}, on() {} }),
    validateRelay: async url => url,
    transportFactory: () => transport,
    probesFor: () => ({
      verify: async (_origin, signal) => {
        probeCount++;
        if (mode === 'pass') return;
        if (mode === 'fail') throw Error('initial-probe-failed');
        await new Promise(resolve => {
          signal?.addEventListener('abort', () => { abortedProbes++; resolve(undefined); }, { once: true });
          probeGates.push({ resolve: () => resolve(undefined) });
        });
      },
    }),
    retryInitialMs: 40,
    retryMaxMs: 40,
  });

  t.after(async () => {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  });

  await writeDurablePrivateJson(join(dir, 'connection-channels.json'), { version: 2, enabledChannels: [], relay: null });
  await manager.load();
  await manager.configureRelay({ serverUrl: 'https://relay.example', token: 'a'.repeat(43) });
  const entry = manager.entries.get('relay');
  assert.ok(entry);

  // Disconnect and emit connected with failing probes -> arms retryTimers(40ms).
  mode = 'fail';
  transport.emit('disconnected');
  transport.emit('connected');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(manager.retryTimers.has('relay'), true, 'failed reconnect probe should have armed retryTimers');

  // Switch probes to slow-hang and emit connected BEFORE the 40ms retry timer fires.
  mode = 'hang';
  const countBeforeConnected = probeCount;
  transport.emit('connected');
  assert.equal(manager.retryTimers.has('relay'), false, 'connected must cancel armed retryTimers immediately before verifyEntry');

  // Sleep longer than retryInitialMs (40ms): stale timer does NOT fire and active probe is NOT aborted.
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(probeCount, countBeforeConnected + 1);
  assert.equal(abortedProbes, 0);

  probeGates.at(-1)?.resolve();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(manager.entries.get('relay')?.state, 'ready');
});
