import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { vi.stubGlobal('__DEV__', false); });

const mocks = vi.hoisted(() => ({
    state: { sessions: {}, sessionMessages: {}, currentViewingSessionId: null } as any,
    request: vi.fn(),
    peerRequest: vi.fn(),
    activate: vi.fn(async () => {}),
    select: vi.fn(async () => {}),
    applyMessages: vi.fn(),
    applyMessagesLoaded: vi.fn(),
    applyOlderMessagesPagination: vi.fn(),
    gitInvalidate: vi.fn(),
    gitClear: vi.fn(),
    config: { noninvasiveLocal: false },
}));

vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('expo-device', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-1' }));
vi.mock('expo-notifications', () => ({}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: vi.fn() } }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { request: mocks.request, peerRequest: mocks.peerRequest }, getCurrentAppState: () => 'active', getCodelyncClientId: () => 'test' }));
vi.mock('@/sync/webTabTitle', () => ({ notifyUnreadMessage: vi.fn() }));
vi.mock('@/sync/encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('@/sync/encryption/artifactEncryption', () => ({ ArtifactEncryption: class {} }));
vi.mock('@/sync/encryption/encryptionCache', () => ({ EncryptionCache: class {} }));
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            ...mocks.state,
            applyReady: vi.fn(),
            applyMachines: vi.fn(),
            getActiveSessions: () => [],
            applySessions: vi.fn(),
            applyMessages: mocks.applyMessages,
            applyMessagesLoaded: mocks.applyMessagesLoaded,
            applyOlderMessagesPagination: mocks.applyOlderMessagesPagination,
            applyOlderMessagesLoading: vi.fn(),
            deleteSession: (id: string) => {
                delete mocks.state.sessions[id];
                delete mocks.state.sessionMessages[id];
            },
        }),
    },
}));
vi.mock('@/sync/ops', () => ({ sessionSetAgentModes: vi.fn() }));
vi.mock('@/sync/persistence', () => ({ loadPendingSettings: () => ({}), savePendingSettings: vi.fn() }));
vi.mock('@/sync/revenueCat', () => ({ RevenueCat: {}, LogLevel: {}, PaywallResult: {} }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://example.invalid' }));
vi.mock('@/sync/pushRegistration', () => ({ syncCurrentPushToken: vi.fn() }));
vi.mock('@/sync/apiArtifacts', () => ({ fetchArtifact: vi.fn(), fetchArtifacts: vi.fn(), createArtifact: vi.fn(), updateArtifact: vi.fn() }));
vi.mock('@/sync/apiFriends', () => ({ getFriendsList: vi.fn(), getUserProfile: vi.fn() }));
vi.mock('@/sync/apiFeed', () => ({ fetchFeed: vi.fn() }));
vi.mock('@/sync/apiAttachments', () => ({ requestAttachmentUpload: vi.fn(), uploadEncryptedBlob: vi.fn() }));
vi.mock('@/sync/apiProjects', () => ({ fetchProjects: vi.fn() }));
vi.mock('@/sync/projects', () => ({ decryptProjectRecord: vi.fn(), loadProjectAvatar: vi.fn() }));
vi.mock('@/sync/sessionAvatars', () => ({ loadSessionAvatar: vi.fn(async () => null) }));
vi.mock('@/sync/typesRaw', () => ({ normalizeRawMessage: (_id: string, _localId: string, _time: number, content: unknown) => content }));
vi.mock('@/sync/codelyncBackgroundTask', () => ({ registerCodelyncBackgroundTask: vi.fn() }));
vi.mock('@/sync/codelyncNotifications', () => ({ startCodelyncPresence: vi.fn(), renewCodelyncPresence: vi.fn() }));
vi.mock('@/sync/codelyncBackgroundCache', () => ({ rememberCodelyncSession: vi.fn(), codelyncAccountScope: async () => 'fixture', loadCodelyncBackgroundCache: () => ({ sessions: [], messages: {} }), saveCodelyncBackgroundCache: vi.fn() }));
vi.mock('@/sync/codelyncSessionSelection', () => ({ selectCodelyncSession: mocks.select }));
vi.mock('@/sync/codelyncSourceActivation', () => ({ activateCodelyncSource: mocks.activate }));
vi.mock('@/sync/codelyncPeerCatalogCache', () => ({ loadCodelyncPeerCatalog: vi.fn(async () => []), loadCodelyncPeerCatalogState: vi.fn(async () => ({ sessions: [], watermark: null })), saveCodelyncPeerCatalog: vi.fn(async () => {}) }));
vi.mock('@/config', () => ({ config: mocks.config }));
vi.mock('@/log', () => ({ log: { log: vi.fn() } }));
vi.mock('@/track', () => ({ tracking: null }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/encryption/blob', () => ({}));
vi.mock('@/utils/readFileBytes', () => ({}));
vi.mock('@/sync/gitStatusSync', () => ({ gitStatusSync: { getSync: () => ({ invalidate: mocks.gitInvalidate }), clearForSession: mocks.gitClear } }));
vi.mock('@/realtime/hooks/voiceHooks', () => ({ voiceHooks: { onSessionFocus: vi.fn(), onMessages: vi.fn(), onReady: vi.fn() } }));

import { encodeBase64 } from '@/encryption/base64';
import {
    CodelyncPairingController,
    CodelyncPairingError,
    parseCodelyncPairingCode,
    validateCodelyncPairingCredentials,
} from '@/auth/codelyncPairing';
import { isCodelyncPairingRouteComplete } from '@/auth/codelyncPairingRoute';
import { codelyncLoadingProgress } from './codelyncLoadingProgress';
import { sync } from './sync';

describe('Track C Batch 8: R073 delete-session cache & flight eviction', () => {
    let engine: any;

    beforeEach(() => {
        vi.resetAllMocks();
        mocks.state = {
            sessions: { doomed: { id: 'doomed' }, survivor: { id: 'survivor' } },
            sessionMessages: { doomed: { messages: [] }, survivor: { messages: [] } },
            currentViewingSessionId: null,
        };
        engine = new (sync.constructor as new () => typeof sync)();
        engine.encryption = { removeSessionEncryption: vi.fn() };
        engine.projectsSync = { invalidate: vi.fn() };
    });

    afterEach(() => {
        engine?.sessionAvatars.clear();
        codelyncLoadingProgress.clearSession('doomed');
        codelyncLoadingProgress.clearSession('survivor');
    });

    it('evicts all Codelync per-session caches, cursors, flights, progress, and aborts active send on delete-session while keeping sibling sessions intact', async () => {
        const doomedAbort = new AbortController();
        const survivorAbort = new AbortController();
        const creds = { token: 't', secret: 's' };

        engine.sendAbortControllers.set('doomed', doomedAbort);
        engine.sendAbortControllers.set('survivor', survivorAbort);
        engine.codelyncActivity.set('doomed', { seq: 10, updatedAt: 100 });
        engine.codelyncActivity.set('survivor', { seq: 11, updatedAt: 101 });
        engine.codelyncCachedMessages.add('doomed');
        engine.codelyncCachedMessages.add('survivor');
        engine.codelyncEntryFlights.set('doomed', { credentials: creds, selected: true, promise: Promise.resolve() });
        engine.codelyncEntryFlights.set('survivor', { credentials: creds, selected: true, promise: Promise.resolve() });
        engine.codelyncPeerReadFlights.set('doomed', { credentials: creds, promise: Promise.resolve() });
        engine.codelyncPeerReadFlights.set('survivor', { credentials: creds, promise: Promise.resolve() });
        engine.codelyncPeerRevalidations.set('doomed', { credentials: creds, promise: Promise.resolve() });
        engine.codelyncPeerRevalidations.set('survivor', { credentials: creds, promise: Promise.resolve() });
        engine.codelyncPeerLiveMetadata.set('doomed', { credentials: creds, signature: 'sig-d', version: 1 });
        engine.codelyncPeerLiveMetadata.set('survivor', { credentials: creds, signature: 'sig-s', version: 1 });
        engine.codelyncHistoryCursors.set('doomed', 'cur-d');
        engine.codelyncHistoryCursors.set('survivor', 'cur-s');
        engine.codelyncHistoryOwners.set('doomed', 'own-d');
        engine.codelyncHistoryOwners.set('survivor', 'own-s');
        engine.olderMessagesPrefetching.add('doomed');
        engine.olderMessagesPrefetching.add('survivor');

        const genDoomed = codelyncLoadingProgress.beginSession('doomed');
        codelyncLoadingProgress.endSession('doomed', genDoomed, true);
        const genSurvivor = codelyncLoadingProgress.beginSession('survivor');
        codelyncLoadingProgress.endSession('survivor', genSurvivor);

        await engine.handleUpdate({ id: 'del-1', seq: 20, createdAt: 200, body: { t: 'delete-session', sid: 'doomed' } });

        expect(doomedAbort.signal.aborted).toBe(true);
        expect(survivorAbort.signal.aborted).toBe(false);
        expect(engine.sendAbortControllers.has('doomed')).toBe(false);
        expect(engine.codelyncActivity.has('doomed')).toBe(false);
        expect(engine.codelyncCachedMessages.has('doomed')).toBe(false);
        expect(engine.codelyncEntryFlights.has('doomed')).toBe(false);
        expect(engine.codelyncPeerReadFlights.has('doomed')).toBe(false);
        expect(engine.codelyncPeerRevalidations.has('doomed')).toBe(false);
        expect(engine.codelyncPeerLiveMetadata.has('doomed')).toBe(false);
        expect(engine.codelyncHistoryCursors.has('doomed')).toBe(false);
        expect(engine.codelyncHistoryOwners.has('doomed')).toBe(false);
        expect(engine.olderMessagesPrefetching.has('doomed')).toBe(false);
        expect(codelyncLoadingProgress.getSession('doomed')).toEqual({ generation: 0, phase: 'idle', found: 0, pages: 0 });
        expect(mocks.gitClear).toHaveBeenCalledWith('doomed');

        // Sibling session state stays completely untouched.
        expect(engine.sendAbortControllers.has('survivor')).toBe(true);
        expect(engine.codelyncActivity.get('survivor')).toEqual({ seq: 11, updatedAt: 101 });
        expect(engine.codelyncCachedMessages.has('survivor')).toBe(true);
        expect(engine.codelyncEntryFlights.has('survivor')).toBe(true);
        expect(engine.codelyncPeerReadFlights.has('survivor')).toBe(true);
        expect(engine.codelyncPeerRevalidations.has('survivor')).toBe(true);
        expect(engine.codelyncPeerLiveMetadata.get('survivor')?.signature).toBe('sig-s');
        expect(engine.codelyncHistoryCursors.get('survivor')).toBe('cur-s');
        expect(engine.codelyncHistoryOwners.get('survivor')).toBe('own-s');
        expect(engine.olderMessagesPrefetching.has('survivor')).toBe(true);
        expect(codelyncLoadingProgress.getSession('survivor').phase).toBe('complete');
    });
});

describe('Track C Batch 8: R078 pairing URL/origin normalization & flight cleanup', () => {
    const macKey = 'a'.repeat(43);
    const invite = 'b'.repeat(43);
    const secret = 'c'.repeat(43);
    const peerId = 'd'.repeat(64);
    const channels = [
        { id: 'local', kind: 'local' as const, url: 'http://[::1]:57070' },
        { id: 'relay', kind: 'relay' as const, url: 'https://relay.example' },
    ];

    function makeV2Qr(order: Array<[string, string]>): string {
        const u = new URL('codelync://pair');
        for (const [k, v] of order) u.searchParams.set(k, v);
        return u.toString();
    }

    it('accepts IPv6 loopback [::1] and trims outer whitespace while rejecting port/userinfo on codelync://pair', () => {
        const encodedChannels = encodeBase64(new TextEncoder().encode(JSON.stringify(channels)), 'base64url');
        const qr = makeV2Qr([
            ['v', '2'],
            ['origin', 'http://[::1]:57070/'],
            ['key', macKey],
            ['invite', invite],
            ['expires', String(Date.now() + 60_000)],
            ['channels', encodedChannels],
        ]);
        const parsed = parseCodelyncPairingCode(`  ${qr}  `);
        expect(parsed.origin).toBe('http://[::1]:57070');
        expect(parsed.url).toBe(qr);

        expect(() => parseCodelyncPairingCode(qr.replace('codelync://pair', 'codelync://pair:8080'))).toThrow(CodelyncPairingError);
        expect(() => parseCodelyncPairingCode(qr.replace('codelync://pair', 'codelync://user@pair'))).toThrow(CodelyncPairingError);
    });

    it('normalizes origin & serverUrl during credential validation and wraps malformed peer channels as identity errors', () => {
        const encodedChannels = encodeBase64(new TextEncoder().encode(JSON.stringify(channels)), 'base64url');
        const qr = makeV2Qr([
            ['v', '2'],
            ['origin', 'https://relay.example'],
            ['key', macKey],
            ['invite', invite],
            ['expires', String(Date.now() + 60_000)],
            ['channels', encodedChannels],
        ]);
        const code = parseCodelyncPairingCode(qr);

        const accepted = validateCodelyncPairingCredentials({
            version: 2,
            origin: 'https://RELAY.example/',
            macKey: macKey,
            credentials: { token: 'tok', secret, serverUrl: 'https://relay.example/' },
            peer: {
                id: peerId,
                key: macKey,
                channels: [{ id: 'relay', kind: 'relay', url: 'https://RELAY.example/' }],
            },
        }, code);
        expect(accepted.serverUrl).toBe('https://relay.example');

        expect(() => validateCodelyncPairingCredentials({
            version: 2,
            origin: 'https://relay.example',
            macKey: macKey,
            credentials: { token: 'tok', secret, serverUrl: 'https://relay.example' },
            peer: { id: peerId, key: macKey, channels: [] },
        }, code)).toThrowError(expect.objectContaining({ code: 'identity' }));
    });

    it('coalesces equivalent QR parameter orders, reuses pending device key, and clears only matching flight on settlement', async () => {
        const encodedChannels = encodeBase64(new TextEncoder().encode(JSON.stringify(channels)), 'base64url');
        const expires = String(Date.now() + 60_000);
        const qrA = makeV2Qr([
            ['v', '2'],
            ['origin', channels[1].url],
            ['key', macKey],
            ['invite', invite],
            ['expires', expires],
            ['channels', encodedChannels],
        ]);
        const qrB = makeV2Qr([
            ['channels', encodedChannels],
            ['expires', expires],
            ['invite', invite],
            ['key', macKey],
            ['origin', channels[1].url],
            ['v', '2'],
        ]);

        let generateCount = 0;
        let exchangeCount = 0;
        let pending: { url: string; device: { publicKey: string; secretKey: string } } | null = {
            url: qrA,
            device: { publicKey: 'dev-pub', secretKey: 'dev-sec' },
        };
        const controller = new CodelyncPairingController({
            load: async () => pending,
            save: async (next) => { pending = next; },
            clear: async () => { pending = null; },
            generateKey: () => { generateCount += 1; return { publicKey: 'new-pub', secretKey: 'new-sec' }; },
            encrypt: () => ({ publicKey: 'dev-pub', nonce: 'n', ciphertext: 'c' }),
            exchange: async () => {
                exchangeCount += 1;
                await new Promise((resolve) => setTimeout(resolve, 15));
                return {};
            },
            decrypt: () => ({
                version: 2,
                origin: channels[1].url,
                macKey: macKey,
                credentials: { token: 'tok', secret, serverUrl: channels[1].url },
                peer: { id: peerId, key: macKey, channels },
            }),
            currentOrigin: () => channels[1].url,
            selectOrigin: vi.fn(),
            credentials: () => null,
            saveCredentials: vi.fn(async () => {}),
            login: vi.fn(async () => {}),
            reload: vi.fn(async () => {}),
            validatePeer: async () => true,
        });

        await Promise.all([controller.connect(`  ${qrA}`), controller.connect(qrB)]);
        expect(generateCount).toBe(0);
        // 2 channels raced in Promise.any during the single coalesced connect flight.
        expect(exchangeCount).toBe(2);
        expect(pending).toBeNull();
    });

    it('recognizes completed passive v2 routes across normalized serverUrl and channel URLs', () => {
        const encodedChannels = encodeBase64(new TextEncoder().encode(JSON.stringify(channels)), 'base64url');
        const qr = makeV2Qr([
            ['v', '2'],
            ['origin', 'https://relay.example'],
            ['key', macKey],
            ['invite', invite],
            ['expires', '1000'],
            ['channels', encodedChannels],
        ]);
        const creds = {
            serverUrl: 'https://RELAY.example/',
            peer: {
                id: peerId,
                key: macKey,
                channels: [{ id: 'relay', kind: 'relay' as const, url: 'https://relay.example/' }],
                device: { publicKey: 'd', secretKey: 'e' },
                automatic: true,
            },
        };
        expect(isCodelyncPairingRouteComplete(qr, creds, 'connected', `peer:${peerId}`)).toBe(true);
        expect(isCodelyncPairingRouteComplete(qr, { ...creds, serverUrl: 'not a url' }, 'connected', `peer:${peerId}`)).toBe(false);
    });
});
