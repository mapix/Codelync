import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createProbeEncryption, installProbeEncryption } = createRequire(import.meta.url)('../scripts/claude-probe-keystore.cjs');

test('isolated encryption persists only a private key and never invokes the original keychain functions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-probe-store-'));
    try {
        let originalCalls = 0;
        const original = { encryptString: (/** @type {unknown} */ value) => { void value; originalCalls++; throw Error('OS keychain unavailable'); } };
        const path = join(dir, 'private.key'), store = installProbeEncryption(original, path);
        const encrypted = original.encryptString('Gateway fixture 正文');
        assert.equal(createProbeEncryption(path).decryptString(encrypted), 'Gateway fixture 正文');
        assert.equal((await stat(path)).mode & 0o077, 0); assert.equal(originalCalls, 0);
        const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] ^= 1;
        assert.throws(() => store.decryptString(tampered)); assert.throws(() => store.decryptString(Buffer.from('vendor ciphertext')));
    } finally { await rm(dir, { recursive: true, force: true }); }
});
