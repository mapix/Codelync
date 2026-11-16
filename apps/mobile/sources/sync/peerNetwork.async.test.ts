import nacl from 'tweetnacl';
import { gzipSync, gunzipSync } from 'node:zlib';
import { beforeEach, expect, it, vi } from 'vitest';
import { encodeCompactPeerPlaintext } from '@slopus/happy-wire/peer-codec';
const native = vi.hoisted(() => ({ available: true, decode: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (count: number) => new Uint8Array(count).fill(9) }));
vi.mock('@/encryption/nativePeerPayload', () => ({ nativePeerPayloadAvailable: () => native.available, decodeNativePeerPayload: native.decode }));
import { decodePeerResponseAsync } from './peerNetwork';
import { encodeBase64 } from '@/encryption/base64';

function fixture() {
    const mac = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3)), phone = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
    const peer = { id: 'ab'.repeat(32), key: encodeBase64(mac.publicKey, 'base64url'), channels: [{ id: 'local', kind: 'local' as const, url: 'http://127.0.0.1:8800' }],
        device: { publicKey: encodeBase64(phone.publicKey, 'base64url'), secretKey: encodeBase64(phone.secretKey, 'base64url') } };
    const payload = { rows: [{ id: 'native', text: '完整原生 Unicode 🌍 '.repeat(5000) }], exact: { flags: [true, false, 0, null] } };
    const plain = encodeCompactPeerPlaintext(peer.id, payload, bytes => gzipSync(bytes)), nonce = new Uint8Array(24).fill(9), ciphertext = nacl.box(plain, nonce, phone.publicKey, mac.secretKey);
    return { peer, payload, packet: [3, encodeBase64(nonce, 'base64url'), encodeBase64(ciphertext, 'base64url')] };
}
beforeEach(() => {
    native.available = true; native.decode.mockReset();
    native.decode.mockImplementation(async request => ({ text: (request.compression === 'gzip' ? gunzipSync(Buffer.from(request.bodyBase64, 'base64')) : Buffer.from(request.bodyBase64, 'base64')).toString('utf8') }));
});

it('authenticates first and passes only the exact body bytes and bounded native parameters', async () => {
    const { peer, payload, packet } = fixture();
    expect(await decodePeerResponseAsync(peer, packet)).toEqual(payload);
    const request = native.decode.mock.calls[0][0];
    expect(Object.keys(request).sort()).toEqual(['bodyBase64', 'compression', 'expectedBytes', 'includeMetrics']);
    expect(JSON.parse(gunzipSync(Buffer.from(request.bodyBase64, 'base64')).toString())).toEqual(payload);
    const bad = String(packet[2]).slice(0, -2) + 'AA';
    await expect(decodePeerResponseAsync(peer, [3, packet[1], bad])).rejects.toThrow(/authenticate/);
    expect(native.decode).toHaveBeenCalledTimes(1);
});

it('discards a late native result after context changes instead of publishing it', async () => {
    const { peer, packet } = fixture(); let current = true;
    native.decode.mockImplementation(async request => { current = false; return { text: gunzipSync(Buffer.from(request.bodyBase64, 'base64')).toString() }; });
    await expect(decodePeerResponseAsync(peer, packet, { isCurrent: () => current })).rejects.toThrow('context changed');
});

it('retries only bounded native busy data work and preserves UTF8-only compatibility', async () => {
    const { peer, payload, packet } = fixture();
    native.decode.mockRejectedValueOnce({ code: 'E_CODEC_BUSY' }).mockRejectedValueOnce({ code: 'E_CODEC_BUSY' });
    expect(await decodePeerResponseAsync(peer, packet)).toEqual(payload); expect(native.decode).toHaveBeenCalledTimes(3);
    native.decode.mockReset(); native.decode.mockRejectedValue({ code: 'E_CODEC_UTF8' });
    expect(await decodePeerResponseAsync(peer, packet)).toEqual(payload); expect(native.decode).toHaveBeenCalledTimes(1);
});

it.each(['E_CODEC_GZIP', 'E_CODEC_CRC', 'E_CODEC_LENGTH', 'E_CODEC_UNKNOWN'])('does not fall back on native %s errors', async code => {
    const { peer, packet } = fixture(); native.decode.mockRejectedValue({ code });
    await expect(decodePeerResponseAsync(peer, packet)).rejects.toEqual({ code }); expect(native.decode).toHaveBeenCalledTimes(1);
});
