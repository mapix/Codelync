import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    set: vi.fn().mockResolvedValue(true),
    url: vi.fn(),
    switch: vi.fn().mockResolvedValue(undefined),
    reconnect: false,
    connected: true,
    endpoint: 'http://192.168.1.2:8800',
    proof: null as null | { peerId: string; endpoint: string; observedAt: number },
    listener: undefined as undefined | ((status: string) => void),
}));

vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { setCredentials: mocks.set } }));
vi.mock('./serverConfig', () => ({ commitPeerServerUrl: mocks.url }));
vi.mock('./apiSocket', () => ({
    apiSocket: {
        peerConnected: () => mocks.connected,
        peerCanReconnect: () => mocks.reconnect,
        peerEndpoint: () => mocks.endpoint,
        peerHttpProof: () => mocks.proof,
        onStatusChange: (listener: (status: string) => void) => {
            mocks.listener = listener;
            return () => {};
        },
        switchPeerChannel: mocks.switch,
    },
}));
vi.mock('./peerNetwork', () => ({
    peerAuthorization: () => 'sealed-device-proof',
    decodePeerResponse: (_peer: any, value: any) => value,
    setPeerRouteWriteFence: () => {},
    peerRouteWritable: () => true,
    peerResponseHeaders: () => ({}),
}));

vi.mock('@/encryption/deriveKey', () => ({ deriveKey: async () => new Uint8Array(32).fill(9) }));
vi.mock('@/encryption/libsodium.lib', () => ({
    default: { crypto_box_seed_keypair: () => ({ publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) }) },
}));
vi.mock('@/encryption/libsodium', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-id' }));
vi.mock('./encryption/encryptor', () => ({
    AES256Encryption: class {
        async decrypt(items: Uint8Array[]) {
            return items.map(item => JSON.parse(Buffer.from(item).toString('utf8')));
        }
        async encrypt(items: any[]) {
            return items.map(item => Buffer.from(JSON.stringify(item), 'utf8'));
        }
    },
    SecretBoxEncryption: class {
        async decrypt(items: Uint8Array[]) {
            return items.map(item => JSON.parse(Buffer.from(item).toString('utf8')));
        }
        async encrypt(items: any[]) {
            return items.map(item => Buffer.from(JSON.stringify(item), 'utf8'));
        }
    },
}));

import {
    getConnectionSnapshot,
    initializeCodelyncConnection,
    recoverCodelyncConnection,
    selectConnection,
} from './codelyncConnection';
import { EncryptionCache } from './encryption/encryptionCache';
import { Encryption } from './encryption/encryption';

const channels = [
    { id: 'local', kind: 'local' as const, url: 'http://192.168.1.2:8800' },
    { id: 'relay', kind: 'relay' as const, url: 'https://relay.example' },
];
const credentials: any = {
    token: 'fixture',
    secret: 'fixture-secret',
    serverUrl: channels[0].url,
    peer: {
        id: 'fixture-peer',
        key: 'fixture-key',
        channels,
        device: { publicKey: 'fixture-public', secretKey: 'fixture-private' },
        automatic: false,
        selectedChannel: 'local',
    },
    connectionPreference: {
        peerId: 'fixture-peer',
        devicePublicKey: 'fixture-public',
        mode: 'manual' as const,
        channelId: 'local',
        kind: 'local' as const,
    },
};

afterEach(() => {
    initializeCodelyncConnection({ token: 'fixture', secret: 'fixture' });
    mocks.set.mockClear();
    mocks.url.mockClear();
    mocks.switch.mockReset().mockImplementation(async (endpoint: string) => {
        mocks.endpoint = endpoint;
    });
    mocks.reconnect = false;
    mocks.connected = true;
    mocks.endpoint = channels[0].url;
    mocks.proof = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Track C Batch 2: R013 manual discovery skip failed same-kind URLs', () => {
    it('skips re-probing already-failed same-kind URL while probing genuinely new same-kind URL from discovery', async () => {
        const newLocal = { id: 'local-new', kind: 'local' as const, url: 'http://192.168.2.4:9900' };
        const freshManifest = [channels[0], newLocal, channels[1]];
        initializeCodelyncConnection(credentials);

        const probedUrls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            probedUrls.push(url);
            if (url.startsWith(channels[0].url)) return { ok: false, status: 503, json: async () => ({}) };
            return {
                ok: true,
                status: 200,
                json: async () => (url.endsWith('/network-probe') ? { version: 1 } : { channels: freshManifest }),
            };
        }));

        await recoverCodelyncConnection();

        expect(probedUrls.filter(u => u === `${channels[0].url}/network-probe`)).toHaveLength(1);
        expect(probedUrls).toContain(`${newLocal.url}/network-probe`);
        expect(mocks.switch.mock.calls.map(c => c[0])).toEqual([newLocal.url]);
        expect(getConnectionSnapshot()).toMatchObject({
            automatic: false,
            selectedId: newLocal.id,
            activeId: newLocal.id,
            desiredKind: 'local',
        });
    });

    it('probes a same-kind channel keeping the same id when discovery supplies a new URL', async () => {
        const updatedLocal = { id: 'local', kind: 'local' as const, url: 'http://192.168.2.9:9900' };
        const freshManifest = [updatedLocal, channels[1]];
        initializeCodelyncConnection(credentials);

        const probedUrls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            probedUrls.push(url);
            if (url.startsWith(channels[0].url)) return { ok: false, status: 404, json: async () => ({}) };
            return {
                ok: true,
                status: 200,
                json: async () => (url.endsWith('/network-probe') ? { version: 1 } : { channels: freshManifest }),
            };
        }));

        await selectConnection('local');

        expect(probedUrls.filter(u => u === `${channels[0].url}/network-probe`)).toHaveLength(1);
        expect(probedUrls).toContain(`${updatedLocal.url}/network-probe`);
        expect(mocks.switch.mock.calls.map(c => c[0])).toEqual([updatedLocal.url]);
    });

    it('skips freshBatch entirely when discovery only returns already-failed same-kind URLs', async () => {
        initializeCodelyncConnection(credentials);

        const probedUrls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            probedUrls.push(url);
            if (url.startsWith(channels[0].url)) return { ok: false, status: 503, json: async () => ({}) };
            return {
                ok: true,
                status: 200,
                json: async () => (url.endsWith('/network-probe') ? { version: 1 } : { channels }),
            };
        }));

        await expect(selectConnection('local')).rejects.toThrow();
        expect(probedUrls.filter(u => u === `${channels[0].url}/network-probe`)).toHaveLength(1);
        expect(mocks.switch).not.toHaveBeenCalled();
        expect(getConnectionSnapshot()).toMatchObject({
            automatic: false,
            selectedId: 'local',
            activeId: 'local',
            failureCode: 'connection-failed',
        });
    });

    it('preserves access-ended classification when a sole manual channel returns sealed revocation', async () => {
        const singleChannelCreds = {
            ...credentials,
            peer: { ...credentials.peer, channels: [channels[0]] },
        };
        initializeCodelyncConnection(singleChannelCreds);

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 403,
            json: async () => ({ error: 'device-revoked' }),
        })));

        await expect(selectConnection('local')).rejects.toThrow();
        expect(getConnectionSnapshot()).toMatchObject({
            automatic: false,
            selectedId: 'local',
            failureCode: 'access-ended',
        });
    });
});

describe('Track C Batch 2: R018 O(1) LRU cache & removeMachineEncryption cleanup', () => {
    it('maintains true LRU insertion-order eviction even within identical millisecond timestamps', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        const cache = new EncryptionCache();

        for (let i = 0; i < 1000; i++) {
            cache.setCachedMessage(`msg-${i}`, { id: `msg-${i}`, seq: i } as any);
        }
        expect(cache.getStats().messages).toBe(1000);

        // Promote msg-0 via get and msg-1 via overwrite set inside the exact same millisecond.
        expect(cache.getCachedMessage('msg-0')).toMatchObject({ id: 'msg-0' });
        cache.setCachedMessage('msg-1', { id: 'msg-1', seq: 9999 } as any);

        // Insert 2 new entries to trigger 2 evictions: oldest unused msg-2 and msg-3 must be evicted.
        cache.setCachedMessage('msg-1000', { id: 'msg-1000', seq: 1000 } as any);
        cache.setCachedMessage('msg-1001', { id: 'msg-1001', seq: 1001 } as any);

        expect(cache.getStats().messages).toBe(1000);
        expect(cache.getCachedMessage('msg-0')).toMatchObject({ id: 'msg-0' });
        expect(cache.getCachedMessage('msg-1')).toMatchObject({ id: 'msg-1', seq: 9999 });
        expect(cache.getCachedMessage('msg-2')).toBeNull();
        expect(cache.getCachedMessage('msg-3')).toBeNull();
        expect(cache.getCachedMessage('msg-1000')).toMatchObject({ id: 'msg-1000' });
    });

    it('distinguishes cached null daemon state from cache miss and enforces capacity', () => {
        const cache = new EncryptionCache();
        expect(cache.getCachedDaemonState('m-1', 1)).toBeUndefined();

        cache.setCachedDaemonState('m-1', 1, null);
        expect(cache.getCachedDaemonState('m-1', 1)).toBeNull();

        for (let v = 0; v < 500; v++) {
            cache.setCachedDaemonState('m-2', v, { ok: v });
        }
        // Accessing m-1:1 earlier keeps capacity bounded at maxDaemonStates=500; oldest entry is evicted.
        expect(cache.getStats().daemonStates).toBe(500);
        expect(cache.getCachedDaemonState('m-1', 1)).toBeUndefined();
    });

    it('clears machineMetadataCache and daemonStateCache when removeMachineEncryption runs without disturbing other machines', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(5));
        await encryption.initializeMachines(new Map([
            ['machine-1', new Uint8Array(32).fill(1)],
            ['machine-1:extra', new Uint8Array(32).fill(2)],
            ['machine-2', new Uint8Array(32).fill(3)],
        ]));

        const m1 = encryption.getMachineEncryption('machine-1')!;
        const m1Extra = encryption.getMachineEncryption('machine-1:extra')!;
        const m2 = encryption.getMachineEncryption('machine-2')!;
        const meta1 = { host: 'one', platform: 'darwin', happyCliVersion: '1.0.0', happyHomeDir: '/tmp/.happy', homeDir: '/tmp' };
        const meta2 = { host: 'two', platform: 'darwin', happyCliVersion: '1.0.0', happyHomeDir: '/tmp/.happy', homeDir: '/tmp' };
        const payload1 = Buffer.from(JSON.stringify(meta1), 'utf8').toString('base64');
        const payload2 = Buffer.from(JSON.stringify(meta2), 'utf8').toString('base64');

        expect(await m1.decryptMetadata(1, payload1)).toEqual(meta1);
        expect(await m1.decryptDaemonState(1, payload1)).toEqual(meta1);
        expect(await m1Extra.decryptMetadata(1, payload2)).toEqual(meta2);
        expect(await m2.decryptMetadata(1, payload2)).toEqual(meta2);
        expect(await m2.decryptDaemonState(1, payload2)).toEqual(meta2);

        const internalCache: EncryptionCache = (encryption as any).cache;
        expect(internalCache.getStats()).toMatchObject({ machineMetadata: 3, daemonStates: 2 });

        encryption.removeMachineEncryption('machine-1');

        expect(encryption.getMachineEncryption('machine-1')).toBeNull();
        expect(internalCache.getCachedMachineMetadata('machine-1', 1)).toBeNull();
        expect(internalCache.getCachedDaemonState('machine-1', 1)).toBeUndefined();
        expect(internalCache.getCachedMachineMetadata('machine-1:extra', 1)).toEqual(meta2);
        expect(internalCache.getCachedMachineMetadata('machine-2', 1)).toEqual(meta2);
        expect(internalCache.getCachedDaemonState('machine-2', 1)).toEqual(meta2);
        expect(internalCache.getStats()).toMatchObject({ machineMetadata: 2, daemonStates: 1 });
    });
});
