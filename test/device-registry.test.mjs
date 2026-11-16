import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DeviceRegistry } from '../src/happy/device-registry.mjs';
import { PairingInvitations, createPairingGateway } from '../src/happy/pairing-gateway.mjs';
import { gatewayProof } from './fixtures/gateway-proof.mjs';

test('device revocation closes only its connections and remains effective after reload', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'codelight-devices-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'devices.json'), devices = await DeviceRegistry.load(path);
  const first = await devices.approve('fixture-phone-key', 'Phone', 'phone-token'), second = await devices.approve('fixture-tablet-key', 'Tablet', 'tablet-token');
  await devices.rename(first, 'My phone'); const socket = new Socket(); devices.connected(first, socket);
  assert.equal(devices.list().find(row => row.id === first)?.connected, true);
  await devices.revoke(first); assert.equal(socket.destroyed, true); assert.equal(devices.authorize('phone-token'), null); assert.equal(devices.authorize('tablet-token'), second);
  const restored = await DeviceRegistry.load(path); assert.equal(restored.authorize('phone-token'), null); assert.equal(restored.list().find(row => row.id === first)?.name, 'My phone');
});
test('public gateway rejects legacy tokens, accepts approved device proofs and enforces revocation', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'codelight-admission-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const devices = await DeviceRegistry.load(join(folder, 'devices.json'));
  const upstream = createServer((_req, res) => res.end('{}')); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address(); assert.ok(address && typeof address !== 'string');
  const invitations = new PairingInvitations({ key: new Uint8Array(32), credentials: {} });
  const device = gatewayProof(invitations, { token: 'device-token', devices });
  const id = await devices.approve(device.publicKey, 'Phone', 'device-token');
  const gateway = createPairingGateway({ upstream: `http://127.0.0.1:${address.port}`, invitations, devices, proof: device.proof }); gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const local = gateway.address(); assert.ok(local && typeof local !== 'string'); const url = `http://127.0.0.1:${local.port}`;
  t.after(async () => { gateway.closeAllConnections(); await new Promise(r => gateway.close(r)); await new Promise(r => upstream.close(r)); invitations.close(); await devices.tail; });
  const headers = (/** @type {string} */ path, method = 'GET') => device.headers(path, method);
  for (const path of ['/v1/sessions', '/api/peer/channels', '/codelight/notifications/device', '/codelight/notifications/presence']) {
    assert.equal((await fetch(url + path, { method: path.includes('/notifications/') ? 'POST' : 'GET', headers: { Authorization: 'Bearer device-token' } })).status, 401);
  }
  const pushUrl = url + '/codelight/notifications/device';
  assert.equal((await fetch(pushUrl, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(pushUrl, { method: 'POST', headers: headers('/codelight/notifications/device', 'POST'), body: JSON.stringify({ enabled: true, token: 'a'.repeat(64), environment: 'development' }) })).status, 200);
  assert.equal(devices.notificationDevices().length, 1);
  assert.equal((await fetch(url + '/codelight/notifications/presence', { method: 'POST', headers: headers('/codelight/notifications/presence', 'POST'), body: JSON.stringify({ active: true, sessionId: 'session', sequence: 7 }) })).status, 200);
  assert.equal(devices.list()[0].connected, false);
  assert.deepEqual([...devices.viewedSessions()], ['session']);
  assert.equal((await fetch(url + '/codelight/notifications/presence', { method: 'POST', headers: headers('/codelight/notifications/presence', 'POST'), body: JSON.stringify({ active: false, sessionId: 'old-session', sequence: 6 }) })).status, 200);
  assert.deepEqual([...devices.viewedSessions()], ['session']);
  assert.equal((await fetch(url + '/v1/sessions')).status, 401); assert.equal((await fetch(url + '/v1/sessions', { headers: headers('/v1/sessions') })).status, 200);
  assert.equal((await fetch(url + '/v1/auth', { headers: headers('/v1/auth') })).status, 401); await devices.revoke(id);
  assert.equal((await fetch(url + '/v1/sessions', { headers: headers('/v1/sessions') })).status, 401);
  assert.equal(devices.viewedSessions().size, 0);
  assert.equal((await fetch(pushUrl, { method: 'POST', headers: headers('/codelight/notifications/device', 'POST'), body: '{}' })).status, 401); assert.equal(devices.notificationDevices().length, 0);
});

test('out-of-order foreground requests and legacy requests cannot overwrite a newer sequenced viewer', () => {
  const rows = [{ id: 'device', publicKey: 'fixture-only', revoked: false }], devices = new DeviceRegistry('/fixture/not-written.json', rows);
  assert.equal(devices.viewingPresence('device', { active: true, sessionId: 'current-session', sequence: 5 }), true);
  assert.equal(devices.viewingPresence('device', { active: false, sessionId: 'old-session', sequence: 4 }), false);
  assert.equal(devices.viewingPresence('device', { active: false, sessionId: 'old-session', sequence: 5 }), false);
  assert.equal(devices.viewingPresence('device', { active: false, sessionId: 'old-session' }), false);
  assert.equal(/** @type {any} */ (rows[0]).presence.sessionId, 'current-session');
  assert.equal(devices.viewingPresence('device', { active: true, sessionId: 'new-session', sequence: 6 }), true);
  assert.equal(/** @type {any} */ (rows[0]).presence.sessionId, 'new-session');
  assert.throws(() => devices.viewingPresence('device', { active: true, sessionId: 'bad', sequence: 0 }), /sequence/);
});

test('legacy presence remains compatible after a sequenced lease expires and sequence high-water remains fenced', () => {
  const now = Date.now();
  const rows = [{ id: 'device', presenceSequence: 10, presence: { active: true, sessionId: 'old-sequenced', at: now - 45001, sequence: 10 } }];
  const devices = new DeviceRegistry('/fixture/not-written.json', rows);
  assert.equal(devices.viewingPresence('device', { active: true, sessionId: 'legacy-current' }), true);
  assert.equal(devices.viewingPresence('device', { active: true, sessionId: 'late-old-sequenced', sequence: 9 }), false);
  assert.equal(rows[0].presence.sessionId, 'legacy-current');
  assert.equal(devices.viewingPresence('device', { active: true, sessionId: 'new-sequenced', sequence: 11 }), true);
});

test('fresh approved foreground leases survive socket loss and require a bounded nonfuture heartbeat', () => {
  const now = 1_000_000;
  const rows = [
    { id: 'fresh', presence: { active: true, sessionId: 'happy-fresh', at: now } },
    { id: 'same-session', presence: { active: true, sessionId: 'happy-fresh', at: now - 15000 } },
    { id: 'edge', presence: { active: true, sessionId: 'happy-edge', at: now - 45000 } },
    { id: 'expired', presence: { active: true, sessionId: 'happy-expired', at: now - 45001 } },
    { id: 'future', presence: { active: true, sessionId: 'happy-future', at: now + 1 } },
    { id: 'background', presence: { active: false, sessionId: 'happy-background', at: now } },
    { id: 'revoked', revoked: true, presence: { active: true, sessionId: 'happy-revoked', at: now } },
    { id: 'empty', presence: { active: true, sessionId: ' ', at: now } },
    { id: 'http-only', presence: { active: true, sessionId: 'happy-http-only', at: now } },
  ];
  const before = JSON.stringify(rows), devices = new DeviceRegistry('/fixture/not-written.json', rows), sockets = new Map();
  for (const row of rows) if (row.id !== 'http-only') { const socket = new Socket(); sockets.set(row.id, socket); devices.connected(row.id, socket); }
  try {
    assert.deepEqual([...devices.viewedSessions(now)].sort(), ['happy-edge', 'happy-fresh', 'happy-http-only']);
    sockets.get('fresh').emit('close'); sockets.get('same-session').emit('close');
    assert.deepEqual([...devices.viewedSessions(now)].sort(), ['happy-edge', 'happy-fresh', 'happy-http-only']);
    assert.deepEqual([...devices.viewedSessions(now + 1)].sort(), ['happy-fresh', 'happy-future', 'happy-http-only']);
    assert.equal(devices.viewedSessions(now + 45002).size, 0); assert.equal(JSON.stringify(rows), before);
  } finally { for (const socket of sockets.values()) socket.destroy(); }
});
