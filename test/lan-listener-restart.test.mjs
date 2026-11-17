import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, lstat, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { MacConnectionService } from '../src/codelync/mac-connection-service.mjs';
import { createPairingGateway, PairingInvitations } from '../src/codelync/pairing-gateway.mjs';
import { DeviceRegistry } from '../src/codelync/device-registry.mjs';
import { parseLanListenerPorts, readLanListenerPorts } from '../src/codelync/lan-listener-ports.mjs';

/** @typedef {Record<string,any>} Value */
const HOST = '192.168.50.2';
const interfaces = { en0: [{ address: HOST, family: 'IPv4', internal: false }] };

/** @param {import('node:test').TestContext} t */
async function context(t) {
  const state = await mkdtemp(join(tmpdir(), 'codelync-listener-restart-'));
  const phone = nacl.box.keyPair(), mac = nacl.box.keyPair(), token = 'synthetic-listener-device-token';
  const account = { secret: randomBytes(32).toString('base64url') }, devices = new DeviceRegistry(join(state, 'devices.json'));
  const deviceId = await devices.approve(Buffer.from(phone.publicKey).toString('base64url'), 'Synthetic listener phone', token);
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { ...account, token, deviceId } });
  /** @type {MacConnectionService[]} */ const services = [];
  /** @type {Value[]} */ const requested = [];
  const make = async () => {
    const service = new MacConnectionService({ state, cloudflared: 'unused', upstream: 'http://127.0.0.1:9', account, devices, invitations,
      daemon: /** @type {any} */ ({ sources: new Map(), actors: new Map(), closed: false, ownsLease: true, inventoryAvailable: true }), interfaces: () => interfaces,
      gatewayFactory: options => {
        const server = createPairingGateway(options), listen = server.listen.bind(server);
        server.listen = /** @type {typeof server.listen} */ ((/** @type {number} */ port, /** @type {string} */ host) => {
          requested.push({ port, host }); return listen(port, '127.0.0.1');
        });
        return server;
      } });
    services.push(service);
    const entry = await service.startLocal(new AbortController().signal);
    // Exercise the real private entry/proof handlers while avoiding external
    // transport startup. Every actual test socket is bound to loopback.
    service.manager.saved.enabledChannels = ['local'];
    service.manager.entries.set('local', { channels: entry.channels, state: 'ready', transport: entry, cancel: new AbortController(), verification: 0 });
    return service;
  };
  t.after(async () => { await Promise.allSettled(services.map(service => service.close())); invitations.close(); await rm(state, { recursive: true, force: true }); });
  return { state, phone, mac, token, make, requested };
}

/** @param {Value} f @param {Value} channel */
function proof(f, channel) {
  const nonce = randomBytes(24), payload = { version: 2, token: f.token, origin: channel.url, method: 'GET', path: '/api/peer/channels', at: Date.now() };
  return 'Codelync ' + Buffer.from(JSON.stringify({ publicKey: Buffer.from(f.phone.publicKey).toString('base64url'), nonce: nonce.toString('base64url'),
    ciphertext: Buffer.from(nacl.box(Buffer.from(JSON.stringify(payload)), nonce, f.mac.publicKey, f.phone.secretKey)).toString('base64url') })).toString('base64url');
}

/** @param {Value} channel */
function requestUrl(channel) { return 'http://127.0.0.1:' + new URL(channel.url).port + '/api/peer/channels'; }

test('closing and restarting a profile preserves its private URL, peer and proof authority', async t => {
  const f = await context(t), first = await f.make(), before = first.candidates()[0];
  assert.ok(before); const identity = first.peerId();
  const auth = proof(f, before);
  assert.equal((await fetch(requestUrl(before), { headers: { Authorization: auth } })).status, 200);
  assert.equal((await fetch(requestUrl(before), { headers: { Authorization: auth } })).status, 401);
  assert.equal((await fetch(requestUrl(before), { headers: { Authorization: 'Bearer ' + f.token } })).status, 401);
  await first.close();
  const second = await f.make(), after = second.candidates()[0];
  assert.equal(after.url, before.url); assert.equal(second.peerId(), identity);
  assert.equal(f.requested[1].port, Number(new URL(before.url).port));
  assert.equal((await fetch(requestUrl(after), { headers: { Authorization: proof(f, after) } })).status, 200);
  const path = join(f.state, 'lan-listeners.json'), file = await lstat(path), raw = await readFile(path, 'utf8');
  assert.equal(file.mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['listeners', 'version']);
  assert.equal(raw.includes(f.token), false); assert.equal(raw.includes('secret'), false); assert.equal(raw.includes('invite'), false);
});

test('an occupied saved port falls back to a new owned listener without using its occupant', async t => {
  const f = await context(t), first = await f.make(), before = first.candidates()[0]; await first.close();
  let occupantRequests = 0;
  const occupant = createServer((_req, res) => { occupantRequests++; res.end('not-Codelync'); });
  occupant.listen(Number(new URL(before.url).port), '127.0.0.1'); await once(occupant, 'listening');
  t.after(async () => { occupant.closeAllConnections(); await new Promise(resolve => occupant.close(resolve)); });
  const second = await f.make(), after = second.candidates()[0];
  assert.notEqual(after.url, before.url);
  assert.deepEqual(f.requested.slice(-2).map(row => row.port), [Number(new URL(before.url).port), 0]);
  assert.equal((await fetch(requestUrl(after), { headers: { Authorization: proof(f, after) } })).status, 200);
  assert.equal(occupantRequests, 0);
  assert.equal((await readLanListenerPorts(f.state)).get(HOST), Number(new URL(after.url).port));
});

test('malformed, unsafe or foreign-interface saved data cannot supply listeners', async t => {
  const f = await context(t), path = join(f.state, 'lan-listeners.json');
  for (const value of [{ version: 2, listeners: [{ host: HOST, port: 52000 }] },
    { version: 1, listeners: [{ host: '127.0.0.2', port: 52000 }] },
    { version: 1, listeners: [{ host: '8.8.8.8', port: 52000 }] },
    { version: 1, listeners: [{ host: HOST, port: 80 }] },
    { version: 1, listeners: [{ host: HOST, port: 52000 }], token: 'not-allowed' }]) assert.deepEqual(parseLanListenerPorts(value), []);
  await writeFile(path, '{invalid-json', { mode: 0o600 });
  assert.equal((await readLanListenerPorts(f.state)).size, 0);
  const service = await f.make(); assert.equal(f.requested[0].port, 0); await service.close();
  await writeFile(path, JSON.stringify({ version: 1, listeners: [{ host: '192.168.60.2', port: 52000 }] }), { mode: 0o600 });
  const current = await f.make(); assert.equal(f.requested.at(-1)?.port, 0);
  assert.ok(f.requested.every(row => row.host === HOST)); assert.equal(current.candidates().length, 1);
  assert.deepEqual([...await readLanListenerPorts(f.state)].map(([host]) => host), [HOST]);
});

test('a failed hint write retains the owned functioning entry', async t => {
  const f = await context(t);
  await mkdir(join(f.state, 'lan-listeners.json'));
  const service = await f.make(), channel = service.candidates()[0];
  assert.ok(channel);
  assert.equal((await fetch(requestUrl(channel), { headers: { Authorization: proof(f, channel) } })).status, 200);
  assert.equal((await readLanListenerPorts(f.state)).size, 0);
  assert.equal(service.gateways.size, 1);
});
