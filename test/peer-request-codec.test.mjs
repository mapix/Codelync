import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { openPeerActivityRequest, PEER_ACTIVITY_REQUEST_MAX_BYTES } from '../src/codelync/peer-request-codec.mjs';
import { createPairingGateway, PairingInvitations } from '../src/codelync/pairing-gateway.mjs';
import { DeviceRegistry } from '../src/codelync/device-registry.mjs';
import { DeviceProofVerifier } from '../src/network/device-proof.mjs';

/** @typedef {Record<string,any>} Value */
const peerId = 'ab'.repeat(32), path = '/api/peer/activity', method = 'POST';
const payload = { activityProtocol: 2, clientId: 'fixture-viewer', requestSeq: 1,
  groups: [{ id: 'fixture-project-private-marker', projectKey: '/fixture/private-workspace-中文', hostId: 'local' }] };
/** @param {unknown} frame @param {{publicKey:Uint8Array}} mac @param {{secretKey:Uint8Array}} phone */
function seal(frame, mac, phone) {
  const nonce = randomBytes(24), plain = Buffer.from(JSON.stringify(frame));
  return [2, nonce.toString('base64url'), Buffer.from(nacl.box(plain, nonce, mac.publicKey, phone.secretKey)).toString('base64url')];
}

test('activity descriptor paths stay encrypted and bind Mac, route, method and device', () => {
  const mac = nacl.box.keyPair(), phone = nacl.box.keyPair();
  const scope = { peerId, path, method, devicePublicKey: phone.publicKey, macSecretKey: mac.secretKey };
  const packet = seal([peerId, method, path, payload], mac, phone);
  assert.deepEqual(openPeerActivityRequest(packet, scope), payload);
  assert.equal(JSON.stringify(packet).includes('/fixture/'), false); assert.equal(JSON.stringify(packet).includes('private-marker'), false);
  assert.notEqual(packet[1], seal([peerId, method, path, payload], mac, phone)[1]);
  for (const wrong of [{ ...scope, peerId: 'cd'.repeat(32) }, { ...scope, path: '/api/peer/catalog' }, { ...scope, method: 'GET' },
    { ...scope, devicePublicKey: nacl.box.keyPair().publicKey }, { ...scope, macSecretKey: nacl.box.keyPair().secretKey }]) {
    assert.throws(() => openPeerActivityRequest(packet, wrong), { code: 'invalid-peer-request' });
  }
});

test('malformed or oversized carriers fail before activity payload admission; old object requests remain compatible', () => {
  const mac = nacl.box.keyPair(), phone = nacl.box.keyPair();
  const scope = { peerId, path, method, devicePublicKey: phone.publicKey, macSecretKey: mac.secretKey };
  for (const packet of [[3, '', ''], [2, 'x'.repeat(32), '!invalid'], [2, 'x'.repeat(32), 'a'.repeat(400000)],
    seal({ peerId, path, method, payload }, mac, phone), seal([peerId, method, path, []], mac, phone),
    seal([peerId, method, path, { groups: ['x'.repeat(PEER_ACTIVITY_REQUEST_MAX_BYTES)] }], mac, phone)]) {
    assert.throws(() => openPeerActivityRequest(packet, scope), { code: 'invalid-peer-request' });
  }
  assert.deepEqual(openPeerActivityRequest(payload, scope), payload);
});

test('real HTTP gateway opens activity only after existing device proof, and rejects a changed ciphertext before producer reads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-request-codec-'));
  const devices = new DeviceRegistry(join(directory, 'devices.json')), invitations = new PairingInvitations({ key: randomBytes(32), credentials: {} });
  const phone = nacl.box.keyPair(), publicKey = Buffer.from(phone.publicKey).toString('base64url'), token = 'synthetic-sealed-request-token';
  await devices.approve(publicKey, 'Synthetic phone', token);
  const proof = new DeviceProofVerifier({ key: invitations.pair.secretKey, devices, origins: () => ['https://fixture.example'] });
  function headers() {
    const nonce = randomBytes(24), frame = { version: 2, token, origin: 'https://fixture.example', method, path, at: Date.now() };
    return { 'Content-Type': 'application/json', Authorization: 'Codelync ' + Buffer.from(JSON.stringify({ publicKey, nonce: nonce.toString('base64url'),
      ciphertext: Buffer.from(nacl.box(Buffer.from(JSON.stringify(frame)), nonce, invitations.pair.publicKey, phone.secretKey)).toString('base64url') })).toString('base64url') };
  }
  let reads = 0;
  const gateway = createPairingGateway({ upstream: 'http://127.0.0.1:9', devices, invitations, proof, peerId: () => peerId,
    peerApi: async (_path, _method, body) => { reads++; assert.deepEqual(body, payload); return { ok: true }; } });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening'); const address = gateway.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); invitations.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${address.port}${path}`, packet = seal([peerId, method, path, payload], invitations.pair, phone);
  assert.equal((await fetch(url, { method, body: JSON.stringify(packet) })).status, 401); assert.equal(reads, 0);
  const changed = [...packet], changedCipher = Buffer.from(/** @type {string} */ (packet[2]), 'base64url');
  changedCipher[0] ^= 1; changed[2] = changedCipher.toString('base64url');
  assert.equal((await fetch(url, { method, headers: headers(), body: JSON.stringify(changed) })).status, 400); assert.equal(reads, 0);
  assert.equal((await fetch(url, { method, headers: headers(), body: JSON.stringify(packet) })).status, 200); assert.equal(reads, 1);
});
