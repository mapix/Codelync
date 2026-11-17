import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { MacConnectionService, privateLANAddresses } from '../src/codelync/mac-connection-service.mjs';

test('VPN tunnel addresses cannot be advertised as physical LAN entries', () => {
  assert.deepEqual(privateLANAddresses({
    en0: [{ address: '192.168.50.2', family: 'IPv4', internal: false }],
    utun0: [{ address: '10.0.0.2', family: 'IPv4', internal: false }],
    ppp0: [{ address: '172.16.3.4', family: 'IPv4', internal: false }],
  }), ['192.168.50.2']);
});

test('network-probe proves the same paired Mac without reading sources through every enabled gateway', async t => {
  const f = await fixture(t);
  await f.service.manager.configureRelay({ serverUrl: 'https://fixture-relay.example', token: 'synthetic-relay-token' });
  f.daemon.registrationAvailable = false;
  for (const kind of /** @type {('local'|'cloudflare'|'relay')[]} */ (['local', 'cloudflare', 'relay'])) {
    const channel = f.service.candidates().find(row => row.kind === kind); assert.ok(channel);
    const path = '/network-probe';
    const url = kind === 'local' ? localRequestUrl(channel, path) : f.service.publicGateways.get(kind)?.origin + path;
    const authorization = header(f, channel, path);
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { Authorization: authorization } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text(); assert.ok(text.length < 512);
    assert.deepEqual(unseal(f, JSON.parse(text)).payload, { version: 1 });
    assert.equal((await fetch(url, { headers: { Authorization: authorization } })).status, 401);
    const query = path + '?history=true';
    assert.equal((await fetch(url + '?history=true', { headers: { Authorization: header(f, channel, query) } })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: header(f, channel, path, 'POST') } })).status, 405);
  }
  assert.equal(f.counters().reads, 0); assert.equal(f.counters().preparations, 0); assert.equal(f.counters().starts, 0);
});
import { ConnectionChannelsManager } from '../src/network/connection-channels.mjs';
import { PairingInvitations, createPairingGateway } from '../src/codelync/pairing-gateway.mjs';
import { DeviceRegistry } from '../src/codelync/device-registry.mjs';
import { channelPath } from '@codelync/wire/codelync';

/** @typedef {Record<string,any>} Value */
const LAN = { en0: [{ address: '192.168.50.2', family: 'IPv4', internal: false }] };
/** @param {()=>boolean} predicate */
async function until(predicate) { for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.ok(predicate()); }
class Tunnel extends EventEmitter {
  /** @param {string} origin */
  constructor(origin) { super(); this.origin = origin; }
  async start() { return this.origin; } activate() {} close() {}
}
/** @param {import('node:test').TestContext} t @param {string} [sourceApp] */
async function fixture(t, sourceApp = 'codex') {
  const state = await mkdtemp(join(tmpdir(), 'codelync-mac-connections-')), phone = nacl.box.keyPair(), mac = nacl.box.keyPair();
  const token = 'synthetic-device-token', account = { secret: randomBytes(32).toString('base64url') }, devices = new DeviceRegistry(join(state, 'devices.json'));
  const deviceId = await devices.approve(Buffer.from(phone.publicKey).toString('base64url'), 'Fixture phone', token);
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { ...account, token, deviceId } });
  let backendHeaders = /** @type {Value|null} */ (null), reads = 0, starts = 0, preparations = 0;
  const backend = createServer((req, res) => { backendHeaders = req.headers; res.end('synthetic-backend'); }); backend.listen(0, '127.0.0.1'); await once(backend, 'listening'); const address = backend.address(); assert.ok(address && typeof address !== 'string');
  const selected = { source: { app: sourceApp, id: 'native-fixture', kind: 'session', title: 'Fixture session', hostId: sourceApp === 'antigravity' ? 'local:antigravity:' + 'a'.repeat(64) : 'fixture-host', updatedAt: Date.now(),
    ...(sourceApp === 'antigravity' ? { protocol: 'antigravity-connect', runtimeGeneration: 'fixture-owner', parentId: 'native-parent', isSubagent: true } : {}) },
    binding: { happySessionId: 'mirror-fixture', machineId: 'machine-fixture', sessionKey: Buffer.alloc(32, 8).toString('base64'), metadata: { nativeSession: { catalogueAvailable: true } } } };
  const uses = new Map(), actors = new Map();
  const actor = { status: () => ({ sourceStatus: 'connected' }), transport: { peerSnapshot: () => ({ metadata: selected.binding.metadata }) }, connector: { readRecent: async (/** @type {Value} */ options) => {
    assert.ok((uses.get('fixture-source') ?? 0) > 0, 'source must remain pinned throughout the native read'); reads++; return { rows: [{ id: 'latest', role: 'assistant', turnId: 'fixture-turn', text: 'synthetic-current' }], hasMore: false, nextCursor: null, fresh: options.fresh };
  } }, openDesktop: () => { throw Error('recent reads must not navigate desktop'); } };
  const daemon = { sources: new Map([['fixture-source', selected]]), actors, closed: false, ownsLease: true, inventoryAvailable: true, registrationAvailable: true, machine: { id: 'machine-fixture' },
    useSource: async (/** @type {string} */ key, /** @type {()=>Promise<Value>} */ operation) => { uses.set(key, (uses.get(key) ?? 0) + 1); try { return await operation(); } finally { uses.set(key, uses.get(key) - 1); } },
    prepareSource: async (/** @type {string} */ key) => { assert.equal(key, 'fixture-source'); preparations++; actors.set(key, actor); return actor; },
    startSource: async (/** @type {string} */ key, /** @type {Value} */ value) => { assert.equal(key, 'fixture-source'); assert.equal(value, actor); starts++; } };
  const gatewayOptions = /** @type {Value[]} */ ([]), requestedHosts = /** @type {string[]} */ ([]);
  const service = new MacConnectionService({ state, cloudflared: 'unused', upstream: 'http://127.0.0.1:' + address.port, account, devices, invitations, daemon: /** @type {import('../src/codelync/mac-daemon.mjs').CodelyncMacDaemon} */ (/** @type {unknown} */ (daemon)),
    interfaces: () => LAN,
    gatewayFactory: options => { gatewayOptions.push(options); const server = createPairingGateway(options), listen = server.listen.bind(server);
      server.listen = /** @type {typeof server.listen} */ ((/** @type {number} */ port, /** @type {string} */ host) => { requestedHosts.push(host); return listen(port, '127.0.0.1'); }); return server; },
    managerFactory: options => new ConnectionChannelsManager({ ...options, transportFactory: config => new Tunnel(config.kind === 'relay' ? config.serverUrl + '/r/' + 'a'.repeat(24) : 'https://fixture-public.example'), probesFor: () => ({ verify: async () => {} }) }) });
  t.after(async () => { await service.close(); invitations.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); await rm(state, { recursive: true, force: true }); });
  await service.start(); await until(() => service.candidates().some(row => row.kind === 'local'));
  return { service, phone, mac, token, account, devices, deviceId, daemon, gatewayOptions, requestedHosts, counters: () => ({ reads, starts, preparations, backendHeaders }) };
}
/** @param {Value} f @param {Value} channel @param {string} path @param {string} [method] */
function header(f, channel, path, method = 'GET') {
  const nonce = randomBytes(24), payload = { version: 2, token: f.token, origin: channel.url, method, path: channelPath(channel.url, channel.url + path), at: Date.now() };
  return 'Codelync ' + Buffer.from(JSON.stringify({ publicKey: Buffer.from(f.phone.publicKey).toString('base64url'), nonce: nonce.toString('base64url'),
    ciphertext: Buffer.from(nacl.box(Buffer.from(JSON.stringify(payload)), nonce, f.mac.publicKey, f.phone.secretKey)).toString('base64url') })).toString('base64url');
}
/** The fixture intercepts requested binds to keep every test listener on loopback.
 * @param {Value} channel @param {string} path */
function localRequestUrl(channel, path) { return 'http://127.0.0.1:' + new URL(channel.url).port + path; }
/** @param {Value} f @param {Value} value */
function unseal(f, value) { const plain = nacl.box.open(Buffer.from(value.ciphertext, 'base64url'), Buffer.from(value.nonce, 'base64url'), f.mac.publicKey, f.phone.secretKey); assert.ok(plain); return JSON.parse(Buffer.from(plain).toString()); }

test('sealed HTTP activity serves the existing Mac replica without native source or WebSocket preparation', async t => {
  const f = await fixture(t);
  let polls = 0;
  const daemon = /** @type {Value} */ (f.daemon);
  daemon.activity = { poll: (/** @type {Value} */ request) => ({ ok: true, version: 1, epoch: 'native-status-owner', sequence: ++polls, observedAt: Date.now(),
    groups: request.groups.map((/** @type {Value} */ group) => ({ id: group.id, total: 1, active: 1, waiting: 0, unknown: 0, status: 'ready' })) }) };
  const channel = f.service.candidates().find(row => row.kind === 'local'), path = '/api/peer/activity';
  assert.ok(channel);
  const send = async (/** @type {Value} */ body) => {
    const response = await fetch(localRequestUrl(channel, path), { method: 'POST', headers: { Authorization: header(f, channel, path, 'POST'), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return unseal(f, await response.json()).payload;
  };
  const first = await send({ clientId: 'phone-view', requestSeq: 1, activityProtocol: 2, groups: [{ id: 'project', projectKey: '/fixture', hostId: 'local' }] });
  assert.equal(first.mode, 'full'); assert.equal(first.groups[0].active, 1); assert.equal(first.machineId, 'machine-fixture');
  const next = await send({ clientId: 'phone-view', requestSeq: 2, activityProtocol: 2, interestToken: first.interestToken, since: first.watermark });
  assert.equal(next.mode, 'unchanged'); assert.deepEqual(next.groups, []);
  const large = await send({ clientId: 'phone-view', requestSeq: 3, activityProtocol: 2, groups: [{ id: 'project-' + 'x'.repeat(5000), projectKey: '/fixture', hostId: 'local' }] });
  assert.equal(large.mode, 'full'); assert.equal(large.groups.length, 1);
  assert.deepEqual(f.counters(), { reads: 0, starts: 0, preparations: 0, backendHeaders: null });
  f.daemon.ownsLease = false;
  await assert.rejects(f.service.peerApi(path, 'POST', { clientId: 'phone-view', requestSeq: 4, groups: [] }, f.deviceId), { code: 'source-unavailable' });
});

test('LAN discovery selects at most three distinct actual private IPv4 addresses', () => {
  const interfaces = { test: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '8.8.8.8', family: 'IPv4', internal: false }, { address: '192.168.1.2', family: 'IPv4', internal: false },
    { address: '192.168.1.2', family: 'IPv4', internal: false }, { address: '10.0.0.2', family: 'IPv4', internal: false }, { address: '172.20.1.2', family: 'IPv4', internal: false }, { address: '10.0.0.3', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }] };
  const rows = privateLANAddresses(interfaces); assert.equal(rows.length, 3); assert.equal(new Set(rows).size, 3);
  assert.ok(rows.every(row => !['127.0.0.1', '8.8.8.8', 'fe80::1', '0.0.0.0'].includes(row)));
});

test('[N07] malformed IPv4 and mislabeled IPv6 records cannot become DNS or loopback LAN binds', () => {
  const interfaces = { synthetic: [
    { address: '10..0.1', family: 'IPv4', internal: false },
    { address: '192.168.50.02', family: 'IPv4', internal: false },
    { address: '10.0.0.3 ', family: 'IPv4', internal: false },
    { address: '[::1]', family: 'IPv4', internal: false },
    { address: 'fd00::1', family: 'IPv4', internal: false },
    { address: '10.0.0.3', family: 'IPv6', internal: false },
    { address: '10.0.0.2', family: 4, internal: false }
  ] };
  assert.deepEqual(privateLANAddresses(interfaces), ['10.0.0.2']);
});

test('[N05] concurrent service shutdown joins the same owned gateway cleanup', async t => {
  const f = await fixture(t), first = f.service.close(), second = f.service.close();
  try { assert.equal(first, second); }
  finally { await Promise.all([first, second]); }
  assert.equal(f.service.gateways.size, 0); assert.deepEqual(f.service.candidates(), []);
});

test('Mac composition shares one proof/account/daemon, uses distinct public gateways and does not rotate QR on repeated readiness confirmation', async t => {
  const f = await fixture(t);
  assert.equal(f.gatewayOptions.length, 3); assert.equal(new Set(f.gatewayOptions.map(row => row.proof)).size, 1);
  assert.ok(f.gatewayOptions.every(row => row.invitations === f.gatewayOptions[0].invitations && row.devices === f.devices));
  assert.deepEqual(f.requestedHosts, ['127.0.0.1', '127.0.0.1', '192.168.50.2']);
  const first = f.service.pairing(); assert.ok(first && new URL(first.pairingUrl).searchParams.get('v') === '2');
  const local = f.service.candidates().find(row => row.kind === 'local'); assert.ok(local);
  assert.equal(f.service.manager.confirm('local', local.url), true); assert.equal(f.service.pairing(), null);
  const encodedChoices = new URL(first.pairingUrl).searchParams.get('channels'); assert.ok(encodedChoices); const choices = JSON.parse(Buffer.from(encodedChoices, 'base64url').toString()); assert.equal(choices.length, 2);
  await f.service.manager.setEnabled([]); const empty = f.service.pairing(); assert.equal(empty?.pairingUrl, ''); assert.equal(empty?.origin, '');
  assert.equal(f.daemon.closed, false); assert.deepEqual(f.counters(), { reads: 0, starts: 0, preparations: 0, backendHeaders: null });
});

test('LAN rejects a raw bearer and exposes peer channels only as a pinned sealed response', async t => {
  const f = await fixture(t), local = f.service.candidates().find(row => row.kind === 'local'); assert.ok(local);
  const path = '/api/peer/channels', url = localRequestUrl(local, path);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer ' + f.token } })).status, 401);
  const authorization = header(f, local, path), response = await fetch(url, { headers: { Authorization: authorization } }); assert.equal(response.status, 200);
  const value = await response.json(), text = JSON.stringify(value); assert.equal(text.includes(f.token), false); assert.equal(text.includes(local.url), false);
  const decoded = unseal(f, value); assert.equal(decoded.peerId, f.service.peerId()); assert.ok(decoded.payload.channels.some((/** @type {Value} */ row) => row.url === local.url));
  assert.equal((await fetch(url, { headers: { Authorization: authorization } })).status, 401);
});

test('Cloudflare and Relay gateways reject approved legacy tokens and require fresh device proofs', async t => {
  const f = await fixture(t);
  await f.service.manager.configureRelay({ serverUrl: 'https://fixture-relay.example', token: 'synthetic-relay-token' });
  for (const kind of /** @type {('cloudflare'|'relay')[]} */ (['cloudflare', 'relay'])) {
    const channel = f.service.candidates().find(row => row.kind === kind); assert.ok(channel);
    const gateway = f.service.publicGateways.get(kind); assert.ok(gateway);
    const path = '/v2/sessions', url = gateway.origin + path;
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer ' + f.token } })).status, 401);
    const authorization = header(f, channel, path);
    const response = await fetch(url, { headers: { Authorization: authorization } });
    assert.equal(response.status, 200); assert.equal(await response.text(), 'synthetic-backend');
    assert.equal(f.counters().backendHeaders?.authorization, 'Bearer ' + f.token);
    assert.equal((await fetch(url, { headers: { Authorization: authorization } })).status, 401);
  }
});

test('peer catalog is index-only and recent/history source reads remain pinned without desktop navigation', async t => {
  const f = await fixture(t), catalog = await f.service.peerApi('/api/peer/catalog?limit=200', 'GET', {}, f.deviceId);
  assert.equal(catalog.sessions[0].id, 'mirror-fixture'); assert.equal(catalog.sessions[0].sessionKey, undefined);
  assert.equal(f.counters().starts, 0); assert.equal(f.counters().reads, 0);
  const recent = await f.service.peerApi('/api/peer/sessions/mirror-fixture/recent', 'POST', { limit: 50 }, f.deviceId);
  assert.equal(recent.rows[0].text, 'synthetic-current'); assert.equal(recent.session.sessionKey.length > 0, true); assert.equal(f.counters().reads, 1);
  await assert.rejects(f.service.peerApi('/api/peer/sessions/mirror-fixture/history', 'GET', {}, f.deviceId), /cursor/);
  await assert.rejects(f.service.peerApi('/api/peer/sessions/foreign/recent', 'POST', {}, f.deviceId), /unavailable/);
  assert.equal(f.daemon.closed, false);
});

test('bodyless authenticated history GET uses query bounds without the recent POST body guard', async t => {
  const f = await fixture(t), local = f.service.candidates().find(row => row.kind === 'local'); assert.ok(local);
  const path = '/api/peer/sessions/mirror-fixture/history?cursor=known-history-boundary&limit=4';
  const response = await fetch(localRequestUrl(local, path), { headers: { Authorization: header(f, local, path) } });
  assert.equal(response.status, 200);
  assert.equal(unseal(f, await response.json()).payload.rows.length, 1);
  assert.equal(f.counters().reads, 1);
  await assert.rejects(f.service.peerApi(path, 'GET', { unexpected: true }, f.deviceId), { code: 'invalid-peer-request' });
  await assert.rejects(f.service.peerApi('/api/peer/sessions/mirror-fixture/recent', 'POST', /** @type {any} */ (undefined), f.deviceId), { code: 'invalid-peer-request' });
});

test('an incomplete other-app inventory preserves registered Codex and Antigravity child catalog/read authority', async t => {
  for (const sourceApp of ['codex', 'antigravity']) await t.test(sourceApp, async child => {
    const f = await fixture(child, sourceApp); f.daemon.inventoryAvailable = false;
    const catalog = await f.service.peerApi('/api/peer/catalog', 'GET', {}, f.deviceId);
    assert.equal(catalog.sessions[0].id, 'mirror-fixture'); assert.equal(f.counters().reads, 0); assert.equal(f.counters().preparations, 0);
    assert.equal(catalog.sessions[0].agentState, null); assert.equal(catalog.sessions[0].active, false);
    if (sourceApp === 'antigravity') {
      assert.equal(catalog.sessions[0].metadata.nativeSession.parentId, 'native-parent');
      assert.equal(catalog.sessions[0].metadata.nativeSession.isSubagent, true);
    }
    const recent = await f.service.peerApi('/api/peer/sessions/mirror-fixture/recent', 'POST', { limit: 1 }, f.deviceId);
    assert.equal(recent.rows[0].text, 'synthetic-current');
    const older = await f.service.peerApi('/api/peer/sessions/mirror-fixture/history?cursor=known-history-boundary&limit=1', 'GET', {}, f.deviceId);
    assert.equal(older.rows.length, 1); assert.equal(f.counters().reads, 2);
    f.daemon.ownsLease = false;
    await assert.rejects(f.service.peerApi('/api/peer/catalog', 'GET', {}, f.deviceId), { code: 'source-unavailable' });
    await assert.rejects(f.service.peerApi('/api/peer/sessions/mirror-fixture/recent', 'POST', { limit: 1 }, f.deviceId), { code: 'source-unavailable' });
    assert.equal(f.counters().reads, 2);
  });
});

test('catalog remains unavailable before registration completes or without its current machine and lease', async t => {
  const f = await fixture(t);
  f.daemon.registrationAvailable = false;
  await assert.rejects(f.service.peerApi('/api/peer/catalog', 'GET', {}, f.deviceId), { code: 'source-unavailable' });
  f.daemon.registrationAvailable = true; f.daemon.machine.id = '';
  await assert.rejects(f.service.peerApi('/api/peer/catalog', 'GET', {}, f.deviceId), { code: 'source-unavailable' });
  f.daemon.machine.id = 'machine-fixture';
  assert.equal((await f.service.peerApi('/api/peer/catalog', 'GET', {}, f.deviceId)).sessions.length, 1);
  f.daemon.closed = true;
  await assert.rejects(f.service.peerApi('/api/peer/catalog', 'GET', {}, f.deviceId), { code: 'source-unavailable' });
  assert.deepEqual(f.counters(), { reads: 0, starts: 0, preparations: 0, backendHeaders: null });
});

test('proof authorization replaces the token only on the owned backend link and revocation affects the same LAN entry', async t => {
  const f = await fixture(t), local = f.service.candidates().find(row => row.kind === 'local'); assert.ok(local);
  const path = '/v2/sessions', url = localRequestUrl(local, path), authorization = header(f, local, path);
  assert.equal(authorization.includes(f.token), false);
  const response = await fetch(url, { headers: { Authorization: authorization } }); assert.equal(response.status, 200); assert.equal(await response.text(), 'synthetic-backend');
  assert.equal(f.counters().backendHeaders?.authorization, 'Bearer ' + f.token);
  await f.devices.revoke(f.deviceId);
  assert.equal((await fetch(url, { headers: { Authorization: header(f, local, path) } })).status, 401);
});
