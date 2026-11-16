import nacl from 'tweetnacl';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
export const PEER_ACTIVITY_REQUEST_MAX_BYTES = 256 * 1024;
export const PEER_ACTIVITY_CARRIER_MAX_BYTES = 360 * 1024;
const MAX_PLAIN = PEER_ACTIVITY_REQUEST_MAX_BYTES + 512;
const invalid = () => new BridgeError('invalid-peer-request', 'The sealed peer request could not be verified.', 400);

/** Opens only data encrypted by this already-approved device for this exact Mac/route.
 * Older object-body clients keep their existing transport compatibility.
 * @param {unknown} packet @param {{peerId:string,path:string,method:string,devicePublicKey:Uint8Array,macSecretKey:Uint8Array}} scope
 * @returns {Value} */
export function openPeerActivityRequest(packet, scope) {
  if (!Array.isArray(packet)) {
    if (!packet || typeof packet !== 'object' || Buffer.byteLength(JSON.stringify(packet)) > PEER_ACTIVITY_REQUEST_MAX_BYTES) throw invalid();
    return /** @type {Value} */ (packet);
  }
  if (packet.length !== 3 || packet[0] !== 2 || typeof packet[1] !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(packet[1])
    || typeof packet[2] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(packet[2])
    || packet[2].length > Math.ceil((MAX_PLAIN + 16) * 4 / 3)
    || !scope || typeof scope.peerId !== 'string' || !scope.peerId || scope.devicePublicKey?.length !== 32 || scope.macSecretKey?.length !== 32) throw invalid();
  const nonce = new Uint8Array(Buffer.from(packet[1], 'base64url')), cipher = new Uint8Array(Buffer.from(packet[2], 'base64url'));
  if (nonce.length !== 24 || cipher.length < 16 || cipher.length > MAX_PLAIN + 16) throw invalid();
  const plain = nacl.box.open(cipher, nonce, scope.devicePublicKey, scope.macSecretKey);
  if (!plain || plain.length > MAX_PLAIN) throw invalid();
  let frame;
  try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); } catch { throw invalid(); }
  if (!Array.isArray(frame) || frame.length !== 4 || frame[0] !== scope.peerId || frame[1] !== scope.method || frame[2] !== scope.path
    || !frame[3] || typeof frame[3] !== 'object' || Array.isArray(frame[3])
    || Buffer.byteLength(JSON.stringify(frame[3])) > PEER_ACTIVITY_REQUEST_MAX_BYTES) throw invalid();
  return frame[3];
}
