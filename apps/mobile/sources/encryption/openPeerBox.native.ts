import sodium from '@/encryption/libsodium.lib';

export function openPeerBox(ciphertext: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null {
    if (ciphertext.length < 16 || nonce.length !== 24 || publicKey.length !== 32 || secretKey.length !== 32) return null;
    // The TurboModule reads entire ArrayBuffers, so every argument must own
    // exactly its intended bytes, including Buffer/subarray caller inputs.
    try {
        return sodium.crypto_box_open_easy(new Uint8Array(ciphertext), new Uint8Array(nonce), new Uint8Array(publicKey), new Uint8Array(secretKey));
    } catch {
        // Authentication failure is final; never retry with the JS decoder.
        return null;
    }
}
