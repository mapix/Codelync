import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { gzipSync } from 'node:zlib';
import sodium from '@/encryption/libsodium.lib';
import { encodeBase64 } from '@/encryption/base64';
import { encodeCompactPeerPlaintext } from '@slopus/happy-wire/peer-codec';

vi.mock('@/encryption/libsodium.lib', () => ({ default: require('libsodium-wrappers') }));
vi.mock('@/encryption/openPeerBox', () => import('./openPeerBox.native'));
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(require('node:crypto').randomBytes(length)) }));

import { openPeerBox } from './openPeerBox.native';
import { decodePeerResponse } from '@/sync/peerNetwork';

const mac = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3));
const phone = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
const nonce = new Uint8Array(24).fill(9);
const peer = { id: 'ab'.repeat(32), key: encodeBase64(mac.publicKey, 'base64url'), channels: [],
    device: { publicKey: encodeBase64(phone.publicKey, 'base64url'), secretKey: encodeBase64(phone.secretKey, 'base64url') } };

beforeAll(async () => { await sodium.ready; });
afterEach(() => { vi.restoreAllMocks(); });

function offsetView(value: Uint8Array): Uint8Array {
    const buffer = Buffer.alloc(value.length + 23, 255);
    buffer.set(value, 7);
    return buffer.subarray(7, value.length + 7);
}

describe('native peer box authentication', () => {
    it('interoperates with TweetNaCl for empty, Unicode and received-body sized ciphertexts', () => {
        const inputs = [new Uint8Array(), new TextEncoder().encode('Native Unicode 正文'), new Uint8Array(78349).fill(27)];
        for (const plain of inputs) {
            const cipher = nacl.box(plain, nonce, phone.publicKey, mac.secretKey);
            expect(openPeerBox(cipher, nonce, mac.publicKey, phone.secretKey)).toEqual(plain);
            const sodiumCipher = sodium.crypto_box_easy(plain, nonce, phone.publicKey, mac.secretKey);
            expect(nacl.box.open(sodiumCipher, nonce, mac.publicKey, phone.secretKey)).toEqual(plain);
            expect(openPeerBox(sodiumCipher, nonce, mac.publicKey, phone.secretKey)).toEqual(plain);
        }
    });

    it('passes independent exact-length Uint8Arrays for all four offset or Buffer inputs', () => {
        const plain = new Uint8Array(78349).fill(41);
        const inputs = [nacl.box(plain, nonce, phone.publicKey, mac.secretKey), nonce, mac.publicKey, phone.secretKey].map(offsetView);
        const opened = vi.spyOn(sodium, 'crypto_box_open_easy');
        expect(openPeerBox(inputs[0], inputs[1], inputs[2], inputs[3])).toEqual(plain);
        expect(opened).toHaveBeenCalledTimes(1);
        for (const [index, input] of opened.mock.calls[0].slice(0, 4).entries()) {
            if (!(input instanceof Uint8Array)) throw Error('Native argument must be bytes');
            expect(input.constructor).toBe(Uint8Array);
            expect(input.byteOffset).toBe(0);
            expect(input.buffer.byteLength).toBe(inputs[index].length);
            expect(input.buffer).not.toBe(inputs[index].buffer);
            expect(input).toEqual(new Uint8Array(inputs[index]));
        }
    });

    it('rejects altered ciphertext, nonce and pinned keys without a JS fallback', () => {
        const cipher = nacl.box(new Uint8Array([1, 2, 3]), nonce, phone.publicKey, mac.secretKey);
        const fallback = vi.spyOn(nacl.box, 'open');
        const opened = vi.spyOn(sodium, 'crypto_box_open_easy');
        for (let changed = 0; changed < 4; changed++) {
            const inputs = [cipher, nonce, mac.publicKey, phone.secretKey].map(value => new Uint8Array(value));
            // X25519 clamps the secret key's low bits; alter a significant bit.
            inputs[changed][changed === 3 ? 16 : 0] ^= 1;
            expect(openPeerBox(inputs[0], inputs[1], inputs[2], inputs[3])).toBeNull();
        }
        expect(opened).toHaveBeenCalledTimes(4);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('rejects undersized ciphertext and malformed key/nonce lengths before entering native code', () => {
        const opened = vi.spyOn(sodium, 'crypto_box_open_easy');
        expect(openPeerBox(new Uint8Array(15), nonce, mac.publicKey, phone.secretKey)).toBeNull();
        expect(openPeerBox(new Uint8Array(16), new Uint8Array(23), mac.publicKey, phone.secretKey)).toBeNull();
        expect(openPeerBox(new Uint8Array(16), nonce, new Uint8Array(31), phone.secretKey)).toBeNull();
        expect(openPeerBox(new Uint8Array(16), nonce, mac.publicKey, new Uint8Array(33))).toBeNull();
        expect(opened).not.toHaveBeenCalled();
    });

    it('uses native authentication for both v2 and compressed v3 peer responses', () => {
        const payload = { version: 1, rows: [{ id: 'fixture', text: 'Native Unicode 正文 '.repeat(900) }] };
        const plains = [new TextEncoder().encode(JSON.stringify({ peerId: peer.id, payload })), encodeCompactPeerPlaintext(peer.id, payload, body => gzipSync(body))];
        const opened = vi.spyOn(sodium, 'crypto_box_open_easy');
        const fallback = vi.spyOn(nacl.box, 'open');
        for (const [index, plain] of plains.entries()) {
            const cipher = nacl.box(plain, nonce, phone.publicKey, mac.secretKey);
            const nonceText = encodeBase64(nonce, 'base64url'), cipherText = encodeBase64(cipher, 'base64url');
            const packet = index === 0 ? { version: 2, nonce: nonceText, ciphertext: cipherText } : [3, nonceText, cipherText];
            expect(decodePeerResponse(peer, packet)).toEqual(payload);
            const tampered = new Uint8Array(cipher); tampered[0] ^= 1;
            const badPacket = index === 0 ? { version: 2, nonce: nonceText, ciphertext: encodeBase64(tampered, 'base64url') } : [3, nonceText, encodeBase64(tampered, 'base64url')];
            expect(() => decodePeerResponse(peer, badPacket)).toThrow(/authenticate/);
        }
        expect(opened).toHaveBeenCalledTimes(4);
        expect(fallback).not.toHaveBeenCalled();
    });
});
