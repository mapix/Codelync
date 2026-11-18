import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http2';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as http2Connect, constants as http2Constants } from 'node:http2';
import nacl from 'tweetnacl';
import { parseApnsResult, deliverApnsHttp2 } from '../src/codelync/apns-sender.mjs';
import { DeviceRegistry } from '../src/codelync/device-registry.mjs';
import { NotificationDispatcher } from '../src/codelync/notification-dispatcher.mjs';
import { PairingInvitations, createPairingGateway } from '../src/codelync/pairing-gateway.mjs';
import { gatewayProof } from './fixtures/gateway-proof.mjs';

/** @typedef {Record<string,any>} Value */

test('R021: parseApnsResult and deliverApnsHttp2 return reason:null on 200 OK and handle stream teardown errors safely', async t => {
  assert.deepEqual(parseApnsResult(200, ''), { ok: true, invalidToken: false, retry: false, reason: null });
  assert.deepEqual(parseApnsResult(410, JSON.stringify({ reason: 'BadDeviceToken' })), { ok: false, invalidToken: true, retry: false, reason: 'BadDeviceToken' });
  assert.deepEqual(parseApnsResult(503, 'not-json'), { ok: false, invalidToken: false, retry: true, reason: 'APNsUnavailable' });

  let mode = /** @type {'ok'|'reset'|'teardown-error'} */ ('ok');
  const server = createServer();
  /** @type {Set<import('node:http2').Http2Session>} */
  const sessions = new Set();
  server.on('session', session => {
    sessions.add(session);
    session.on('error', () => {});
    session.once('close', () => sessions.delete(session));
  });
  server.on('stream', stream => {
    stream.on('error', () => {});
    stream.on('data', () => {});
    stream.on('end', () => {
      if (mode === 'reset') {
        stream.close(http2Constants.NGHTTP2_INTERNAL_ERROR);
        return;
      }
      stream.respond({ ':status': 200 });
      stream.end();
      if (mode === 'teardown-error') {
        stream.session?.destroy(new Error('late-session-error'));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'object' === false);
  const port = /** @type {import('node:net').AddressInfo} */ (addr).port;

  t.after(async () => {
    for (const session of sessions) session.destroy();
    await new Promise(resolve => server.close(resolve));
  });

  const okClient = http2Connect(`http://127.0.0.1:${port}`);
  const okResult = await deliverApnsHttp2(okClient, 'a'.repeat(64), 'jwt-token', 'com.learnings.codelync', { id: 'evt-1', kind: 'completed', sessionId: 's-1', origin: 'https://x.example', peerId: 'p-1' });
  assert.deepEqual(okResult, { ok: true, invalidToken: false, retry: false, reason: null });

  mode = 'teardown-error';
  const errTeardownClient = http2Connect(`http://127.0.0.1:${port}`);
  const teardownRes = await deliverApnsHttp2(errTeardownClient, 'a'.repeat(64), 'jwt-token', 'com.learnings.codelync', { id: 'evt-2', kind: 'test', origin: 'https://x.example', peerId: 'p-1' });
  assert.equal(teardownRes.ok, true);
  assert.equal(teardownRes.reason, null);

  mode = 'reset';
  const resetClient = http2Connect(`http://127.0.0.1:${port}`);
  await assert.rejects(
    deliverApnsHttp2(resetClient, 'a'.repeat(64), 'jwt-token', 'com.learnings.codelync', { id: 'evt-3', kind: 'failed', origin: 'https://x.example', peerId: 'p-1' }),
    /apns-transport-failed/,
  );
});

test('R021: NotificationDispatcher drops mid-drain revoked devices cleanly and stops sending upon close()', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r021-dispatch-'));
  const devices = await DeviceRegistry.load(join(dir, 'devices.json'));
  const d1 = await devices.approve('dev-1', 'Phone 1', 'tok-1');
  const d2 = await devices.approve('dev-2', 'Phone 2', 'tok-2');
  await devices.registerPush(d1, { enabled: true, token: 'a'.repeat(64), environment: 'development' });
  await devices.registerPush(d2, { enabled: true, token: 'b'.repeat(64), environment: 'development' });

  const sent = /** @type {string[]} */ ([]);
  const dispatcher = new NotificationDispatcher({
    path: join(dir, 'notifications.json'),
    devices,
    origin: () => 'https://fixture.example',
    sender: {
      environment: 'development',
      send: async (/** @type {string} */ token) => { sent.push(token); return { ok: true }; },
    },
  });

  t.after(async () => {
    await dispatcher.close();
    await rm(dir, { recursive: true, force: true });
  });

  await dispatcher.start();
  await dispatcher.observe('src', 's1', { epoch: 'e1', currentTurnId: 't1', turns: {}, requests: [] });

  // Simulate mid-drain revocation while save() inside drain() is awaiting disk I/O.
  const origSave = dispatcher.save.bind(dispatcher);
  let revokedDuringDrain = false;
  dispatcher.save = async () => {
    await origSave();
    if (!revokedDuringDrain && dispatcher.pending.length) {
      revokedDuringDrain = true;
      // Mark d1 revoked right before sender.send lookup in drain().
      const row = devices.rows.find(r => r.id === d1);
      if (row) row.revoked = true;
    }
  };
  await dispatcher.observe('src', 's1', { epoch: 'e1', currentTurnId: null, turns: { t1: 'completed' }, requests: [] });
  assert.deepEqual(sent, ['b'.repeat(64)]);
  assert.equal(dispatcher.pending.length, 0);

  // Verify close() stops remaining pending deliveries after the current send returns.
  dispatcher.save = origSave;
  const d1Row = devices.rows.find(r => r.id === d1);
  if (d1Row) d1Row.revoked = false;
  let releaseFirstSend = /** @type {() => void} */ (() => {});
  const firstSendStarted = new Promise(resolve => { releaseFirstSend = () => resolve(undefined); });
  let sendCount = 0;
  let closingPromise = /** @type {Promise<void> | null} */ (null);
  dispatcher.options.sender = {
    environment: 'development',
    send: async () => {
      sendCount++;
      if (sendCount === 1) {
        // Trigger close() without awaiting tail synchronously inside tail (avoids self-deadlock).
        closingPromise = dispatcher.close();
        releaseFirstSend();
      }
      return { ok: true };
    },
  };
  await dispatcher.observe('src', 's1', { epoch: 'e1', currentTurnId: 't2', turns: { t1: 'completed' }, requests: [] });
  const obs = dispatcher.observe('src', 's1', { epoch: 'e1', currentTurnId: null, turns: { t1: 'completed', t2: 'completed' }, requests: [] });
  await firstSendStarted;
  await obs;
  await closingPromise;
  assert.equal(sendCount, 1);
});

test('R026: PairingInvitations.close fences in-flight credential issuance and notifications enforce exact UTF-8 byte bounds', async t => {
  const mac = nacl.box.keyPair();
  const device = nacl.box.keyPair();
  let releaseCreds = /** @type {(value: Value) => void} */ (() => {});
  const credsGate = new Promise(resolve => { releaseCreds = resolve; });
  const invitations = new PairingInvitations({
    key: mac.secretKey,
    credentials: { token: 't', secret: 's' },
    issueCredentials: async () => credsGate,
  });

  const grant = invitations.issue('https://fixture.example');
  const invite = new URL(grant.url).searchParams.get('invite');
  assert.ok(invite);

  const exchangePromise = invitations.exchange({
    invite,
    publicKey: Buffer.from(device.publicKey).toString('base64url'),
  });
  invitations.close();
  releaseCreds({ token: 'late', secret: 's'.repeat(43) });
  await assert.rejects(exchangePromise, /pairing-closed/);
  assert.throws(() => invitations.issue('https://fixture.example'), /pairing-closed/);
  assert.throws(() => invitations.exchange({ invite, publicKey: Buffer.from(device.publicKey).toString('base64url') }), /pairing-closed/);

  // Real gateway UTF-8 byte boundary and split-codepoint reassembly test.
  const dir = await mkdtemp(join(tmpdir(), 'codelync-r026-gateway-'));
  const gwMac = nacl.box.keyPair();
  const gwInv = new PairingInvitations({ key: gwMac.secretKey, credentials: { token: 'fixture', secret: 's'.repeat(43) } });
  const devices = await DeviceRegistry.load(join(dir, 'devices.json'));
  const proofInfo = gatewayProof(gwInv, { devices });
  await devices.approve(proofInfo.publicKey, 'Phone', 'synthetic-device-token');

  const gateway = createPairingGateway({
    upstream: 'http://127.0.0.1:1',
    invitations: gwInv,
    devices,
    proof: proofInfo.proof,
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const addr = /** @type {import('node:net').AddressInfo} */ (gateway.address());

  t.after(async () => {
    gateway.closeAllConnections();
    await new Promise(resolve => gateway.close(resolve));
    gwInv.close();
    await rm(dir, { recursive: true, force: true });
  });

  // 1500 CJK chars => String.length = 1525 (< 4096 UTF-16 code units) yet UTF-8 byte length > 4500 (> 4096 bytes).
  const overBytesBody = JSON.stringify({ active: true, sessionId: '中'.repeat(1500) });
  assert.ok(overBytesBody.length < 4096);
  assert.ok(Buffer.byteLength(overBytesBody, 'utf8') > 4096);
  const overRes = await fetch(`http://127.0.0.1:${addr.port}/codelync/notifications/presence`, {
    method: 'POST',
    headers: { ...proofInfo.headers('/codelync/notifications/presence', 'POST'), 'Content-Type': 'application/json' },
    body: overBytesBody,
  });
  assert.equal(overRes.status, 400);

  // Multi-byte UTF-8 sessionId split mid-character across TCP writes decodes intact without U+FFFD.
  const emojiSession = 'sess-😀-中文';
  const splitPayload = Buffer.from(JSON.stringify({ active: true, sessionId: emojiSession }), 'utf8');
  const splitPoint = splitPayload.indexOf(0xf0) + 2; // Split inside the 4-byte emoji UTF-8 sequence.
  const bodyStream = new ReadableStream({
    start(controller) {
      controller.enqueue(splitPayload.subarray(0, splitPoint));
      setTimeout(() => {
        controller.enqueue(splitPayload.subarray(splitPoint));
        controller.close();
      }, 15);
    },
  });
  const okRes = await fetch(`http://127.0.0.1:${addr.port}/codelync/notifications/presence`, {
    method: 'POST',
    headers: { ...proofInfo.headers('/codelync/notifications/presence', 'POST'), 'Content-Type': 'application/json' },
    body: bodyStream,
    // @ts-ignore Node fetch duplex option
    duplex: 'half',
  });
  assert.equal(okRes.status, 200);
  const savedRow = devices.rows.find(r => r.id === proofInfo.id);
  assert.equal(savedRow?.presence?.sessionId, emojiSession);
});
