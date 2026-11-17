import { beforeEach, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
const cache = vi.hoisted(() => ({ value: {} as any }));
vi.mock('./codelyncBackgroundCache', () => ({ codelyncAccountScope: async (credentials: any) => credentials.peer.id,
    loadCodelyncBackgroundCache: () => cache.value, saveCodelyncBackgroundCache: (value: any) => { cache.value = value; } }));
vi.mock('@/encryption/blob', () => ({
    encryptBlob: (plain: Uint8Array, key: Uint8Array) => {
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
        return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    },
    decryptBlob: (blob: Uint8Array, key: Uint8Array) => {
        const bytes = Buffer.from(blob), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
    },
}));
import { loadCodelyncPeerCatalog, loadCodelyncPeerCatalogState, saveCodelyncPeerCatalog } from './codelyncPeerCatalogCache';
const credentials: any = { secret: Buffer.alloc(32, 1).toString('base64url'), peer: { id: 'peer-one' } };
const descriptor: any = { id: 'cached-session', nativeUpdatedAt: 100, createdAt: 1, activeAt: 100, active: true,
    metadataVersion: 1, agentStateVersion: 1, seq: 1, agentState: {}, metadata: { title: 'Private session title' } };
beforeEach(() => { cache.value = { scope: 'peer-one', updatedAt: 0, sessions: [], selected: [], messages: {} }; });
it('restores browsable descriptors with active facts unknown and stores only encrypted title data', async () => {
    await saveCodelyncPeerCatalog(credentials, [descriptor], () => true);
    expect(JSON.stringify(cache.value)).not.toContain('Private session title');
    expect(await loadCodelyncPeerCatalog(credentials)).toEqual([{ ...descriptor, active: false, basicOnly: true, agentState: null }]);
});
it('different peers, wrong keys and damaged data cannot restore another catalog', async () => {
    await saveCodelyncPeerCatalog(credentials, [descriptor], () => true);
    expect(await loadCodelyncPeerCatalog({ ...credentials, peer: { id: 'peer-two' } })).toEqual([]);
    expect(await loadCodelyncPeerCatalog({ ...credentials, secret: Buffer.alloc(32, 2).toString('base64url') })).toEqual([]);
    cache.value.peerCatalogCiphertext = 'damaged'; expect(await loadCodelyncPeerCatalog(credentials)).toEqual([]);
});
it('a changed account cannot commit a late catalog', async () => {
    await saveCodelyncPeerCatalog(credentials, [descriptor], () => false);
    expect(cache.value.peerCatalogCiphertext).toBeUndefined();
});
it('opaque catalog watermark stays inside encrypted current-peer cache', async () => {
    await saveCodelyncPeerCatalog(credentials, [descriptor], () => true, 'private-epoch:4');
    expect(JSON.stringify(cache.value)).not.toContain('private-epoch:4');
    expect((await loadCodelyncPeerCatalogState(credentials)).watermark).toBe('private-epoch:4');
    expect((await loadCodelyncPeerCatalogState({ ...credentials, peer: { id: 'foreign' } })).watermark).toBeNull();
});
