import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { MacConnectionService, privateLANAddresses } from '../src/codelync/mac-connection-service.mjs';
import { ConnectionChannelsManager } from '../src/network/connection-channels.mjs';
import { createPairingGateway, PairingInvitations } from '../src/codelync/pairing-gateway.mjs';
import { DeviceRegistry } from '../src/codelync/device-registry.mjs';

/** @typedef {Record<string,any>} Value */
const A = '192.168.50.2', B = '10.20.30.2', C = '192.168.60.2';
class Tunnel extends EventEmitter {
  async start() { return 'https://network-watch-fixture.example'; }
  activate() {} close() {}
}
/** @param {()=>boolean} predicate */
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate());
}
/** @param {import('node:test').TestContext} t @param {number} [networkWatchMs] */
async function fixture(t, networkWatchMs = 0) {
  const state = await mkdtemp(join(tmpdir(), 'codelync-network-watch-'));
  const phone = nacl.box.keyPair(), mac = nacl.box.keyPair(), token = 'synthetic-network-watch-token';
  const account = { secret: randomBytes(32).toString('base64url') }, devices = new DeviceRegistry(join(state, 'devices.json'));
  await devices.approve(Buffer.from(phone.publicKey).toString('base64url'), 'Synthetic network phone', token);
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { ...account, token } });
  let hosts = [A, B];
  let beforeBind = /** @type {((host:string)=>void)|null} */ (null);
  const failedHosts = new Set();
  /** @type {Array<{host:string,port:number,server:ReturnType<typeof createPairingGateway>}>} */ const binds = [];
  const service = new MacConnectionService({ state, cloudflared: 'unused', upstream: 'http://127.0.0.1:9', account, devices, invitations,
    daemon: /** @type {any} */ ({ sources: new Map(), actors: new Map(), closed: false, ownsLease: true, inventoryAvailable: true }), networkWatchMs,
    interfaces: () => ({ fixture: hosts.map(address => ({ address, family: 'IPv4', internal: false })) }),
    gatewayFactory: options => {
      const server = createPairingGateway(options), listen = server.listen.bind(server);
      server.listen = /** @type {typeof server.listen} */ ((/** @type {number} */ port, /** @type {string} */ host) => {
        binds.push({ host, port, server });
        beforeBind?.(host);
        if (failedHosts.has(host)) { queueMicrotask(() => server.emit('error', Object.assign(Error('Synthetic absent interface'), { code: 'EADDRNOTAVAIL' }))); return server; }
        // Verify real gateway sockets/proofs while the controlled interface list
        // remains independent of the host running this test.
        return listen(port, '127.0.0.1');
      });
      return server;
    },
    managerFactory: options => new ConnectionChannelsManager({ ...options, transportFactory: () => new Tunnel(), probesFor: () => ({ verify: async () => {} }) }) });
  t.after(async () => { await service.close(); invitations.close(); await rm(state, { recursive: true, force: true }); });
  await service.start(); await until(() => service.candidates().filter(row => row.kind === 'local').length === 2);
  return { state, phone, mac, token, devices, service, binds, failedHosts, setHosts: (/** @type {string[]} */ value) => { hosts = value; },
    beforeBind: (/** @type {(host:string)=>void} */ callback) => { beforeBind = callback; } };
}
/** @param {Value} f @param {Value|undefined} channel @param {boolean} [direct] */
async function manifest(f, channel, direct = false) {
  assert.ok(channel);
  const nonce = randomBytes(24), path = '/api/peer/channels';
  const request = Buffer.from(JSON.stringify({ version: 2, token: f.token, origin: channel.url, method: 'GET', path, at: Date.now() }));
  const auth = 'Codelync ' + Buffer.from(JSON.stringify({ publicKey: Buffer.from(f.phone.publicKey).toString('base64url'), nonce: nonce.toString('base64url'),
    ciphertext: Buffer.from(nacl.box(request, nonce, f.mac.publicKey, f.phone.secretKey)).toString('base64url') })).toString('base64url');
  const url = (direct ? channel.url : 'http://127.0.0.1:' + new URL(channel.url).port) + path;
  const packet = direct ? await new Promise((resolve, reject) => {
    const call = httpRequest(url, { agent: false, headers: { Authorization: auth }, timeout: 3000 }, response => {
      const chunks = /** @type {Buffer[]} */ ([]);
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        try { assert.equal(response.statusCode, 200); resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); }
      });
    });
    call.on('error', reject); call.on('timeout', () => call.destroy(Error('Live LAN request timeout'))); call.end();
  }) : await (async () => {
    const response = await fetch(url, { headers: { Authorization: auth } }); assert.equal(response.status, 200); return response.json();
  })();
  const plain = nacl.box.open(Buffer.from(packet.ciphertext, 'base64url'), Buffer.from(packet.nonce, 'base64url'), f.mac.publicKey, f.phone.secretKey);
  assert.ok(plain); return JSON.parse(Buffer.from(plain).toString());
}
/** @param {MacConnectionService} service @param {string} host */
function local(service, host) { return service.candidates().find(row => row.kind === 'local' && new URL(row.url).hostname === host); }

test('network change keeps retained sockets/ports and publishes new authenticated same-peer routes without restarting public entries', async t => {
  const f = await fixture(t), firstA = local(f.service, A), firstB = local(f.service, B); assert.ok(firstA && firstB);
  const peerId = f.service.peerId(), publicEntry = f.service.manager.entries.get('cloudflare'), identity = await readFile(join(f.state, 'network-identity.json'), 'utf8');
  const retained = createConnection({ host: '127.0.0.1', port: Number(new URL(firstB.url).port) }); retained.on('error', () => {}); await once(retained, 'connect');
  const retired = createConnection({ host: '127.0.0.1', port: Number(new URL(firstA.url).port) }); retired.on('error', () => {}); await once(retired, 'connect');
  t.after(() => { retained.destroy(); retired.destroy(); });
  let events = 0; f.service.on('channels', () => events++);
  f.setHosts([B, C]); assert.equal(await f.service.refreshNetwork(), true); await until(() => retired.destroyed);
  const nextC = local(f.service, C); assert.ok(nextC);
  assert.equal(local(f.service, A), undefined); assert.equal(local(f.service, B)?.url, firstB.url); assert.equal(retained.destroyed, false);
  assert.equal(f.binds.filter(row => row.host === B).length, 1); assert.equal(f.service.manager.entries.get('cloudflare'), publicEntry);
  assert.equal(f.service.peerId(), peerId); assert.equal(await readFile(join(f.state, 'network-identity.json'), 'utf8'), identity);
  assert.equal(f.devices.list().length, 1); assert.equal(f.devices.list()[0].revoked, false);
  assert.equal(events, 1);
  const fresh = await manifest(f, nextC); assert.equal(fresh.peerId, peerId);
  assert.ok(fresh.payload.channels.some((/** @type {Value} */ row) => row.url === nextC.url)); assert.ok(!fresh.payload.channels.some((/** @type {Value} */ row) => row.url === firstA.url));
  const confirmedEvents = events; assert.equal(await f.service.refreshNetwork(), false); assert.equal(events, confirmedEvents);
  await assert.rejects(fetch('http://127.0.0.1:' + new URL(firstA.url).port + '/api/peer/channels'));
});

test('all interfaces disappearing closes stale listeners and returning interfaces reuse only their owned saved ports', async t => {
  const f = await fixture(t), before = local(f.service, B); assert.ok(before); const peer = f.service.peerId();
  f.setHosts([]); assert.equal(await f.service.refreshNetwork(), true);
  assert.equal(f.service.candidates().filter(row => row.kind === 'local').length, 0);
  assert.equal(f.service.manager.snapshot().channels.find(row => row.kind === 'local')?.state, 'unavailable');
  await assert.rejects(fetch('http://127.0.0.1:' + new URL(before.url).port + '/api/peer/channels'));
  f.setHosts([B]); assert.equal(await f.service.refreshNetwork(), true);
  assert.equal(local(f.service, B)?.url, before.url); assert.equal(f.service.peerId(), peer);
  assert.equal((await manifest(f, local(f.service, B))).peerId, peer);
});

test('a failed new-interface bind retries without changing retained routes or trusting another listener', async t => {
  const f = await fixture(t), before = local(f.service, B); assert.ok(before);
  f.failedHosts.add(C); f.setHosts([B, C]); await f.service.refreshNetwork();
  assert.equal(local(f.service, C), undefined); assert.equal(local(f.service, B)?.url, before.url);
  f.failedHosts.delete(C); await f.service.refreshNetwork();
  assert.ok(local(f.service, C)); assert.equal(local(f.service, B)?.url, before.url); assert.equal(f.binds.filter(row => row.host === B).length, 1);
  f.setHosts([]); await f.service.refreshNetwork();
  let occupantReads = 0; const occupant = createServer((_req, res) => { occupantReads++; res.end('not-Codelync'); });
  occupant.listen(Number(new URL(before.url).port), '127.0.0.1'); await once(occupant, 'listening');
  t.after(async () => { occupant.closeAllConnections(); await new Promise(resolve => occupant.close(resolve)); });
  f.setHosts([B]); await f.service.refreshNetwork(); const fallback = local(f.service, B); assert.ok(fallback);
  assert.notEqual(fallback.url, before.url); assert.equal((await manifest(f, fallback)).peerId, f.service.peerId()); assert.equal(occupantReads, 0);
});

test('disable during refresh fences late interface binds and interface watching recovers without service restart', async t => {
  const f = await fixture(t); f.setHosts([C]); const refreshing = f.service.refreshNetwork();
  await f.service.manager.setEnabled(['cloudflare']); await refreshing.catch(() => {});
  await until(() => f.service.gateways.size === 2); assert.equal(local(f.service, C), undefined);
  const bindCount = f.binds.length; await f.service.refreshNetwork(); assert.equal(f.binds.length, bindCount);
  await f.service.manager.setEnabled(['local', 'cloudflare']); await until(() => !!local(f.service, C));
  assert.equal((await manifest(f, local(f.service, C))).peerId, f.service.peerId());
});

test('running interface watcher refreshes the route manifest automatically', async t => {
  const f = await fixture(t, 1000), peer = f.service.peerId(); f.setHosts([C]);
  await until(() => !!local(f.service, C) && !local(f.service, A) && !local(f.service, B));
  assert.equal((await manifest(f, local(f.service, C))).peerId, peer);
});

test('an interface removed during a late bind is closed before its URL can be advertised', async t => {
  const f = await fixture(t), retained = local(f.service, B); assert.ok(retained);
  f.setHosts([B, C]); f.beforeBind(host => { if (host === C) f.setHosts([B]); });
  const observed = /** @type {Value[]} */ ([]); f.service.on('channels', value => observed.push(value));
  await f.service.refreshNetwork();
  assert.equal(local(f.service, C), undefined); assert.equal(local(f.service, B)?.url, retained.url);
  assert.equal(f.binds.find(row => row.host === C)?.server.listening, false);
  assert.ok(observed.every(value => value.channels.every((/** @type {Value} */ channel) => !channel.url.includes(C))));
});

test('[N06] a closed owned LAN listener is withdrawn immediately and repaired with retained same-peer routes', async t => {
  const f = await fixture(t), before = local(f.service, A), retained = local(f.service, B); assert.ok(before && retained);
  const peer = f.service.peerId(), publicEntry = f.service.manager.entries.get('cloudflare');
  const gateway = f.binds.find(row => row.host === A)?.server; assert.ok(gateway);
  await f.service.closeGateway(gateway);
  assert.equal(local(f.service, A), undefined);
  assert.equal(local(f.service, B)?.url, retained.url);
  assert.equal(f.service.manager.entries.get('cloudflare'), publicEntry);
  await assert.rejects(fetch('http://127.0.0.1:' + new URL(before.url).port + '/api/peer/channels'));
  await f.service.refreshNetwork(); const repaired = local(f.service, A); assert.ok(repaired);
  assert.equal(repaired.url, before.url); assert.equal(local(f.service, B)?.url, retained.url);
  assert.equal((await manifest(f, repaired)).peerId, peer);
  assert.equal(f.devices.list().length, 1); assert.equal(f.devices.list()[0].revoked, false);
});

test('live current private interfaces retire an owned route and authenticate the new same-peer LAN without service restart', { skip: process.env.CODELYNC_LAN_LIVE_INTEGRATION !== '1' }, async t => {
  const hosts = privateLANAddresses(networkInterfaces()); assert.ok(hosts.length >= 2, 'Live acceptance requires two current private interfaces');
  const oldHost = hosts.at(-2), nextHost = hosts.at(-1); assert.ok(oldHost && nextHost);
  const state = await mkdtemp(join(tmpdir(), 'codelync-lan-live-'));
  const phone = nacl.box.keyPair(), mac = nacl.box.keyPair(), token = 'synthetic-live-lan-token';
  const account = { secret: randomBytes(32).toString('base64url') }, devices = new DeviceRegistry(join(state, 'devices.json'));
  await devices.approve(Buffer.from(phone.publicKey).toString('base64url'), 'Synthetic live LAN device', token);
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { ...account, token } });
  let selected = [oldHost];
  const service = new MacConnectionService({ state, cloudflared: 'unused', upstream: 'http://127.0.0.1:9', account, devices, invitations, networkWatchMs: 1000,
    daemon: /** @type {any} */ ({ sources: new Map(), actors: new Map(), closed: false, ownsLease: true, inventoryAvailable: true }),
    interfaces: () => ({ current: selected.map(address => ({ address, family: 'IPv4', internal: false })) }),
    managerFactory: options => new ConnectionChannelsManager({ ...options, transportFactory: () => new Tunnel(), probesFor: () => ({ verify: async () => {} }) }) });
  t.after(async () => { await service.close(); invitations.close(); await rm(state, { recursive: true, force: true }); });
  await service.start(); await until(() => !!local(service, oldHost)); const before = local(service, oldHost); assert.ok(before);
  const peerId = service.peerId(); assert.equal((await manifest({ phone, mac, token }, before, true)).peerId, peerId);
  const oldSocket = createConnection({ host: oldHost, port: Number(new URL(before.url).port) }); oldSocket.on('error', () => {}); await once(oldSocket, 'connect'); t.after(() => oldSocket.destroy());
  const publicEntry = service.manager.entries.get('cloudflare'); selected = [nextHost];
  await until(() => !!local(service, nextHost) && !local(service, oldHost)); await until(() => oldSocket.destroyed);
  const current = local(service, nextHost); assert.ok(current);
  const fresh = await manifest({ phone, mac, token }, current, true);
  assert.equal(fresh.peerId, peerId); assert.ok(fresh.payload.channels.some((/** @type {Value} */ channel) => channel.url === current.url));
  assert.ok(!fresh.payload.channels.some((/** @type {Value} */ channel) => channel.url === before.url));
  assert.equal(service.manager.entries.get('cloudflare'), publicEntry);
  assert.equal(devices.list().length, 1); assert.equal(devices.list()[0].revoked, false);
  await assert.rejects(fetch(before.url + '/api/peer/channels'));
  console.log(JSON.stringify({ livePrivateLanRefresh: true, oldOwnedSocketClosed: true, newRouteAuthenticated: true, samePeerRetained: true, originalRuntimeRestarts: 0 }));
});
