import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { compactPeerBody, encodeCompactPeerPlaintext, decodeCompactPeerPlaintext, PEER_RESPONSE_CODEC_HEADER, PEER_RESPONSE_MAX_BYTES } from '@codelync/wire/peer-codec';
import { sealPeerResponse } from '../src/codelync/peer-response-codec.mjs';
import { createPairingGateway, PairingInvitations } from '../src/codelync/pairing-gateway.mjs';
import { DeviceRegistry } from '../src/codelync/device-registry.mjs';
import { gatewayProof } from './fixtures/gateway-proof.mjs';

/** @typedef {Record<string,any>} Value */
const PEER = 'ab'.repeat(32);
const EMPTY_DELTA = { version: 2, mode: 'delta', watermark: 'fixture-epoch:27', baseWatermark: 'fixture-epoch:27', machineIds: ['fixture-machine'],
  sessions: [], removedIds: [], hasMore: false, nextCursor: null, scannedAt: 1794575000000 };
/** @param {any} packet @param {string} peer @param {{secretKey:Uint8Array}} phone @param {{publicKey:Uint8Array}} mac */
function unseal(packet, peer, phone, mac) {
  const compact = Array.isArray(packet), nonce = compact ? packet[1] : packet.nonce, ciphertext = compact ? packet[2] : packet.ciphertext;
  const plain = nacl.box.open(Buffer.from(ciphertext, 'base64url'), Buffer.from(nonce, 'base64url'), mac.publicKey, phone.secretKey);
  assert.ok(plain);
  return compact ? decodeCompactPeerPlaintext(plain, peer) : JSON.parse(Buffer.from(plain).toString()).payload;
}

test('negotiated compact/gzip responses round-trip catalog and native rows with legacy v2 fallback', () => {
  const mac = nacl.box.keyPair(), phone = nacl.box.keyPair();
  const rows = Array.from({ length: 50 }, (_, index) => ({ id: `native-${index}`, ownerGeneration: 'fixture-owner', text: 'Native Unicode 文本\n'.repeat(40),
    tools: [{ id: `tool-${index}`, input: { nested: { values: [false, 0, null, 'exact'] } }, output: 'Synthetic tool output'.repeat(12) }] }));
  for (const payload of [EMPTY_DELTA, { version: 1, rows, status: 'idle' }, { value: { sessions: rows } }]) {
    const old = sealPeerResponse(PEER, payload, phone.publicKey, mac.secretKey, undefined), compact = sealPeerResponse(PEER, payload, phone.publicKey, mac.secretKey, '3');
    assert.equal(Array.isArray(old), false); assert.equal(Array.isArray(compact), true);
    assert.deepEqual(unseal(old, PEER, phone, mac), payload); assert.deepEqual(unseal(compact, PEER, phone, mac), payload);
    assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(old)));
    assert.equal(JSON.stringify(compact).includes('Native Unicode'), false);
  }
  assert.equal(Array.isArray(sealPeerResponse(PEER, {}, phone.publicKey, mac.secretKey, 'unsupported')), false);
});

test('empty delta constants compact only when exact; unknown fields and changed watermarks remain intact', () => {
  const plain = encodeCompactPeerPlaintext(PEER, EMPTY_DELTA, body => gzipSync(body));
  assert.equal(plain[0] & 2, 2); assert.deepEqual(decodeCompactPeerPlaintext(plain, PEER), EMPTY_DELTA);
  for (const payload of [{ ...EMPTY_DELTA, extra: 'must not disappear' }, { ...EMPTY_DELTA, baseWatermark: 'different' }, { ...EMPTY_DELTA, hasMore: true },
    { ...EMPTY_DELTA, watermark: 'x'.repeat(513), baseWatermark: 'x'.repeat(513) }]) {
    const encoded = encodeCompactPeerPlaintext(PEER, payload, body => gzipSync(body));
    assert.equal(encoded[0] & 2, 0); assert.deepEqual(decodeCompactPeerPlaintext(encoded, PEER), payload);
  }
  const tiny = encodeCompactPeerPlaintext(PEER, { ok: true }, body => gzipSync(body)); assert.equal(tiny[0] & 1, 0);
});

test('authenticated decoder rejects wrong peer, bad flags, malformed compact payloads and bounded inflate overflow', () => {
  const valid = encodeCompactPeerPlaintext(PEER, { text: 'compressible native output'.repeat(300) }, body => gzipSync(body));
  assert.equal(valid[0] & 1, 1); assert.throws(() => decodeCompactPeerPlaintext(valid, 'cd'.repeat(32)), /foreign-peer/);
  const flags = new Uint8Array(valid); flags[0] = 4; assert.throws(() => decodeCompactPeerPlaintext(flags, PEER), /invalid-peer-frame/);
  const tooLarge = new Uint8Array(valid); new DataView(tooLarge.buffer).setUint32(33, PEER_RESPONSE_MAX_BYTES + 1, true);
  assert.throws(() => decodeCompactPeerPlaintext(tooLarge, PEER), /too-large/);
  const badSize = new Uint8Array(valid); new DataView(badSize.buffer).setUint32(33, 10, true); new DataView(badSize.buffer).setUint32(badSize.length - 4, 10, true);
  assert.throws(() => decodeCompactPeerPlaintext(badSize, PEER), /peer-(compression|length)/);
  const checksum = new Uint8Array(valid); checksum[checksum.length - 8] ^= 1; assert.throws(() => decodeCompactPeerPlaintext(checksum, PEER), /compression/);
  const malformed = encodeCompactPeerPlaintext(PEER, { ok: true }); malformed[0] = 2; assert.throws(() => decodeCompactPeerPlaintext(malformed, PEER), /compact-payload/);
  const compactOverflow = encodeCompactPeerPlaintext(PEER, ['x'.repeat(513), ['machine'], 1]); compactOverflow[0] = 2;
  assert.throws(() => decodeCompactPeerPlaintext(compactOverflow, PEER), /compact-payload/);
  assert.throws(() => compactPeerBody({ text: 'x'.repeat(PEER_RESPONSE_MAX_BYTES) }), /too-large/);
});

test('real gateway negotiates only after approved proof and preserves v2 for an older request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-peer-codec-'));
  const devices = new DeviceRegistry(join(directory, 'devices.json')), invitations = new PairingInvitations({ key: randomBytes(32), credentials: {} });
  const device = gatewayProof(invitations, { devices, token: 'synthetic-codec-token' }); await devices.approve(device.publicKey, 'Synthetic codec phone', 'synthetic-codec-token');
  let reads = 0;
  const gateway = createPairingGateway({ upstream: 'http://127.0.0.1:9', devices, invitations, proof: device.proof, peerId: () => PEER,
    peerApi: async () => { reads++; return EMPTY_DELTA; } });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening'); const address = gateway.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); invitations.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${address.port}/api/peer/catalog`;
  assert.equal((await fetch(url, { headers: { [PEER_RESPONSE_CODEC_HEADER]: '3' } })).status, 401); assert.equal(reads, 0);
  const old = await (await fetch(url, { headers: device.headers('/api/peer/catalog') })).json(); assert.equal(old.version, 2);
  const packet = await (await fetch(url, { headers: { ...device.headers('/api/peer/catalog'), [PEER_RESPONSE_CODEC_HEADER]: '3' } })).json();
  assert.equal(packet[0], 3); assert.equal(reads, 2);
});

test('packet benchmark measures UTF8 encrypted bodies, estimated HTTP/proof overhead and portable decoding without model calls', () => {
  const mac = nacl.box.keyPair(), phone = nacl.box.keyPair();
  const samples = {
    fullCatalog: { version: 2, mode: 'full', watermark: 'fixture-epoch:28', machineIds: ['fixture-machine'],
      sessions: Array.from({ length: 200 }, (_, index) => ({ id: createHash('sha256').update(`session-${index}`).digest('hex').slice(0, 36), metadata: { nativeSession: { title: `Synthetic session ${index} ${createHash('sha256').update(`title-${index}`).digest('hex').slice(0, 10)}`, projectPath: '/fixture/workspace' },
        bridge: { source: { app: 'antigravity', protocol: 'antigravity-connect', hostId: 'local:antigravity:' + 'a'.repeat(64), runtimeGeneration: 'fixture-owner' }, sourceStatus: 'owner-unavailable' } } })), removedIds: [], hasMore: false, nextCursor: null, scannedAt: 1794575000000 },
    currentRows: { version: 1, ownerGeneration: 'fixture-owner', rows: Array.from({ length: 50 }, (_, index) => ({ id: `row-${index}`, role: 'assistant', turnId: `turn-${index}`,
      text: Array.from({ length: 100 }, (_, line) => `Synthetic native text 文本 ${createHash('sha256').update(`row-${index}:${line}`).digest('hex').slice(0, 16)}`).join('\n') })) },
    emptyDelta: EMPTY_DELTA,
    singleChild: { version: 1, ownerGeneration: 'fixture-owner', aggregateActivity: { known: true, active: 1, waiting: 0, unknown: 0 },
      children: [{ id: 'child-1', sourceKey: 'a'.repeat(64), title: 'Synthetic child', status: 'running', nativeUpdatedAt: 1794575000000 }] },
  };
  const nonce = randomBytes(24), requestBody = { version: 2, token: 'synthetic-proof-token-' + 'x'.repeat(64), origin: 'http://192.168.50.2:8800', method: 'GET', path: '/api/peer/catalog', at: 1794575000000 };
  const authorization = 'Codelync ' + Buffer.from(JSON.stringify({ publicKey: Buffer.from(phone.publicKey).toString('base64url'), nonce: nonce.toString('base64url'),
    ciphertext: Buffer.from(nacl.box(Buffer.from(JSON.stringify(requestBody)), nonce, mac.publicKey, phone.secretKey)).toString('base64url') })).toString('base64url');
  const requestBytes = Buffer.byteLength(`GET /api/peer/catalog HTTP/1.1\r\nHost: 192.168.50.2:8800\r\nAuthorization: ${authorization}\r\n\r\n`);
  const results = /** @type {Value[]} */ ([]);
  for (const [name, payload] of Object.entries(samples)) {
    const old = sealPeerResponse(PEER, payload, phone.publicKey, mac.secretKey, undefined), encoded = sealPeerResponse(PEER, payload, phone.publicKey, mac.secretKey, '3');
    const oldBytes = Buffer.byteLength(JSON.stringify(old)), compactBytes = Buffer.byteLength(JSON.stringify(encoded));
    const began = performance.now(); for (let index = 0; index < 5; index++) assert.deepEqual(unseal(encoded, PEER, phone, mac), payload);
    const responseHeader = (/** @type {number} */ bytes) => Buffer.byteLength(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${bytes}\r\nConnection: keep-alive\r\n\r\n`);
    results.push({ sample: name, synthetic: true, logicalUtf8Bytes: Buffer.byteLength(JSON.stringify(payload)), v2EncryptedUtf8Bytes: oldBytes, v3EncryptedUtf8Bytes: compactBytes,
      savedBytes: oldBytes - compactBytes, estimatedV2HttpBytes: requestBytes + responseHeader(oldBytes) + oldBytes,
      estimatedV3HttpBytes: requestBytes + Buffer.byteLength(`${PEER_RESPONSE_CODEC_HEADER}: 3\r\n`) + responseHeader(compactBytes) + compactBytes,
      portableBoxAndDecodeMs: Math.round((performance.now() - began) / 5 * 1000) / 1000, proofHeaderUtf8Bytes: Buffer.byteLength(authorization) });
    assert.ok(compactBytes < oldBytes);
  }
  console.log(JSON.stringify({ peerCodecPacketBenchmark: results, modelCalls: 0 }));
});
