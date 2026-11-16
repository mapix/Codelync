import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { decodePeerUtf8, encodeCompactPeerPlaintext, decodeCompactPeerPlaintext } from '@slopus/happy-wire/peer-codec';

test('native peer UTF8 preserves Unicode and surrogate pairs across bounded output chunks and byte offsets', () => {
  for (const text of ['', 'ASCII 中文 / 🙂🌍', '\ufeffinitial BOM', 'inside\ufeffBOM', 'a'.repeat(8191) + '🌍' + '中文'.repeat(10000), 'x'.repeat(500000)]) {
    const data = new TextEncoder().encode(text), wrapped = new Uint8Array(data.length + 10); wrapped.set(data, 5);
    const slice = wrapped.subarray(5, 5 + data.length);
    assert.equal(decodePeerUtf8(slice), new TextDecoder().decode(slice));
  }
});

test('malformed UTF8 follows standard replacement semantics without truncating surrounding payload', () => {
  for (const bytes of [[0x80], [0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf0, 0x9f, 0x8c], [65, 0xe2, 40, 66], [0xff, 0xfe, 65]]) {
    const data = Uint8Array.from(bytes);
    assert.equal(decodePeerUtf8(data), new TextDecoder().decode(data));
  }
});

test('optimized native text decode preserves compressed peer payload and strict checksum failures', () => {
  const peer = 'ab'.repeat(32), payload = { rows: [{ id: 'row', text: 'Native 完整文本🌍'.repeat(30000) }], exact: { value: null, flags: [true, false, 0] } };
  const encoded = encodeCompactPeerPlaintext(peer, payload, body => gzipSync(body));
  assert.deepEqual(decodeCompactPeerPlaintext(encoded, peer, { decodeText: decodePeerUtf8 }), payload);
  const corrupt = new Uint8Array(encoded); corrupt[corrupt.length - 8] ^= 1;
  assert.throws(() => decodeCompactPeerPlaintext(corrupt, peer, { decodeText: decodePeerUtf8 }), /compression/);
});
