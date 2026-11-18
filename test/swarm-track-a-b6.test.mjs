import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import {
  compactPeerBody,
  decodeCompactPeerPlaintext,
  encodeCompactPeerPlaintext,
  inspectCompactPeerPlaintext,
  PEER_COMPACT_PREFIX_BYTES,
  PEER_RESPONSE_CODEC_VALUE,
} from '@codelync/wire/peer-codec';
import { sealPeerResponse } from '../src/codelync/peer-response-codec.mjs';
import { openPeerActivityRequest } from '../src/codelync/peer-request-codec.mjs';
import { NativeActivityTransport } from '../src/codelync/activity-transport.mjs';

const PEER_ID = 'ab'.repeat(32);

test('R051: peer-codec honors non-zero byteOffset subarrays and validates gzip framing once without reading adjacent slab bytes', () => {
  const payload = {
    version: 1,
    rows: Array.from({ length: 12 }, (_, index) => ({ id: `row-${index}`, text: 'repeated native text '.repeat(8) })),
  };
  const compressed = encodeCompactPeerPlaintext(PEER_ID, payload, body => gzipSync(body));
  assert.equal(compressed[0] & 1, 1);

  // Place compressed frame at non-zero offset inside a poisoned slab buffer.
  const slab = new Uint8Array(compressed.length + 64).fill(0xff);
  const offset = 29;
  slab.set(compressed, offset);
  const view = slab.subarray(offset, offset + compressed.length);

  const inspected = inspectCompactPeerPlaintext(view, PEER_ID);
  assert.equal(inspected.compressed, true);
  assert.equal(inspected.body.byteOffset, offset + PEER_COMPACT_PREFIX_BYTES);
  assert.deepEqual(decodeCompactPeerPlaintext(view, PEER_ID), payload);

  // Uncompressed frame at non-zero byteOffset also decodes accurately.
  const uncompressed = encodeCompactPeerPlaintext(PEER_ID, { ok: true, count: 42 });
  assert.equal(uncompressed[0] & 1, 0);
  const rawSlab = new Uint8Array(uncompressed.length + 40).fill(0xaa);
  rawSlab.set(uncompressed, 17);
  const rawView = rawSlab.subarray(17, 17 + uncompressed.length);
  assert.deepEqual(decodeCompactPeerPlaintext(rawView, PEER_ID), { ok: true, count: 42 });

  // Corrupted gzip FLG byte (body[3] !== 0), corrupted CRC32, and gzip bomb exceeding declared size fail closed.
  const badFlag = new Uint8Array(compressed);
  badFlag[PEER_COMPACT_PREFIX_BYTES + 3] = 8;
  assert.throws(() => inspectCompactPeerPlaintext(badFlag, PEER_ID), /invalid-peer-compression/);
  assert.throws(() => decodeCompactPeerPlaintext(badFlag, PEER_ID), /invalid-peer-compression/);

  const badCrc = new Uint8Array(compressed);
  badCrc[badCrc.length - 8] ^= 0xff;
  assert.throws(() => decodeCompactPeerPlaintext(badCrc, PEER_ID), /invalid-peer-compression/);

  // Craft a valid gzip stream whose actual inflated length exceeds the declared size (but matches tampered ISIZE? no, inflate > expected).
  const bigBody = Buffer.from(JSON.stringify({ text: 'A'.repeat(400) }));
  const bigGzip = gzipSync(bigBody);
  const forged = new Uint8Array(PEER_COMPACT_PREFIX_BYTES + bigGzip.length);
  forged[0] = 1;
  for (let i = 0; i < 32; i++) forged[i + 1] = parseInt(PEER_ID.slice(i * 2, i * 2 + 2), 16);
  const shrunkDeclared = bigBody.length - 5;
  new DataView(forged.buffer).setUint32(33, shrunkDeclared, true);
  forged.set(bigGzip, PEER_COMPACT_PREFIX_BYTES);
  new DataView(forged.buffer).setUint32(forged.length - 4, shrunkDeclared, true);
  assert.throws(() => decodeCompactPeerPlaintext(forged, PEER_ID), /invalid-peer-length/);

  // Encoder rejects a broken compress callback returning corrupt gzip headers/ISIZE.
  assert.throws(
    () => encodeCompactPeerPlaintext(PEER_ID, { text: 'x'.repeat(1024) }, () => new Uint8Array(24).fill(1)),
    /invalid-peer-compressor/,
  );
  assert.deepEqual(compactPeerBody({ ok: true }).compact, false);
});

test('R051: sealPeerResponse skips redundant v2 JSON serialization in v3 mode and validates key bounds', () => {
  const mac = nacl.box.keyPair();
  const phone = nacl.box.keyPair();

  // Serialize counter verifies v3 seals payload once rather than serializing a discarded legacy v2 buffer first.
  let stringified = 0;
  const payload = {
    toJSON() {
      stringified++;
      return { version: 1, items: ['a', 'b', 'c'] };
    },
  };
  const v3 = sealPeerResponse(PEER_ID, payload, phone.publicKey, mac.secretKey, PEER_RESPONSE_CODEC_VALUE);
  assert.ok(Array.isArray(v3));
  assert.equal(stringified, 1);

  const plain = nacl.box.open(
    Buffer.from(/** @type {string} */ (v3[2]), 'base64url'),
    Buffer.from(/** @type {string} */ (v3[1]), 'base64url'),
    mac.publicKey,
    phone.secretKey,
  );
  assert.ok(plain);
  assert.deepEqual(decodeCompactPeerPlaintext(plain, PEER_ID), { version: 1, items: ['a', 'b', 'c'] });

  // Non-zero byteOffset subarrays for keys work properly.
  const paddedPhone = new Uint8Array(64).fill(7);
  paddedPhone.set(phone.publicKey, 11);
  const v2 = sealPeerResponse(PEER_ID, { ok: true }, paddedPhone.subarray(11, 43), mac.secretKey, undefined);
  assert.equal(Array.isArray(v2), false);

  assert.throws(() => sealPeerResponse(PEER_ID, { ok: true }, new Uint8Array(16), mac.secretKey, '3'), /invalid-peer-keys/);
  assert.throws(() => sealPeerResponse(PEER_ID, undefined, phone.publicKey, mac.secretKey, '3'), /invalid-peer-payload/);
});

test('R056: openPeerActivityRequest rejects prototype-poisoning keys and invalid structures fail closed', () => {
  const mac = nacl.box.keyPair();
  const phone = nacl.box.keyPair();
  const path = '/api/peer/activity';
  const method = 'POST';
  const scope = { peerId: PEER_ID, path, method, devicePublicKey: phone.publicKey, macSecretKey: mac.secretKey };

  /** @param {string} payloadJson */
  function sealRawPayload(payloadJson) {
    const nonce = randomBytes(24);
    const frameText = `[${JSON.stringify(PEER_ID)},${JSON.stringify(method)},${JSON.stringify(path)},${payloadJson}]`;
    const cipher = nacl.box(Buffer.from(frameText), nonce, mac.publicKey, phone.secretKey);
    return [2, nonce.toString('base64url'), Buffer.from(cipher).toString('base64url')];
  }

  for (const dangerousJson of [
    '{"__proto__":{"polluted":true},"clientId":"viewer","requestSeq":1,"groups":[]}',
    '{"clientId":"viewer","requestSeq":1,"groups":[{"id":"g1","constructor":{"prototype":{"polluted":true}}}]}',
    '{"clientId":"viewer","requestSeq":1,"groups":[{"id":"g1","nested":{"prototype":{"x":1}}}]}',
  ]) {
    assert.throws(() => openPeerActivityRequest(sealRawPayload(dangerousJson), scope), { code: 'invalid-peer-request' });
    assert.throws(() => openPeerActivityRequest(JSON.parse(dangerousJson), scope), { code: 'invalid-peer-request' });
  }

  // Circular legacy body throws BridgeError('invalid-peer-request') instead of raw TypeError.
  /** @type {Record<string, unknown>} */
  const circular = { clientId: 'viewer' };
  circular.self = circular;
  assert.throws(() => openPeerActivityRequest(circular, scope), { code: 'invalid-peer-request' });

  // Non-Uint8Array fake key object is rejected.
  assert.throws(
    () => openPeerActivityRequest(sealRawPayload('{"clientId":"viewer","requestSeq":1,"groups":[]}'), {
      ...scope,
      devicePublicKey: /** @type {any} */ (new Array(32).fill(1)),
    }),
    { code: 'invalid-peer-request' },
  );

  // Normal sealed request continues to open cleanly.
  const valid = sealRawPayload('{"clientId":"viewer","requestSeq":1,"activityProtocol":2,"groups":[{"id":"g1","projectKey":"/p","hostId":"local"}]}');
  assert.deepEqual(openPeerActivityRequest(valid, scope), {
    clientId: 'viewer',
    requestSeq: 1,
    activityProtocol: 2,
    groups: [{ id: 'g1', projectKey: '/p', hostId: 'local' }],
  });
});

test('R056: NativeActivityTransport canonicalizes group interest & signature hashes and rejects prototype-unsafe inputs', () => {
  let now = 1000;
  let seq = 0;
  let reverseReplyOrder = false;
  const seenPolls = /** @type {any[]} */ ([]);
  const states = new Map([
    ['one', { known: true, active: false }],
    ['two', { known: true, active: false }],
  ]);

  const transport = new NativeActivityTransport({
    now: () => now,
    machineId: () => 'mac-1',
    poll(request) {
      seenPolls.push(request);
      const list = reverseReplyOrder ? [...request.groups].reverse() : request.groups;
      return {
        ok: true,
        version: 1,
        epoch: 'epoch-1',
        sequence: ++seq,
        observedAt: now,
        groups: list.map((/** @type {any} */ group) => {
          const st = states.get(group.id) ?? { known: false, active: false };
          return {
            id: group.id,
            total: 1,
            active: Number(st.active),
            waiting: 0,
            unknown: Number(!st.known),
            status: st.known ? 'ready' : 'unavailable',
            observedAt: now,
          };
        }),
      };
    },
  });

  // 1. Initial v2 request establishes token & watermark.
  const first = transport.request('dev-1', {
    clientId: 'viewer',
    requestSeq: 1,
    activityProtocol: 2,
    groups: [
      { id: 'one', projectKey: '/one', hostId: 'local', meta: { a: 1, b: 2 } },
      { id: 'two', projectKey: '/two', hostId: 'local', meta: { b: 2, a: 1 } },
    ],
  });
  assert.equal(first.mode, 'full');

  // 2. Resending exact same groups in reversed array order AND reordered object keys preserves interestToken and stays unchanged!
  now = 1100;
  reverseReplyOrder = true;
  const reorderedInput = [
    { meta: { a: 1, b: 2 }, hostId: 'local', projectKey: '/two', id: 'two' },
    { meta: { b: 2, a: 1 }, hostId: 'local', id: 'one', projectKey: '/one' },
  ];
  const unchanged = transport.request('dev-1', {
    clientId: 'viewer',
    requestSeq: 2,
    activityProtocol: 2,
    since: first.watermark,
    groups: reorderedInput,
  });
  assert.equal(unchanged.interestToken, first.interestToken);
  assert.equal(unchanged.watermark, first.watermark);
  assert.equal(unchanged.mode, 'unchanged');
  assert.deepEqual(unchanged.groups, []);
  // Producer still saw caller's exact group array ordering untouched.
  assert.deepEqual(seenPolls[1].groups.map((/** @type {any} */ g) => g.id), ['two', 'one']);

  // 3. Changing one group state still produces an accurate delta despite reordered groups.
  now = 1200;
  states.set('two', { known: true, active: true });
  const delta = transport.request('dev-1', {
    clientId: 'viewer',
    requestSeq: 3,
    activityProtocol: 2,
    interestToken: unchanged.interestToken,
    since: unchanged.watermark,
  });
  assert.equal(delta.mode, 'delta');
  assert.equal(delta.groups.length, 1);
  assert.equal(delta.groups[0].id, 'two');
  assert.equal(delta.groups[0].active, 1);

  // 4. Prototype-unsafe inputs rejected before poll() runs.
  const callsBeforeReject = seenPolls.length;
  for (const unsafe of [
    JSON.parse('{"clientId":"viewer","requestSeq":4,"groups":[],"__proto__":{"x":1}}'),
    JSON.parse('{"clientId":"viewer","requestSeq":4,"groups":[{"id":"one","__proto__":{"x":1}}]}'),
    JSON.parse('{"clientId":"viewer","requestSeq":4,"groups":[{"id":"one","constructor":{"prototype":{}}}]}'),
  ]) {
    assert.throws(() => transport.request('dev-1', unsafe), { code: 'invalid-activity-interest' });
  }
  assert.equal(seenPolls.length, callsBeforeReject);
});
