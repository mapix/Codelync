import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionChannelsManager } from '../src/network/connection-channels.mjs';
import { writeDurablePrivateJson } from '../src/codelync/discovery-persistence.mjs';
import { EntryProbes } from '../src/network/public-access.mjs';
import { WebSocketServer } from 'ws';

/** @typedef {Record<string,any>} Value */
/** @param {()=>boolean} predicate */
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'isolated network condition did not settle');
}
function deferred() {
  let resolve = /** @type {(value:any)=>void} */ (() => {});
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
class Tunnel extends EventEmitter {
  /** @param {Value} config @param {Value} [controls] */
  constructor(config, controls = {}) { super(); this.config = config; this.controls = controls; this.closed = false; this.paused = false; }
  async start() {
    if (this.controls.start) return this.controls.start();
    return this.config.kind === 'relay' ? this.config.serverUrl + '/r/' + 'a'.repeat(24) : 'https://synthetic.trycloudflare.com';
  }
  activate() {}
  /** @param {boolean} value */
  pauseReconnect(value) { this.paused = value; }
  close() { this.closed = true; return this.controls.close?.(); }
}
/** This is an isolated transport-owner proof; it does not invoke a native app or model.
 * @param {import('node:test').TestContext} t @param {Value} [controls] */
async function fixture(t, controls = {}) {
  const state = await mkdtemp(join(tmpdir(), 'codelync-network-stability-'));
  const transports = /** @type {Tunnel[]} */ ([]);
  await writeDurablePrivateJson(join(state, 'connection-channels.json'), controls.configuration ?? { version: 2, enabledChannels: ['cloudflare'], relay: null });
  const manager = new ConnectionChannelsManager({ state, cloudflared: 'unused', retryInitialMs: 10, retryMaxMs: 40,
    upstreamFor: () => 'http://127.0.0.1:9', probesFor: () => ({ verify: async () => {} }),
    startLocal: async () => ({ channels: [{ id: 'lan-synthetic', kind: 'local', url: 'http://192.168.50.2:8080' }], close() {} }),
    transportFactory: config => { const transport = new Tunnel(config, controls.transport?.(config, transports.length) ?? {}); transports.push(transport); return transport; } });
  t.after(async () => { await manager.close(); await rm(state, { recursive: true, force: true }); });
  await manager.load();
  return { manager, transports };
}

test('[N01] failed enabled startup recovers autonomously and disabling cancels pending bounded retries', async t => {
  const f = await fixture(t, { transport: (/** @type {Value} */ _config, /** @type {number} */ index) => index === 0 ? { start: async () => { throw Error('synthetic-link-loss'); } } : {} });
  await until(() => f.manager.snapshot().overallState === 'ready');
  assert.equal(f.transports.length, 2); assert.equal(f.transports[0].closed, true);
  assert.equal(f.manager.retryTimers.size, 0);
  await f.manager.setEnabled([]);
  assert.deepEqual(f.manager.candidates(), []);
  const failed = await fixture(t, { transport: () => ({ start: async () => { throw Error('synthetic-link-loss'); } }) });
  await until(() => failed.transports.length === 3);
  assert.equal(failed.manager.retryTimers.size, 1);
  assert.equal(failed.manager.retryDelays.get('cloudflare'), 40);
  await failed.manager.setEnabled([]);
  const count = failed.transports.length;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(failed.transports.length, count); assert.equal(failed.manager.retryTimers.size, 0);
});

test('[N02] an exited owned synthetic Cloudflare process retires its URL and restarts without reopening runtime state', async t => {
  const state = await mkdtemp(join(tmpdir(), 'codelync-cloudflare-process-fault-'));
  const binary = join(state, 'synthetic-cloudflared.mjs');
  await writeFile(binary, `#!${process.execPath}\nprocess.stderr.write('https://synthetic.trycloudflare.com\\n');setInterval(()=>{},1000);\n`, { mode: 0o700 });
  await writeDurablePrivateJson(join(state, 'connection-channels.json'), { version: 2, enabledChannels: ['cloudflare'], relay: null });
  const manager = new ConnectionChannelsManager({ state, cloudflared: binary, retryInitialMs: 50, retryMaxMs: 100,
    upstreamFor: () => 'http://127.0.0.1:9', probesFor: () => ({ verify: async () => {} }), startLocal: async () => { throw Error('disabled LAN must not start'); } });
  t.after(async () => { await manager.close(); await rm(state, { recursive: true, force: true }); });
  await manager.load(); await until(() => manager.snapshot().overallState === 'ready');
  const old = manager.entries.get('cloudflare'); assert.ok(old);
  const processId = old.transport.child.pid, identity = manager.seed;
  old.transport.child.kill('SIGTERM');
  await until(() => old.disconnected);
  assert.deepEqual(manager.candidates(), []);
  await until(() => manager.snapshot().overallState === 'ready' && manager.entries.get('cloudflare') !== old);
  const next = manager.entries.get('cloudflare'); assert.ok(next);
  assert.notEqual(next.transport.child.pid, processId); assert.equal(manager.seed, identity);
  assert.equal(old.cancel.signal.aborted, true); assert.equal(old.transport.closed, true);
  old.transport.emit('connected'); assert.equal(manager.entries.get('cloudflare'), next);
});

test('[N03] superseded Relay validation cannot unpause the old route held by a newer replacement', async t => {
  const first = deferred(), second = deferred();
  const f = await fixture(t, { configuration: { version: 2, enabledChannels: [], relay: null },
    transport: (/** @type {Value} */ _config, /** @type {number} */ index) => index === 1 ? { start: () => first.promise } : index === 2 ? { start: () => second.promise } : {} });
  const url = 'https://synthetic-relay.example', origin = url + '/r/' + 'a'.repeat(24);
  await f.manager.configureRelay({ serverUrl: url, token: 'a'.repeat(43) });
  const old = f.transports[0];
  const a = f.manager.configureRelay({ serverUrl: url, token: 'b'.repeat(43) }); a.catch(() => {});
  const b = f.manager.configureRelay({ serverUrl: url, token: 'c'.repeat(43) });
  await until(() => f.transports.length === 3);
  first.resolve(origin); await assert.rejects(a, /cancelled/);
  assert.equal(old.paused, true); assert.equal(f.manager.pending.get('relay')?.transport, f.transports[2]);
  second.resolve(origin); await b;
  assert.equal(old.closed, true); assert.equal(f.manager.entries.get('relay')?.transport, f.transports[2]);
});

test('[N03] reaffirming the working Relay configuration cancels an older pending replacement', async t => {
  const waiting = deferred();
  const f = await fixture(t, { configuration: { version: 2, enabledChannels: [], relay: null },
    transport: (/** @type {Value} */ _config, /** @type {number} */ index) => index === 1 ? { start: () => waiting.promise } : {} });
  const url = 'https://synthetic-relay.example';
  await f.manager.configureRelay({ serverUrl: url, token: 'a'.repeat(43) });
  const pending = f.manager.configureRelay({ serverUrl: url, token: 'b'.repeat(43) }); pending.catch(() => {});
  await until(() => f.transports.length === 2);
  await f.manager.configureRelay({ serverUrl: url, token: 'a'.repeat(43) });
  assert.equal(f.manager.pending.has('relay'), false); assert.equal(f.transports[0].paused, false);
  waiting.resolve(url + '/r/' + 'a'.repeat(24)); await assert.rejects(pending, /cancelled/);
  assert.equal(f.manager.saved.relay.token, 'a'.repeat(43)); assert.equal(f.transports[1].closed, true);
});

test('[N04] reconnect cancels obsolete proof work and paired confirmation cancels the current proof', async t => {
  const f = await fixture(t, { configuration: { version: 2, enabledChannels: [], relay: null } });
  await f.manager.configureRelay({ serverUrl: 'https://synthetic-relay.example', token: 'a'.repeat(43) });
  const relay = f.transports[0], probes = /** @type {Array<{signal:AbortSignal|undefined,wait:ReturnType<typeof deferred>}>} */ ([]);
  f.manager.options.probesFor = () => ({ verify: async (_url, signal) => { const wait = deferred(); probes.push({ signal, wait }); await wait.promise; } });
  relay.emit('disconnected'); relay.emit('connected'); await until(() => probes.length === 1);
  relay.emit('connected'); await until(() => probes.length === 2);
  assert.equal(probes[0].signal?.aborted, true); assert.equal(probes[1].signal?.aborted, false);
  const origin = f.manager.candidates()[0].url; assert.equal(f.manager.confirm('relay', origin), true);
  assert.equal(probes[1].signal?.aborted, true);
  probes[0].wait.resolve(undefined); probes[1].wait.resolve(undefined);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.manager.entries.get('relay')?.state, 'ready');
});

test('[N04] a synchronous reconnect probe failure cannot escape the transport event callback', async t => {
  const f = await fixture(t, { configuration: { version: 2, enabledChannels: [], relay: null } });
  await f.manager.configureRelay({ serverUrl: 'https://synthetic-relay.example', token: 'a'.repeat(43) });
  f.manager.options.probesFor = () => { throw Error('synthetic-probe-construction-failure'); };
  assert.doesNotThrow(() => f.transports[0].emit('connected'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.manager.entries.get('relay')?.state, 'unverified');
});

test('[N04] superseded real local HTTP/WS probes release their sockets and independent challenges', async t => {
  const f = await fixture(t); await until(() => f.manager.snapshot().overallState === 'ready');
  const probes = new EntryProbes(), upgrades = /** @type {string[]} */ ([]), reads = /** @type {string[]} */ ([]);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1'); reads.push(url.pathname);
    res.end(probes.response(url.searchParams.get('challenge')) ?? 'unavailable');
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    upgrades.push(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    sockets.handleUpgrade(req, socket, head, () => {}); // Intentionally hold the read-only probe reply.
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  f.manager.options.probesFor = () => probes;
  const entry = f.manager.entries.get('cloudflare'); assert.ok(entry);
  const origin = 'http://127.0.0.1:' + address.port;
  const first = f.manager.verifyEntry(entry, origin); first.catch(() => {});
  await until(() => sockets.clients.size === 1);
  const second = f.manager.verifyEntry(entry, origin); second.catch(() => {});
  await assert.rejects(first, /cancelled/);
  await until(() => upgrades.length === 2 && sockets.clients.size === 1);
  assert.equal(f.manager.confirm('cloudflare', entry.channels[0].url), true);
  await assert.rejects(second, /cancelled/); await until(() => sockets.clients.size === 0);
  assert.equal(probes.probes.size, 0);
  assert.deepEqual(reads, ['/codelync/entry-probe', '/codelync/entry-probe']);
  assert.deepEqual(upgrades, reads);
});

test('[N05] concurrent manager close callers await the same transport cleanup', async t => {
  const cleanup = deferred();
  const f = await fixture(t, { transport: () => ({ close: () => cleanup.promise }) });
  await until(() => f.manager.snapshot().overallState === 'ready');
  const first = f.manager.close(), second = f.manager.close();
  try { assert.equal(first, second); }
  finally { cleanup.resolve(undefined); await Promise.all([first, second]); }
});
