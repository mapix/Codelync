import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { TokenVerifier } from 'livekit-server-sdk';
import { RemoteDesktop, desktopConfiguration, desktopQuality } from '../src/happy/remote-desktop.mjs';

/** @typedef {Record<string,any>} Value */
/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const state = await mkdtemp(join(tmpdir(), 'codelight-desktop-'));
  const mac = nacl.box.keyPair(), phone = nacl.box.keyPair(), other = nacl.box.keyPair();
  const devices = Object.assign(new EventEmitter(), { revoked: false, publicKey(/** @type {string} */ id) { return id === 'phone' && !this.revoked ? Buffer.from(phone.publicKey).toString('base64url') : id === 'other' ? Buffer.from(other.publicKey).toString('base64url') : null; } });
  const calls = /** @type {Value[]} */ ([]), relayCalls = /** @type {Value[]} */ ([]), display = { id: '1', name: 'Main display', width: 3000, height: 2000, geometry: 'geometry-1' };
  const permissions = { screenRecording: true, accessibility: true, locked: false };
  const secondDisplay = { id: '2', name: 'Display 2', width: 2560, height: 1440, geometry: 'geometry-2' };
  let currentDisplay = display, track = 0;
  let spaceEnabled = true, spaceConfirmed = true, pendingView = false, spaceRevision = 0;
  const host = Object.assign(new EventEmitter(), { async request(/** @type {string} */ operation, /** @type {Value} */ value = {}) {
    calls.push({ operation, value });
    if (operation === 'displays') return { displays: [display, secondDisplay], permissions };
    if (operation === 'display') currentDisplay = value.displayId === '2' ? secondDisplay : display;
    if (operation === 'space') {
      if (!spaceEnabled) throw Object.assign(Error('disabled'), { code: 'desktop-space-shortcut-disabled' });
      currentDisplay = { ...currentDisplay, geometry: 'space-' + ++spaceRevision }; pendingView = true;
      host.emit('view-invalidated', value.connectionId);
    }
    if (['start', 'quality', 'display', 'space'].includes(operation) || operation === 'heartbeat' && pendingView) { track++; pendingView = false; }
    return { ...value, capturing: true, connected: true, viewerConnected: true, permissions, geometry: currentDisplay.geometry, trackSid: 'track-' + track, viewPending: false,
      ...(operation === 'display' ? { display: currentDisplay } : {}), ...(operation === 'space' ? { spaceChanged: spaceConfirmed, accepted: true } : {}) };
  }, async close() { calls.push({ operation: 'close' }); } });
  const rooms = { async createRoom(/** @type {Value} */ value) { relayCalls.push({ create: value }); }, async deleteRoom(/** @type {string} */ value) { relayCalls.push({ delete: value }); } };
  const relay = { async start() { relayCalls.push({ start: true }); return { url: 'ws://127.0.0.1:7999', apiKey: 'test-api-key', apiSecret: 'a'.repeat(64), rooms }; }, async close() { relayCalls.push({ close: true }); } };
  const desktop = new RemoteDesktop({ state, devices, macSecretKey: mac.secretKey, hostBinary: '/unused', relayBinary: '/unused', hostFactory: () => host, relayFactory: () => relay });
  t.after(async () => { await desktop.close(); await rm(state, { recursive: true, force: true }); });
  const seal = (/** @type {string} */ action, /** @type {Value} */ value = {}, pair = phone) => {
    const nonce = randomBytes(24), plaintext = Buffer.from(JSON.stringify({ version: 1, at: Date.now(), action, ...value }));
    return { version: 1, nonce: nonce.toString('base64url'), ciphertext: Buffer.from(nacl.box(plaintext, nonce, mac.publicKey, pair.secretKey)).toString('base64url') };
  };
  const request = (/** @type {string} */ action, /** @type {Value} */ value = {}, device = 'phone', pair = phone) => desktop.api(action, 'POST', seal(action, value, pair), device, 'https://paired.example/r/012345678901234567890123');
  const connect = async () => {
    await desktop.configure({ enabled: true });
    const grant = await request('join', { displayId: '1' });
    const binding = { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry };
    await request('ready', { ...binding, trackSid: grant.trackSid }); return { grant, binding };
  };
  return { desktop, devices, permissions, calls, relayCalls, display, seal, request, connect, other, state,
    setSpaceEnabled: (/** @type {boolean} */ value) => { spaceEnabled = value; },
    setSpaceConfirmed: (/** @type {boolean} */ value) => { spaceConfirmed = value; },
    macSpaceChanged: () => {
      currentDisplay = { ...currentDisplay, geometry: 'space-' + ++spaceRevision }; pendingView = true;
      host.emit('view-invalidated', desktop.active?.id);
    } };
}

test('remote desktop defaults to off, without spawning a helper, relay or creating a session', async t => {
  const f = await fixture(t); const status = await f.desktop.load();
  assert.equal(status.enabled, false); assert.equal(status.mode, 'local'); assert.deepEqual(f.calls, []); assert.deepEqual(f.relayCalls, []);
  await assert.rejects(f.request('join', { displayId: '1' }), { code: 'desktop-disabled' });
});

test('settings persist privately and status never contains the external secret', async t => {
  const f = await fixture(t);
  await f.desktop.configure({ enabled: true, mode: 'external', url: 'wss://media.example', apiKey: 'api-key', apiSecret: 's'.repeat(64) });
  const saved = JSON.parse(await readFile(join(f.state, 'remote-desktop.json'), 'utf8'));
  assert.equal(saved.apiSecret.length, 64); assert.equal('apiSecret' in f.desktop.status(), false);
  assert.throws(() => desktopConfiguration({ ...saved, url: 'http://public.example' }), { code: 'invalid-desktop-server' });
  assert.throws(() => desktopConfiguration({ ...saved, url: 'https://user:pass@media.example' }), { code: 'invalid-desktop-server' });
  assert.deepEqual(f.relayCalls, []);
});

test('joins produce device-bound restricted JWT and a fresh independent encryption key', async t => {
  const f = await fixture(t); const { grant } = await f.connect();
  const claims = await new TokenVerifier('test-api-key', 'a'.repeat(64)).verify(grant.token);
  assert.ok(claims.video && claims.sub);
  assert.equal(claims.video.canPublish, false); assert.equal(claims.video.canPublishData, false);
  assert.match(claims.sub, /^viewer-phone-/u); assert.equal(claims.video.room, 'codelight-desktop-' + grant.connectionId);
  assert.equal(Buffer.from(grant.key, 'base64url').length, 32);
  assert.equal(grant.url, 'https://paired.example/r/012345678901234567890123/api/peer/desktop/media');
  assert.equal(JSON.stringify(f.desktop.status()).includes(grant.key), false);
  assert.equal(f.calls.some(call => JSON.stringify(call).includes('sessionId')), false);
});

test('plaintext, expired and cross-device sealed actions fail before OS dispatch', async t => {
  const f = await fixture(t); await f.desktop.configure({ enabled: true });
  await assert.rejects(f.desktop.api('join', 'POST', { displayId: '1' }, 'phone', 'https://paired.example'), { code: 'invalid-desktop-request' });
  await assert.rejects(f.desktop.api('join', 'POST', f.seal('join', { displayId: '1' }, f.other), 'phone', 'https://paired.example'), { code: 'invalid-desktop-request' });
  await assert.rejects(f.request('join', { displayId: '1', at: Date.now() - 100_000 }), { code: 'desktop-request-expired' });
  assert.equal(f.calls.length, 0);
});

test('OS input is bound to the active connection, geometry and increasing sequence', async t => {
  const f = await fixture(t); const { binding } = await f.connect();
  const input = { ...binding, sequence: 1, input: { action: 'pointer', phase: 'click', x: 0.2, y: 0.4 } };
  await f.request('input', input);
  await assert.rejects(f.request('input', input), { code: 'desktop-input-replayed' });
  await assert.rejects(f.request('input', { ...input, sequence: 2, geometry: 'stale' }), { code: 'desktop-view-changed' });
  await assert.rejects(f.request('input', { ...input, sequence: 2 }, 'other', f.other), { code: 'desktop-disconnected' });
  assert.equal(f.calls.filter(call => call.operation === 'input').length, 1);
});

test('replayed ciphertext cannot start another desktop after disconnect', async t => {
  const f = await fixture(t); await f.desktop.configure({ enabled: true });
  const packet = f.seal('join', { displayId: '1' });
  const grant = await f.desktop.api('join', 'POST', packet, 'phone', 'https://paired.example');
  await f.request('leave', { connectionId: grant.connectionId, generation: grant.generation });
  await assert.rejects(f.desktop.api('join', 'POST', packet, 'phone', 'https://paired.example'), { code: 'desktop-request-replayed' });
});

test('clarity and smoothness update the same connection independently', async t => {
  const f = await fixture(t); const { binding, grant } = await f.connect();
  await f.request('quality', { ...binding, quality: { width: 2560, fps: 30 } });
  await f.request('quality', { ...binding, quality: { width: 2560, fps: 60 } });
  assert.equal(f.desktop.active?.id, grant.connectionId);
  assert.deepEqual(f.calls.filter(call => call.operation === 'quality').map(call => call.value.quality), [{ width: 2560, fps: 30 }, { width: 2560, fps: 60 }]);
  assert.throws(() => desktopQuality({ width: 9999, fps: 60 }), { code: 'invalid-desktop-quality' });
});

test('switching screens preserves the connection and rejects old geometry and old decoded-frame readiness', async t => {
  const f = await fixture(t); const { binding, grant } = await f.connect();
  const selected = await f.request('display', { ...binding, displayId: '2' });
  assert.equal(f.desktop.active?.id, grant.connectionId); assert.equal(selected.display.id, '2');
  assert.equal(f.desktop.active?.ready, false);
  await assert.rejects(f.request('ready', { ...binding, trackSid: grant.trackSid }), { code: 'desktop-not-ready' });
  const current = { ...binding, geometry: selected.display.geometry };
  await f.request('ready', { ...current, trackSid: selected.trackSid });
  await assert.rejects(f.request('input', { ...binding, sequence: 1, input: { action: 'pointer', phase: 'click', x: 0.2, y: 0.5 } }), { code: 'desktop-view-changed' });
  await f.request('input', { ...current, sequence: 1, input: { action: 'pointer', phase: 'click', x: 0.2, y: 0.5 } });
  assert.equal(f.calls.filter(call => call.operation === 'start').length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'input').length, 1);
});

test('disable and device revocation release capture and revoke media grants', async t => {
  const f = await fixture(t); let joined = await f.connect();
  const path = '/api/peer/desktop/media/rtc?access_token=' + joined.grant.token;
  assert.equal((await f.desktop.mediaUpstream(path)).origin, 'http://127.0.0.1:7999');
  assert.match((await f.desktop.mediaUpstream(path.replace('/rtc?', '/rtc/v1?'))).path, /^\/rtc\/v1\?/u);
  await f.desktop.configure({ enabled: false });
  assert.equal(f.desktop.active, null); await assert.rejects(f.desktop.mediaUpstream(path), { code: 'desktop-media-unauthorized' });
  joined = await f.connect(); f.devices.revoked = true; f.devices.emit('changed'); await f.desktop.serial;
  assert.equal(f.desktop.active, null); assert.ok(f.calls.some(call => call.operation === 'stop'));
  assert.equal(f.relayCalls.filter(call => call.delete).length, 2);
});

test('Spaces commands dispatch once, preserve the room and require fresh publication readiness', async t => {
  const f = await fixture(t); const { binding, grant } = await f.connect();
  const result = await f.request('space', { ...binding, sequence: 1, kind: 'next' });
  assert.equal(result.spaceChanged, true); assert.equal(f.desktop.active?.id, grant.connectionId);
  assert.equal(f.desktop.active?.ready, false); assert.notEqual(result.trackSid, grant.trackSid);
  await assert.rejects(f.request('space', { ...binding, sequence: 1, kind: 'next' }), { code: 'invalid-desktop-space' });
  await assert.rejects(f.request('ready', { ...binding, trackSid: grant.trackSid }), { code: 'desktop-not-ready' });
  const current = { ...binding, geometry: result.geometry };
  await f.request('ready', { ...current, trackSid: result.trackSid });
  await f.request('input', { ...current, sequence: 2, input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5 } });
  assert.equal(f.calls.filter(call => call.operation === 'space').length, 1);
  assert.equal(f.relayCalls.filter(call => call.create).length, 1);
});

test('Mac-initiated Spaces changes immediately fence input and reconcile over read-only heartbeat', async t => {
  const f = await fixture(t); const { binding, grant } = await f.connect();
  f.macSpaceChanged(); assert.equal(f.desktop.active?.ready, false);
  await assert.rejects(f.request('input', { ...binding, sequence: 1, input: { action: 'key', key: 'enter', modifiers: [] } }), { code: 'desktop-view-changed' });
  const result = await f.request('heartbeat', binding);
  const current = { ...binding, geometry: result.geometry };
  await assert.rejects(f.request('ready', { ...binding, trackSid: grant.trackSid }), { code: 'desktop-not-ready' });
  await f.request('ready', { ...current, trackSid: result.trackSid });
  assert.equal(f.calls.filter(call => call.operation === 'input').length, 0);
  assert.equal(f.calls.filter(call => call.operation === 'start').length, 1);
});

test('unconfirmed desktop navigation remains unconfirmed and disabled shortcuts do not disconnect', async t => {
  const f = await fixture(t); const { binding, grant } = await f.connect();
  f.setSpaceEnabled(false);
  await assert.rejects(f.request('space', { ...binding, sequence: 1, kind: 'previous' }), { code: 'desktop-space-shortcut-disabled' });
  assert.equal(f.desktop.active?.id, grant.connectionId); assert.equal(f.desktop.active?.ready, true);
  f.setSpaceEnabled(true); f.setSpaceConfirmed(false);
  const result = await f.request('space', { ...binding, sequence: 2, kind: 'previous' });
  assert.equal(result.spaceChanged, false); assert.equal(f.desktop.active?.ready, false);
  const current = { ...binding, geometry: result.geometry };
  await f.request('ready', { ...current, trackSid: result.trackSid });
  const overview = await f.request('space', { ...current, sequence: 3, kind: 'overview' });
  assert.equal(overview.kind, 'overview'); assert.equal(f.desktop.active?.id, grant.connectionId);
});
