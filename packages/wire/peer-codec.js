import { gunzipSync } from 'fflate';

// Explicit synthetic native diagnostics reuse the owned codec dependency.
export { gzipSync } from 'fflate';

export const PEER_RESPONSE_CODEC_HEADER = 'x-codelync-peer-codec';
export const PEER_RESPONSE_CODEC_VALUE = '3';
export const PEER_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const PEER_COMPACT_PREFIX_BYTES = 37;
const MAX_BODY = PEER_RESPONSE_MAX_BYTES - PEER_COMPACT_PREFIX_BYTES;
const EMPTY_DELTA_KEYS = ['version', 'mode', 'watermark', 'baseWatermark', 'machineIds', 'sessions', 'removedIds', 'hasMore', 'nextCursor', 'scannedAt'];
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}
function crc32(bytes) { let value = 0xffffffff; for (let index = 0; index < bytes.length; index++) value = CRC_TABLE[(value ^ bytes[index]) & 255] ^ value >>> 8; return (~value) >>> 0; }

/** Indexed valid-UTF8 fast path for engines with a slow reference TextDecoder.
 * Invalid input delegates to the platform decoder to preserve replacement/BOM semantics.
 * This runs only after MAC/length/checksum validation in the peer decoder. */
export function decodePeerUtf8(bytes) {
  const units = new Uint16Array(8192); let used = 0, result = '', index = 0;
  const emit = value => {
    units[used++] = value;
    if (used === units.length) { result += String.fromCharCode.apply(null, units); used = 0; }
  };
  const fallback = () => new TextDecoder().decode(bytes);
  while (index < bytes.length) {
    const at = index, first = bytes[index++]; let point;
    if (first < 0x80) point = first;
    else if (first >= 0xc2 && first <= 0xdf) {
      if (index >= bytes.length || (bytes[index] & 0xc0) !== 0x80) return fallback();
      point = (first & 0x1f) << 6 | bytes[index++] & 0x3f;
    } else if (first >= 0xe0 && first <= 0xef) {
      if (index + 1 >= bytes.length || (bytes[index] & 0xc0) !== 0x80 || (bytes[index + 1] & 0xc0) !== 0x80
        || first === 0xe0 && bytes[index] < 0xa0 || first === 0xed && bytes[index] >= 0xa0) return fallback();
      point = (first & 15) << 12 | (bytes[index++] & 0x3f) << 6 | bytes[index++] & 0x3f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      if (index + 2 >= bytes.length || (bytes[index] & 0xc0) !== 0x80 || (bytes[index + 1] & 0xc0) !== 0x80 || (bytes[index + 2] & 0xc0) !== 0x80
        || first === 0xf0 && bytes[index] < 0x90 || first === 0xf4 && bytes[index] >= 0x90) return fallback();
      point = (first & 7) << 18 | (bytes[index++] & 0x3f) << 12 | (bytes[index++] & 0x3f) << 6 | bytes[index++] & 0x3f;
    } else return fallback();
    if (point === 0xfeff && at === 0) continue;
    if (point > 0xffff) { point -= 0x10000; emit(0xd800 | point >>> 10); emit(0xdc00 | point & 0x3ff); }
    else {
      units[used++] = point;
      if (used === units.length) { result += String.fromCharCode.apply(null, units); used = 0; }
    }
  }
  if (used) result += String.fromCharCode.apply(null, units.subarray(0, used));
  return result;
}
function timedDecode(stage, work, observer) {
  if (typeof observer !== 'function') return work();
  const clock = () => typeof performance === 'undefined' ? Date.now() : performance.now(), started = clock();
  try { return work(); } finally { try { observer(stage, clock() - started); } catch { /* Diagnostics never change payload semantics. */ } }
}
function watermark(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512; }
function machines(value) { return Array.isArray(value) && value.length <= 256 && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512); }

/** Strictly recognized constants only: unknown payload fields are never dropped. */
function emptyDelta(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === EMPTY_DELTA_KEYS.length
    && Object.keys(value).every(key => EMPTY_DELTA_KEYS.includes(key)) && value.version === 2 && value.mode === 'delta'
    && watermark(value.watermark) && value.watermark === value.baseWatermark && machines(value.machineIds)
    && Array.isArray(value.sessions) && value.sessions.length === 0 && Array.isArray(value.removedIds) && value.removedIds.length === 0
    && value.hasMore === false && value.nextCursor === null && typeof value.scannedAt === 'number' && Number.isFinite(value.scannedAt);
}

/** JSON body compaction is lossless and independent of native command routing. */
export function compactPeerBody(payload) {
  const compact = emptyDelta(payload);
  const encoded = JSON.stringify(compact ? [payload.watermark, payload.machineIds, payload.scannedAt] : payload);
  if (typeof encoded !== 'string') throw Error('invalid-peer-payload');
  const body = new TextEncoder().encode(encoded);
  if (body.length > MAX_BODY) throw Error('peer-response-too-large');
  return { body, compact };
}

/** @param {Uint8Array} bytes @param {number} offset */
function readUint32LE(bytes, offset) {
  if (!(bytes instanceof Uint8Array) || offset < 0 || offset + 4 > bytes.byteLength) throw Error('invalid-peer-frame');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

/** @param {Uint8Array} body @param {number} expected @param {string} [code] */
function assertValidGzipBody(body, expected, code = 'invalid-peer-compression') {
  if (!(body instanceof Uint8Array) || body.byteLength < 18 || body[0] !== 31 || body[1] !== 139 || body[2] !== 8 || body[3] !== 0
    || readUint32LE(body, body.byteLength - 4) !== expected) throw Error(code);
}

/** The compressor runs on the Mac before NaCl sealing. A portable decoder does
 * not depend on Node, browser compression streams or native gzip APIs. */
export function encodeCompactPeerPlaintext(peerId, payload, compress) {
  if (typeof peerId !== 'string' || !/^[a-f0-9]{64}$/.test(peerId)) throw Error('invalid-peer-identity');
  const { body, compact } = compactPeerBody(payload);
  let encoded = body, flags = compact ? 2 : 0;
  if (typeof compress === 'function' && body.length >= 256) {
    const candidate = compress(body);
    if (!(candidate instanceof Uint8Array)) throw Error('invalid-peer-compressor');
    if (candidate.length + 32 <= body.length) {
      assertValidGzipBody(candidate, body.length, 'invalid-peer-compressor');
      encoded = candidate;
      flags |= 1;
    }
  }
  const plain = new Uint8Array(PEER_COMPACT_PREFIX_BYTES + encoded.length); plain[0] = flags;
  for (let index = 0; index < 32; index++) plain[index + 1] = parseInt(peerId.slice(index * 2, index * 2 + 2), 16);
  new DataView(plain.buffer, plain.byteOffset, plain.byteLength).setUint32(33, body.length, true);
  plain.set(encoded, PEER_COMPACT_PREFIX_BYTES); return plain;
}

/** Called only after pinned-Mac NaCl authentication. The expected peer remains
 * authenticated inside the frame even when its public JSON wrapper is compact. */
export function inspectCompactPeerPlaintext(plain, expectedPeerId) {
  if (!(plain instanceof Uint8Array) || plain.length < PEER_COMPACT_PREFIX_BYTES || plain.length > PEER_RESPONSE_MAX_BYTES
    || plain[0] > 3 || typeof expectedPeerId !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPeerId)) throw Error('invalid-peer-frame');
  let peerId = ''; for (let index = 1; index <= 32; index++) peerId += plain[index].toString(16).padStart(2, '0');
  if (peerId !== expectedPeerId) throw Error('foreign-peer-frame');
  const expected = readUint32LE(plain, 33);
  if (expected < 2 || expected > MAX_BODY) throw Error('peer-response-too-large');
  const body = plain.subarray(PEER_COMPACT_PREFIX_BYTES), compressed = (plain[0] & 1) !== 0;
  if (compressed) assertValidGzipBody(body, expected);
  else if (body.length !== expected) throw Error('invalid-peer-length');
  return { body, expectedBytes: expected, compressed, compact: (plain[0] & 2) !== 0 };
}

export function parseCompactPeerJson(text, compact) {
  if (typeof text !== 'string' || text.length > MAX_BODY || typeof compact !== 'boolean') throw Error('invalid-peer-json');
  let value; try { value = JSON.parse(text); } catch { throw Error('invalid-peer-json'); }
  if (!compact) return value;
  if (!Array.isArray(value) || value.length !== 3 || !watermark(value[0]) || !machines(value[1])
    || typeof value[2] !== 'number' || !Number.isFinite(value[2])) throw Error('invalid-peer-compact-payload');
  return { version: 2, mode: 'delta', watermark: value[0], baseWatermark: value[0], machineIds: value[1],
    sessions: [], removedIds: [], hasMore: false, nextCursor: null, scannedAt: value[2] };
}

export function decodeCompactPeerPlaintext(plain, expectedPeerId, options = {}) {
  const frame = inspectCompactPeerPlaintext(plain, expectedPeerId), expected = frame.expectedBytes;
  let body = frame.body;
  if (frame.compressed) {
    // fflate honors a fixed output buffer and truncates larger streams. One extra
    // byte makes an oversized expansion detectable while keeping allocation bound.
    const checksum = readUint32LE(body, body.byteLength - 8);
    body = timedDecode('inflate', () => gunzipSync(body, { out: new Uint8Array(expected + 1) }), options.onStage);
    if (body.length !== expected) throw Error('invalid-peer-length');
    if (timedDecode('checksum', () => crc32(body), options.onStage) !== checksum) throw Error('invalid-peer-compression');
  } else if (body.length !== expected) throw Error('invalid-peer-length');
  let text; try {
    text = timedDecode('utf8', () => typeof options.decodeText === 'function' ? options.decodeText(body) : new TextDecoder().decode(body), options.onStage);
  } catch { throw Error('invalid-peer-json'); }
  return timedDecode('json', () => parseCompactPeerJson(text, frame.compact), options.onStage);
}
