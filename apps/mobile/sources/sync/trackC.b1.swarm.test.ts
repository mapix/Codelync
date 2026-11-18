import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@/encryption/base64';

const hoisted = vi.hoisted(() => ({
    sockets: [] as any[],
    nonce: 0,
    credentials: { token: 'fixture-token' } as any,
    distribution: { noninvasiveLocal: true },
    mmkvStores: new Map<string, Map<string, string>>(),
    mmkvGetCount: new Map<string, number>(),
    mmkvSetCount: new Map<string, number>(),
    decryptSpy: vi.fn(),
    encryptSpy: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: vi.fn((_url, options) => {
        const socket: any = {
            connected: true,
            on: vi.fn(),
            onAny: vi.fn(),
            disconnect: vi.fn(),
            emit: vi.fn(),
            timeout: vi.fn(),
            emitWithAck: vi.fn().mockResolvedValue({ ok: true, result: 'reply' }),
        };
        socket.options = options;
        socket.io = { opts: options, on: vi.fn() };
        socket.timeout.mockReturnValue(socket);
        hoisted.sockets.push(socket);
        return socket;
    }),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('react-native-mmkv', () => ({
    MMKV: class MockMMKV {
        private store: Map<string, string>;
        constructor(opts?: { id?: string }) {
            const id = opts?.id ?? 'default';
            let map = hoisted.mmkvStores.get(id);
            if (!map) {
                map = new Map<string, string>();
                hoisted.mmkvStores.set(id, map);
            }
            this.store = map;
        }
        getString(key: string) {
            hoisted.mmkvGetCount.set(key, (hoisted.mmkvGetCount.get(key) ?? 0) + 1);
            return this.store.get(key);
        }
        set(key: string, value: string) {
            hoisted.mmkvSetCount.set(key, (hoisted.mmkvSetCount.get(key) ?? 0) + 1);
            this.store.set(key, value);
        }
        delete(key: string) {
            this.store.delete(key);
        }
    },
}));

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'fixture' } } }));

vi.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digestStringAsync: async (_algo: string, input: string) =>
        createHash('sha256').update(input).digest('hex'),
    getRandomBytes: (count: number) => new Uint8Array(count).fill(++hoisted.nonce),
}));

vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: { getCredentials: async () => hoisted.credentials },
}));

vi.mock('./encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ sessions: {} }) } }));
vi.mock('@/config', () => ({ config: hoisted.distribution }));

vi.mock('@/encryption/blob', () => ({
    encryptBlob: (plain: Uint8Array, key: Uint8Array) => {
        hoisted.encryptSpy();
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    },
    decryptBlob: (blob: Uint8Array, key: Uint8Array) => {
        hoisted.decryptSpy();
        const bytes = Buffer.from(blob);
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
    },
}));

import { apiSocket } from './apiSocket';
import {
    loadCodelyncPeerCatalog,
    loadCodelyncPeerCatalogState,
    saveCodelyncPeerCatalog,
} from './codelyncPeerCatalogCache';
import {
    clearCodelyncBackgroundCache,
    codelyncAccountScope,
    loadCodelyncBackgroundCache,
    rememberCodelyncSession,
    saveCodelyncBackgroundCache,
} from './codelyncBackgroundCache';

function makePeerPair() {
    const mac = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(7));
    const device = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(8));
    const endpoint = 'https://peer-trackc.example';
    const peer = {
        id: 'trackc-peer',
        key: encodeBase64(mac.publicKey, 'base64url'),
        channels: [{ id: 'cloudflare', kind: 'cloudflare' as const, url: endpoint }],
        device: {
            publicKey: encodeBase64(device.publicKey, 'base64url'),
            secretKey: encodeBase64(device.secretKey, 'base64url'),
        },
    };
    return { mac, device, endpoint, peer };
}

function boxPeerResponse(mac: nacl.BoxKeyPair, device: nacl.BoxKeyPair, peerId: string, payload: unknown) {
    const nonce = new Uint8Array(24).fill(9);
    const plain = new TextEncoder().encode(JSON.stringify({ peerId, payload }));
    const ciphertext = nacl.box(plain, nonce, device.publicKey, mac.secretKey);
    return {
        version: 2,
        nonce: encodeBase64(nonce, 'base64url'),
        ciphertext: encodeBase64(ciphertext, 'base64url'),
    };
}

describe('Track C Batch 1: R003 peerRequest zero double-serialization', () => {
    afterEach(() => {
        apiSocket.disconnect();
        hoisted.sockets.length = 0;
        hoisted.credentials = { token: 'fixture-token' };
        hoisted.distribution.noninvasiveLocal = true;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('returns decoded payload directly from .json() without intermediate JSON.stringify/JSON.parse', async () => {
        const { mac, device, endpoint, peer } = makePeerPair();
        const payload = { sessions: [{ id: 's1', title: 'Alpha' }], hasMore: false };
        const packet = boxPeerResponse(mac, device, peer.id, payload);

        apiSocket.initialize({ endpoint, token: 'fixture-token', peer }, {} as any);
        hoisted.credentials = { token: 'fixture-token', peer };

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => packet,
        })));

        const serializedPayload = JSON.stringify(payload);
        const stringifySpy = vi.spyOn(JSON, 'stringify');
        const parseSpy = vi.spyOn(JSON, 'parse');

        const response = await apiSocket.peerRequest('/api/peer/catalog');
        expect(stringifySpy.mock.calls.every(call => call[0] !== payload)).toBe(true);
        expect(parseSpy.mock.calls.every(call => call[0] !== serializedPayload)).toBe(true);

        stringifySpy.mockClear();
        parseSpy.mockClear();
        const parsed = await response.json();

        expect(response.ok).toBe(true);
        expect(response.status).toBe(200);
        expect(response.bodyUsed).toBe(true);
        expect(parsed).toEqual(payload);
        expect(stringifySpy).not.toHaveBeenCalled();
        expect(parseSpy).not.toHaveBeenCalled();
        expect(apiSocket.peerHttpProof()).toMatchObject({ peerId: peer.id, endpoint });
    });

    it('preserves single-read body semantics, clone(), text(), arrayBuffer(), and non-ok passthrough', async () => {
        const { mac, device, endpoint, peer } = makePeerPair();
        const payload = { ok: true, count: 42 };
        const packet = boxPeerResponse(mac, device, peer.id, payload);

        apiSocket.initialize({ endpoint, token: 'fixture-token', peer }, {} as any);
        hoisted.credentials = { token: 'fixture-token', peer };

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 201,
            statusText: 'Created',
            json: async () => packet,
        })));

        const response = await apiSocket.peerRequest('/api/peer/sessions/s1/recent');
        const cloned = response.clone();
        const secondClone = response.clone();

        expect(await response.json()).toEqual(payload);
        expect(() => response.clone()).toThrow('Body already used');
        await expect(response.json()).rejects.toThrow('Body already used');

        expect(await cloned.text()).toBe(JSON.stringify(payload));
        const buf = await secondClone.arrayBuffer();
        expect(new TextDecoder().decode(buf)).toBe(JSON.stringify(payload));
    });

    it('passes non-ok responses through without decoding and fences connection switch during read', async () => {
        const { mac, device, endpoint, peer } = makePeerPair();
        const packet = boxPeerResponse(mac, device, peer.id, { late: true });

        apiSocket.initialize({ endpoint, token: 'fixture-token', peer }, {} as any);
        hoisted.credentials = { token: 'fixture-token', peer };

        const proofBefore = apiSocket.peerHttpProof()?.observedAt ?? null;
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            status: 409,
            statusText: 'Conflict',
            json: async () => ({ error: 'stale-watermark' }),
        })));
        const errResponse = await apiSocket.peerRequest('/api/peer/catalog');
        expect(errResponse.ok).toBe(false);
        expect(errResponse.status).toBe(409);
        expect(apiSocket.peerHttpProof()?.observedAt ?? null).toBe(proofBefore);

        let resolveJson!: (v: unknown) => void;
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: () => new Promise(resolve => { resolveJson = resolve; }),
        })));
        const pending = apiSocket.peerRequest('/api/peer/catalog');
        await vi.waitFor(() => expect(resolveJson).toBeTypeOf('function'));
        apiSocket.initialize({ endpoint: 'https://other.example', token: 'fixture-token', peer: { ...peer, id: 'other-peer' } }, {} as any);
        resolveJson(packet);
        await expect(pending).rejects.toThrow();
    });
});

describe('Track C Batch 1: R008 catalog memoization & lightweight selected index', () => {
    const credentials: any = {
        token: 'tok-r008',
        secret: Buffer.alloc(32, 11).toString('base64url'),
        peer: {
            id: 'peer-r008',
            key: Buffer.alloc(32, 12).toString('base64url'),
            channels: [{ id: 'local', kind: 'local', url: 'http://127.0.0.1:8800' }],
            device: {
                publicKey: Buffer.alloc(32, 13).toString('base64url'),
                secretKey: Buffer.alloc(32, 14).toString('base64url'),
            },
        },
    };
    const descriptor: any = {
        id: 'sess-r008',
        nativeUpdatedAt: 1000,
        createdAt: 10,
        activeAt: 1000,
        active: true,
        metadataVersion: 1,
        agentStateVersion: 1,
        seq: 5,
        agentState: { running: true },
        metadata: { title: 'Catalog perf round' },
    };

    beforeEach(() => {
        clearCodelyncBackgroundCache();
        hoisted.mmkvGetCount.clear();
        hoisted.mmkvSetCount.clear();
        hoisted.decryptSpy.mockClear();
        hoisted.encryptSpy.mockClear();
    });

    it('reuses decrypted peer catalog across repeated startup/fetch loads and after save', async () => {
        await saveCodelyncPeerCatalog(credentials, [descriptor], () => true, 'wm-r008');
        expect(hoisted.encryptSpy).toHaveBeenCalledTimes(1);
        expect(hoisted.decryptSpy).not.toHaveBeenCalled();

        // Warm memo hit after save: both startup catalog load and fetchPeerCatalog state load skip decryptBlob.
        const first = await loadCodelyncPeerCatalog(credentials);
        const second = await loadCodelyncPeerCatalogState(credentials);
        expect(hoisted.decryptSpy).not.toHaveBeenCalled();
        expect(first).toEqual([{ ...descriptor, active: false, basicOnly: true, agentState: null }]);
        expect(second.watermark).toBe('wm-r008');

        // Mutating the returned array must not mutate the memoized array length.
        first.pop();
        const third = await loadCodelyncPeerCatalogState(credentials);
        expect(third.sessions).toHaveLength(1);
    });

    it('decrypts once on cold MMKV ciphertext load, memoizes subsequent reads, and isolates secret/peer changes', async () => {
        await saveCodelyncPeerCatalog(credentials, [descriptor], () => true, 'wm-cold');
        const scope = await codelyncAccountScope(credentials);
        const savedSnapshot = loadCodelyncBackgroundCache(scope);

        // Clear cache & observe empty catalog so module memo is dropped before restoring disk ciphertext.
        clearCodelyncBackgroundCache();
        expect(await loadCodelyncPeerCatalog(credentials)).toEqual([]);
        saveCodelyncBackgroundCache(savedSnapshot);
        hoisted.decryptSpy.mockClear();

        const cold1 = await loadCodelyncPeerCatalog(credentials);
        const cold2 = await loadCodelyncPeerCatalogState(credentials);
        expect(cold1).toHaveLength(1);
        expect(cold2.watermark).toBe('wm-cold');
        expect(hoisted.decryptSpy).toHaveBeenCalledTimes(1);

        // Wrong secret or wrong peer must not read the memoized catalog.
        expect(await loadCodelyncPeerCatalog({ ...credentials, secret: Buffer.alloc(32, 99).toString('base64url') })).toEqual([]);
        expect(await loadCodelyncPeerCatalog({ ...credentials, peer: { ...credentials.peer, id: 'other-peer' } })).toEqual([]);
    });

    it('updates selected session index without re-reading or rewriting the large snapshot key', async () => {
        const scope = await codelyncAccountScope(credentials);
        saveCodelyncBackgroundCache({
            scope,
            updatedAt: 100,
            sessions: [],
            selected: ['s-old'],
            messages: { 's-old': { seq: 1, records: [] } },
            peerCatalogCiphertext: 'ciphertext-blob',
        });
        hoisted.mmkvGetCount.clear();
        hoisted.mmkvSetCount.clear();

        // First selection initializes SELECTED_KEY (falls back once to in-memory memo for 'snapshot'),
        // then writes only SELECTED_KEY.
        await rememberCodelyncSession(credentials, 's-one');
        await rememberCodelyncSession(credentials, 's-two');
        // No-op repeat for current head skips even SELECTED_KEY write.
        await rememberCodelyncSession(credentials, 's-two');

        expect(hoisted.mmkvSetCount.get('snapshot') ?? 0).toBe(0);
        expect(hoisted.mmkvSetCount.get('selected')).toBe(2);
        // Once SELECTED_KEY is written, rememberCodelyncSession does not touch 'snapshot' at all.
        expect(hoisted.mmkvGetCount.get('snapshot') ?? 0).toBe(1);

        const loaded = loadCodelyncBackgroundCache(scope);
        expect(loaded.selected).toEqual(['s-two', 's-one', 's-old']);

        // Background save preserves newer selected order and keeps memoText warm.
        saveCodelyncBackgroundCache({
            scope,
            updatedAt: 200,
            sessions: [],
            selected: ['s-stale'],
            messages: {},
            peerCatalogCiphertext: 'ciphertext-blob-2',
        });
        expect(loadCodelyncBackgroundCache(scope).selected).toEqual(['s-two', 's-one', 's-old']);

        clearCodelyncBackgroundCache();
        expect(loadCodelyncBackgroundCache(scope).selected).toEqual([]);
    });
});
