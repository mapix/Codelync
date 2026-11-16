import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import nacl from 'tweetnacl';
import { encodeCompactPeerPlaintext, PEER_RESPONSE_MAX_BYTES, PEER_RESPONSE_CODEC_VALUE } from '@slopus/happy-wire/peer-codec';

/** @typedef {Record<string,any>} Value */

/** Encode only after the request's approved-device authorization. Negotiation is
 * optional; older peers keep exactly the v2 envelope and its existing size bound.
 * @param {string|undefined} peerId @param {unknown} payload @param {Uint8Array} phoneKey @param {Uint8Array} macKey @param {unknown} accepted */
export function sealPeerResponse(peerId, payload, phoneKey, macKey, accepted) {
  const legacy = Buffer.from(JSON.stringify({ peerId, payload }));
  if (legacy.length > PEER_RESPONSE_MAX_BYTES) throw Error('peer-response-too-large');
  const compact = accepted === PEER_RESPONSE_CODEC_VALUE && typeof peerId === 'string' && /^[a-f0-9]{64}$/.test(peerId);
  const plain = compact ? encodeCompactPeerPlaintext(/** @type {string} */ (peerId), payload, body => gzipSync(body, { level: 6 })) : legacy;
  const nonce = randomBytes(24), ciphertext = nacl.box(plain, nonce, phoneKey, macKey);
  const encodedNonce = nonce.toString('base64url'), encodedCiphertext = Buffer.from(ciphertext).toString('base64url');
  return compact ? [3, encodedNonce, encodedCiphertext] : { version: 2, nonce: encodedNonce, ciphertext: encodedCiphertext };
}
