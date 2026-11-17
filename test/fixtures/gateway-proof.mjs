import { createHash, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { DeviceProofVerifier } from '../../src/network/device-proof.mjs';

/** Synthetic device proof for real gateway HTTP/WebSocket tests.
 * @param {import('../../src/codelync/pairing-gateway.mjs').PairingInvitations} invitations
 * @param {{token?:string,origin?:string,devices?:Pick<import('../../src/codelync/device-registry.mjs').DeviceRegistry,'authorize'>}} [options] */
export function gatewayProof(invitations, options = {}) {
  const phone = nacl.box.keyPair(), publicKey = Buffer.from(phone.publicKey).toString('base64url');
  const id = createHash('sha256').update(publicKey).digest('hex').slice(0, 24);
  const token = options.token ?? 'synthetic-device-token', origin = options.origin ?? 'https://fixture.example';
  const devices = options.devices ?? { authorize: (/** @type {unknown} */ value) => value === token ? id : null };
  const proof = new DeviceProofVerifier({ key: invitations.pair.secretKey, devices, origins: () => [origin] });
  /** @param {string} path @param {string} [method] */
  const headers = (path, method = 'GET') => {
    const nonce = randomBytes(24), payload = { version: 2, token, origin, method, path, at: Date.now() };
    return { Authorization: 'Codelync ' + Buffer.from(JSON.stringify({ publicKey, nonce: nonce.toString('base64url'),
      ciphertext: Buffer.from(nacl.box(Buffer.from(JSON.stringify(payload)), nonce, invitations.pair.publicKey, phone.secretKey)).toString('base64url') })).toString('base64url') };
  };
  return { proof, headers, publicKey, id };
}
