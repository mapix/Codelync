import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { connect as netConnect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import WebSocket from 'ws';
import { PairingInvitations, createPairingGateway } from '../src/codelync/pairing-gateway.mjs';
import { DeviceRegistry } from '../src/codelync/device-registry.mjs';
import { RemoteDesktop } from '../src/codelync/remote-desktop.mjs';
import { gatewayProof } from './fixtures/gateway-proof.mjs';

/** @typedef {Record<string,any>} Value */

test('R001: /v1/updates/ upgrade tears down socket and drains non-101 upstream responses without hanging', async t => {
  const state = await mkdtemp(join(tmpdir(), 'codelync-r001-non101-'));
  let upstreamDrained = false;
  const upstream = createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized-upstream-body');
  });
  upstream.on('upgrade', (_req, socket) => {
    socket.on('close', () => { upstreamDrained = true; });
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\n\r\nforbidden');
    upstreamDrained = true;
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');

  const mac = nacl.box.keyPair();
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { token: 'fixture', secret: 'fixture' } });
  const devices = new DeviceRegistry(join(state, 'devices.json'));
  const device = gatewayProof(invitations, { devices });
  await devices.approve(device.publicKey, 'Test Phone', 'synthetic-device-token');

  const gateway = createPairingGateway({
    upstream: `http://127.0.0.1:${upstreamAddress.port}`,
    invitations,
    devices,
    proof: device.proof,
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const local = gateway.address();
  assert.ok(local && typeof local !== 'string');

  t.after(async () => {
    gateway.closeAllConnections();
    await new Promise(resolve => gateway.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    invitations.close();
    await rm(state, { recursive: true, force: true });
  });

  const ws = new WebSocket(`ws://127.0.0.1:${local.port}/v1/updates/?EIO=4&transport=websocket`, {
    headers: device.headers('/v1/updates/'),
  });
  const outcome = await Promise.race([
    once(ws, 'error').then(([err]) => ({ type: 'error', err })),
    once(ws, 'close').then(([code]) => ({ type: 'close', code })),
    new Promise((_, reject) => setTimeout(() => reject(new Error('non-101 upgrade hung client socket')), 1500)),
  ]);
  assert.ok(outcome.type === 'error' || outcome.type === 'close');
  ws.terminate();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(upstreamDrained, true);
  const listed = devices.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.connected, false);
});

test('R001: pre-upgrade client abort destroys pending upstream proxy for /v1/updates/ and desktop media', async t => {
  let upstreamClosed = 0;
  let releaseUpstream = /** @type {(value?: unknown) => void} */ (() => {});
  const upstreamArrived = new Promise(resolve => {
    releaseUpstream = resolve;
  });
  /** @type {Set<import('node:stream').Duplex>} */
  const upstreamSockets = new Set();
  const upstream = createServer();
  upstream.on('upgrade', (_req, socket) => {
    upstreamSockets.add(socket);
    socket.once('end', () => socket.destroy());
    socket.once('close', () => {
      upstreamSockets.delete(socket);
      upstreamClosed++;
    });
    releaseUpstream();
    // Hold open without answering 101 to simulate slow upstream handshake.
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');

  const mac = nacl.box.keyPair();
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { token: 'fixture', secret: 'fixture' } });
  const device = gatewayProof(invitations);

  let resolveMedia = /** @type {(value: { origin: string, path: string, device: string }) => void} */ (() => {});
  const mediaGate = new Promise(resolve => { resolveMedia = resolve; });
  let mediaProxiesStarted = 0;

  const gateway = createPairingGateway({
    upstream: `http://127.0.0.1:${upstreamAddress.port}`,
    invitations,
    proof: device.proof,
    // @ts-ignore test helper extension
    desktopMedia: async () => {
      const target = await mediaGate;
      mediaProxiesStarted++;
      return target;
    },
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const local = gateway.address();
  assert.ok(local && typeof local !== 'string');

  t.after(async () => {
    for (const s of upstreamSockets) s.destroy();
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise(resolve => gateway.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    invitations.close();
  });

  // 1) /v1/updates/ client aborts after upstream receives upgrade request but before 101 reply
  const auth = device.headers('/v1/updates/').Authorization;
  const wsKey = Buffer.from('the sample nonce').toString('base64');
  const rawSocket = netConnect(local.port, '127.0.0.1');
  await once(rawSocket, 'connect');
  rawSocket.write(
    'GET /v1/updates/ HTTP/1.1\r\n'
    + `Host: 127.0.0.1:${local.port}\r\n`
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Key: ${wsKey}\r\n`
    + 'Sec-WebSocket-Version: 13\r\n'
    + `Authorization: ${auth}\r\n\r\n`,
  );
  await upstreamArrived;
  const rawClosed = once(rawSocket, 'close');
  rawSocket.destroy();
  await rawClosed;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(upstreamClosed, 1);

  // 2) /api/peer/desktop/media/rtc client aborts while desktopMedia lookup is still pending
  const mediaSocket = netConnect(local.port, '127.0.0.1');
  await once(mediaSocket, 'connect');
  mediaSocket.write(
    'GET /api/peer/desktop/media/rtc?access_token=fixture HTTP/1.1\r\n'
    + `Host: 127.0.0.1:${local.port}\r\n`
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Key: ${wsKey}\r\n`
    + 'Sec-WebSocket-Version: 13\r\n\r\n',
  );
  await new Promise(resolve => setTimeout(resolve, 25));
  const mediaClosed = once(mediaSocket, 'close');
  mediaSocket.destroy();
  await mediaClosed;
  resolveMedia({ origin: `http://127.0.0.1:${upstreamAddress.port}`, path: '/rtc', device: 'fixture' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(mediaProxiesStarted, 1);
  // Upstream connection count did not grow because tunnelUpgrade was skipped when socket.destroyed
  assert.equal(upstreamClosed, 1);
});

/** @param {import('node:test').TestContext} t */
async function desktopFixture(t, options = {}) {
  const state = await mkdtemp(join(tmpdir(), 'codelync-r006-desktop-'));
  const mac = nacl.box.keyPair();
  const phone = nacl.box.keyPair();
  const devices = Object.assign(new EventEmitter(), {
    publicKey(/** @type {string} */ id) {
      return id === 'phone' ? Buffer.from(phone.publicKey).toString('base64url') : null;
    },
  });
  const display1 = { id: '1', name: 'Main', width: 2560, height: 1440, geometry: 'g-1' };
  const display2 = { id: '2', name: 'Secondary', width: 1920, height: 1080, geometry: 'g-2' };
  const permissions = { screenRecording: true, accessibility: true, locked: false };
  let interrupts = 0;
  let track = 0;
  let displayResultOverride = /** @type {Value | null} */ (null);
  let qualityResultOverride = /** @type {Value | null} */ (null);

  const host = Object.assign(new EventEmitter(), {
    interrupt() { interrupts++; },
    async request(/** @type {string} */ operation, /** @type {Value} */ value = {}) {
      if (operation === 'displays') return { displays: [display1, display2], permissions };
      if (operation === 'start') {
        track++;
        return { capturing: true, connected: true, viewerConnected: true, permissions, geometry: display1.geometry, trackSid: 'track-' + track, viewPending: false };
      }
      if (operation === 'heartbeat') {
        return { capturing: true, connected: true, viewerConnected: true, permissions, geometry: value.geometry, trackSid: 'track-' + track, viewPending: false };
      }
      if (operation === 'display') {
        track++;
        const selected = value.displayId === '2' ? display2 : display1;
        return displayResultOverride ?? { display: selected, trackSid: 'track-' + track, permissions, viewPending: false };
      }
      if (operation === 'quality') {
        track++;
        return qualityResultOverride ?? { trackSid: 'track-' + track, geometry: value.geometry, permissions, viewPending: false };
      }
      return { ...value, ok: true };
    },
    async close() {},
  });
  const rooms = { async createRoom() {}, async deleteRoom() {} };
  const relay = {
    async start() {
      return { url: 'ws://127.0.0.1:7999', apiKey: 'test-api-key', apiSecret: 'a'.repeat(64), rooms };
    },
    async close() {},
  };
  const desktop = new RemoteDesktop({
    state,
    devices,
    macSecretKey: mac.secretKey,
    hostBinary: '/unused',
    relayBinary: '/unused',
    hostFactory: () => host,
    relayFactory: () => relay,
    ...options,
  });
  t.after(async () => {
    await desktop.close();
    await rm(state, { recursive: true, force: true });
  });
  const seal = (/** @type {string} */ action, /** @type {Value} */ value = {}) => {
    const nonce = randomBytes(24);
    const plaintext = Buffer.from(JSON.stringify({ version: 1, at: Date.now(), action, ...value }));
    return {
      version: 1,
      nonce: nonce.toString('base64url'),
      ciphertext: Buffer.from(nacl.box(plaintext, nonce, mac.publicKey, phone.secretKey)).toString('base64url'),
    };
  };
  const req = (/** @type {string} */ action, /** @type {Value} */ value = {}) =>
    desktop.api(action, 'POST', seal(action, value), 'phone', 'https://paired.example');

  await desktop.configure({ enabled: true });
  const grant = await req('join', { displayId: '1' });
  const binding = { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry };
  await req('ready', { ...binding, trackSid: grant.trackSid });
  return {
    desktop,
    host,
    req,
    binding,
    grant,
    interrupts: () => interrupts,
    setDisplayOverride: (/** @type {Value | null} */ v) => { displayResultOverride = v; },
    setQualityOverride: (/** @type {Value | null} */ v) => { qualityResultOverride = v; },
  };
}

test('R006: configure validates input and required external secret before interrupting an active desktop host', async t => {
  const f = await desktopFixture(t);
  assert.ok(f.desktop.active);

  await assert.rejects(f.desktop.configure(/** @type {any} */ (null)), { code: 'invalid-desktop-configuration' });
  await assert.rejects(f.desktop.configure(/** @type {any} */ ([])), { code: 'invalid-desktop-configuration' });
  await assert.rejects(
    f.desktop.configure({ mode: 'external', url: 'wss://media.example', apiKey: 'key-1' }),
    { code: 'invalid-desktop-server' },
  );
  // Active connection and host remain untouched on rejected configuration changes.
  assert.equal(f.interrupts(), 0);
  assert.ok(f.desktop.active);

  // Switch to a valid external server, reconnect, then attempt url/apiKey switch without a new secret.
  await f.desktop.configure({ enabled: true, mode: 'external', url: 'wss://media-1.example', apiKey: 'key-1', apiSecret: 's'.repeat(64) });
  await f.req('join', { displayId: '1' });
  assert.ok(f.desktop.active);
  const interruptsBefore = f.interrupts();
  await assert.rejects(
    f.desktop.configure({ url: 'wss://media-2.example' }),
    { code: 'desktop-server-secret-required' },
  );
  await assert.rejects(
    f.desktop.configure({ apiKey: 'key-2' }),
    { code: 'desktop-server-secret-required' },
  );
  assert.equal(f.interrupts(), interruptsBefore);
  assert.ok(f.desktop.active);
});

test('R006: display switch synchronizes viewPending instead of leaving stale viewPending=true', async t => {
  const f = await desktopFixture(t);
  f.host.emit('view-invalidated', f.grant.connectionId);
  assert.equal(f.desktop.active?.viewPending, true);

  // Switching to display 2 with viewPending: false clears stale viewPending and permits ready/input.
  const switched = await f.req('display', { ...f.binding, displayId: '2' });
  assert.equal(f.desktop.active?.viewPending, false);
  await f.req('ready', { ...f.binding, geometry: switched.display.geometry, trackSid: switched.trackSid });
  await f.req('input', { ...f.binding, geometry: switched.display.geometry, sequence: 1, input: { action: 'pointer', phase: 'click', x: 0.5, y: 0.5 } });

  // Switching back when host reports viewPending: true preserves viewPending and blocks ready until cleared.
  f.setDisplayOverride({ display: { id: '1', name: 'Main', width: 2560, height: 1440, geometry: 'g-1' }, trackSid: 'track-99', viewPending: true });
  await f.req('display', { ...f.binding, geometry: switched.display.geometry, displayId: '1' });
  assert.equal(f.desktop.active?.viewPending, true);
  await assert.rejects(
    f.req('ready', { ...f.binding, geometry: 'g-1', trackSid: 'track-99' }),
    { code: 'desktop-not-ready' },
  );
});

test('R006: display and quality reject missing trackSid or geometry and stop active capture cleanly', async t => {
  const f1 = await desktopFixture(t);
  f1.setQualityOverride({ geometry: 'g-1', trackSid: '' });
  await assert.rejects(
    f1.req('quality', { ...f1.binding, quality: { width: 2560, fps: 30 } }),
    { code: 'desktop-capture-unavailable' },
  );
  assert.equal(f1.desktop.active, null);

  const f2 = await desktopFixture(t);
  f2.setDisplayOverride({ display: { id: '2', name: 'Secondary', width: 1920, height: 1080, geometry: '' }, trackSid: 'track-50' });
  await assert.rejects(
    f2.req('display', { ...f2.binding, displayId: '2' }),
    { code: 'desktop-display-unavailable' },
  );
  assert.equal(f2.desktop.active, null);
});
