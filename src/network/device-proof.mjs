import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { channelPath } from '@codelync/wire/codelync';

const AUTHORIZATION_PREFIX = 'Codelync ';

/** Private-LAN authorization keeps device bearer tokens inside the sealed box. */
export class DeviceProofVerifier {
  /** @param {{key:Uint8Array,devices:{authorize:(token:unknown)=>string|null},origins:()=>string[],now?:()=>number}} options */
  constructor({ key, devices, origins, now = Date.now }) {
    this.key = key; this.devices = devices; this.origins = origins; this.now = now; this.seen = /** @type {Map<string,number>} */ (new Map());
    this.tailExpiry = 0;
  }
  /** @param {unknown} header @param {string} method @param {string} requestUrl @param {string|null} [expectedOrigin] */
  authorize(header, method, requestUrl, expectedOrigin) {
    if (typeof header !== 'string' || !header.startsWith(AUTHORIZATION_PREFIX) || header.length > 8192) return null;
    try {
      const now = this.now();
      const packet = JSON.parse(Buffer.from(header.slice(AUTHORIZATION_PREFIX.length), 'base64url').toString());
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)
        || !/^[A-Za-z0-9_-]{43}$/.test(packet.publicKey) || !/^[A-Za-z0-9_-]{32}$/.test(packet.nonce) || typeof packet.ciphertext !== 'string') return null;
      const publicKey = Buffer.from(packet.publicKey, 'base64url'), nonce = Buffer.from(packet.nonce, 'base64url');
      const plain = nacl.box.open(Buffer.from(packet.ciphertext, 'base64url'), nonce, publicKey, this.key);
      if (!plain) return null;
      const proof = JSON.parse(Buffer.from(plain).toString());
      if (!proof || typeof proof !== 'object' || Array.isArray(proof)
        || proof.version !== 2 || !Number.isSafeInteger(proof.at) || Math.abs(now - proof.at) > 60000
        || proof.method !== method || !this.origins().includes(proof.origin) || expectedOrigin && proof.origin !== expectedOrigin || proof.path !== channelPath(proof.origin, proof.origin + requestUrl)) return null;
      // 一份设备证明只能使用一次；所有入口共享该 owner，不能跨内网接口重放。
      const replay = packet.publicKey + ':' + packet.nonce;
      if (this.seen.has(replay)) return null;
      if (!this.seen.size) this.tailExpiry = 0;
      for (const [id, until] of this.seen) {
        if (until >= now) break;
        this.seen.delete(id);
      }
      if (this.seen.size >= 10000) return null;
      const deviceId = this.devices.authorize(proof.token);
      if (!deviceId || deviceId !== createHash('sha256').update(packet.publicKey).digest('hex').slice(0, 24)) return null;
      const expiry = Math.max(now + 60000, this.tailExpiry);
      this.tailExpiry = expiry;
      this.seen.set(replay, expiry);
      return { id: deviceId, token: proof.token };
    } catch { return null; }
  }
}
