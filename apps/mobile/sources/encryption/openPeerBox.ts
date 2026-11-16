import nacl from 'tweetnacl';

export function openPeerBox(ciphertext: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null {
    return nacl.box.open(ciphertext, nonce, publicKey, secretKey);
}
