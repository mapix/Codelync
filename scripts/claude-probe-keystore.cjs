const { readFileSync, writeFileSync, mkdirSync, statSync } = require('node:fs');
const { dirname, isAbsolute } = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');

const MAGIC = Buffer.from('codelight-claude-probe-v1\0');

/** Probe-only encryption; no OS/login keychain or target-code side effects. */
function createProbeEncryption(keyPath) {
    if (!isAbsolute(keyPath)) throw Error('A private absolute probe key path is required');
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    let key;
    try {
        if ((statSync(keyPath).mode & 0o077) !== 0) throw Error('Probe key permissions are not private');
        key = readFileSync(keyPath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        key = randomBytes(32); writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
    }
    if (key.length !== 32) throw Error('The private probe key has an invalid size');
    return {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'codelight-private-file',
        encryptString: (value) => {
            const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
            return Buffer.concat([MAGIC, nonce, cipher.update(String(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
        },
        decryptString: (value) => {
            const bundle = Buffer.from(value);
            if (bundle.length < MAGIC.length + 28 || !bundle.subarray(0, MAGIC.length).equals(MAGIC)) throw Error('Unsupported isolated probe ciphertext');
            const nonce = bundle.subarray(MAGIC.length, MAGIC.length + 12), body = bundle.subarray(MAGIC.length + 12, -16);
            const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAuthTag(bundle.subarray(-16));
            return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
        },
    };
}

function installProbeEncryption(safeStorage, keyPath) {
    const implementation = createProbeEncryption(keyPath);
    for (const [name, method] of Object.entries(implementation)) Object.defineProperty(safeStorage, name, { value: method, configurable: true });
    return implementation;
}

module.exports = { createProbeEncryption, installProbeEncryption };
