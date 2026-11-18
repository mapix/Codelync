import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { vi.stubGlobal('__DEV__', false); });

const mocks = vi.hoisted(() => ({
    peerRequest: vi.fn(),
    delay: vi.fn(async () => {}),
    loadCatalogState: vi.fn(async () => ({ sessions: [], watermark: null })),
    saveCatalog: vi.fn(async () => {}),
}));

vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('expo-device', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
vi.mock('expo-notifications', () => ({}));
vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/utils/time', () => ({ delay: mocks.delay }));
vi.mock('@/sync/apiSocket', () => ({
    apiSocket: { request: vi.fn(), peerRequest: mocks.peerRequest, emitWithAck: vi.fn() },
    getCurrentAppState: () => 'active',
    getCodelyncClientId: () => 'test-client',
}));
vi.mock('@/sync/webTabTitle', () => ({ notifyUnreadMessage: vi.fn() }));
vi.mock('@/sync/encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('@/sync/encryption/artifactEncryption', () => ({ ArtifactEncryption: class {} }));
vi.mock('@/sync/encryption/encryptionCache', () => ({ EncryptionCache: class {} }));
vi.mock('./persistence', () => ({
    loadSettings: () => ({}),
    loadLocalSettings: () => ({}),
    saveLocalSettings: vi.fn(),
    saveSettings: vi.fn(),
    loadPurchases: () => null,
    savePurchases: vi.fn(),
    loadProfile: () => null,
    saveProfile: vi.fn(),
    loadSessionDrafts: () => ({}),
    saveSessionDrafts: vi.fn(),
    loadRigComposerDraft: () => null,
    saveRigComposerDraft: vi.fn(),
    loadSessionLastMessageSentAt: () => ({}),
    saveSessionLastMessageSentAt: vi.fn(),
    loadPendingSettings: () => ({}),
    savePendingSettings: vi.fn(),
}));
vi.mock('@/realtime/RealtimeSession', () => ({
    getCurrentRealtimeSessionId: () => null,
    getVoiceSession: () => null,
}));
vi.mock('@/components/tools/knownTools', () => ({ isMutableTool: () => true }));
vi.mock('@/sync/ops', () => ({ sessionSetAgentModes: vi.fn() }));
vi.mock('@/sync/revenueCat', () => ({ RevenueCat: {}, LogLevel: {}, PaywallResult: {} }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://example.invalid' }));
vi.mock('@/sync/pushRegistration', () => ({ syncCurrentPushToken: vi.fn() }));
vi.mock('@/sync/apiArtifacts', () => ({
    fetchArtifact: vi.fn(),
    fetchArtifacts: vi.fn(),
    createArtifact: vi.fn(),
    updateArtifact: vi.fn(),
}));
vi.mock('@/sync/apiFriends', () => ({ getFriendsList: vi.fn(), getUserProfile: vi.fn() }));
vi.mock('@/sync/apiFeed', () => ({ fetchFeed: vi.fn() }));
vi.mock('@/sync/apiAttachments', () => ({ requestAttachmentUpload: vi.fn(), uploadEncryptedBlob: vi.fn() }));
vi.mock('@/sync/apiProjects', () => ({ fetchProjects: vi.fn() }));
vi.mock('@/sync/projects', () => ({ decryptProjectRecord: vi.fn(), loadProjectAvatar: vi.fn() }));
vi.mock('@/sync/sessionAvatars', () => ({ loadSessionAvatar: vi.fn(async () => null) }));
vi.mock('@/sync/typesRaw', () => ({
    normalizeRawMessage: (_id: string, _localId: string, _time: number, content: unknown) => content,
}));
vi.mock('@/sync/codelyncBackgroundTask', () => ({ registerCodelyncBackgroundTask: vi.fn() }));
vi.mock('@/sync/codelyncNotifications', () => ({
    startCodelyncPresence: vi.fn(),
    renewCodelyncPresence: vi.fn(),
}));
vi.mock('@/sync/codelyncBackgroundCache', () => ({
    rememberCodelyncSession: vi.fn(),
    codelyncAccountScope: async () => 'fixture',
    loadCodelyncBackgroundCache: () => ({ sessions: [], messages: {} }),
    saveCodelyncBackgroundCache: vi.fn(),
}));
vi.mock('@/sync/codelyncSessionSelection', () => ({ selectCodelyncSession: vi.fn(async () => {}) }));
vi.mock('@/sync/codelyncSourceActivation', () => ({ activateCodelyncSource: vi.fn(async () => {}) }));
vi.mock('@/sync/codelyncPeerCatalogCache', () => ({
    loadCodelyncPeerCatalog: vi.fn(async () => []),
    loadCodelyncPeerCatalogState: mocks.loadCatalogState,
    saveCodelyncPeerCatalog: mocks.saveCatalog,
}));
vi.mock('@/config', () => ({ config: { noninvasiveLocal: false } }));
vi.mock('@/log', () => ({ log: { log: vi.fn() } }));
vi.mock('@/track', () => ({ tracking: null }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/encryption/blob', () => ({}));
vi.mock('@/utils/readFileBytes', () => ({}));
vi.mock('@/sync/gitStatusSync', () => ({
    gitStatusSync: { getSync: () => ({ invalidate: vi.fn() }), clearForSession: vi.fn() },
}));
vi.mock('@/realtime/hooks/voiceHooks', () => ({
    voiceHooks: { onSessionFocus: vi.fn(), onMessages: vi.fn(), onReady: vi.fn() },
}));

import {
    NATIVE_CATALOG_APPLY_CHUNK_SIZE,
    chunkCatalogDescriptors,
} from './codelyncPeerCatalogDelta';
import type { PeerSessionDescriptor } from './codelyncRecent';
import { codelyncLoadingProgress } from './codelyncLoadingProgress';
import { storage } from './storage';
import { sync } from './sync';

function descriptor(index: number): PeerSessionDescriptor {
    const id = `session-${index}`;
    return {
        id,
        nativeUpdatedAt: 1000 + index,
        basicOnly: false,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        seq: 1,
        createdAt: 100,
        active: false,
        activeAt: 1000 + index,
        metadata: {
            path: `/tmp/project-${index}`,
            host: 'mac-mini',
            machineId: 'machine-1',
            client: { id: 'noninvasive-bridge', name: 'Codex' },
            bridge: {
                protocol: 'codex-ipc',
                controlMode: 'session',
                source: {
                    app: 'codex',
                    kind: 'session',
                    id: `native-${index}`,
                    hostId: 'host-1',
                    runtimeGeneration: 'gen-1',
                },
            },
            nativeSession: {
                title: `Session ${index}`,
                updatedAt: 1000 + index,
                catalogueAvailable: true,
            },
        } as any,
    };
}

describe('Track C Batch 4 — R038 catalog chunking and idempotent applyReady', () => {
    const engine = sync as any;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.delay.mockResolvedValue(undefined);
        mocks.loadCatalogState.mockResolvedValue({ sessions: [], watermark: null });
        engine.credentials = { token: 't', secret: 's' };
        storage.setState((state) => ({
            ...state,
            sessions: {},
            sessionsData: null,
            sessionListViewData: null,
            isDataReady: false,
        }));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('splits catalog descriptors into deterministic 250-row bounded chunks', () => {
        expect(NATIVE_CATALOG_APPLY_CHUNK_SIZE).toBe(250);
        expect(chunkCatalogDescriptors([])).toEqual([]);
        expect(chunkCatalogDescriptors([1]).map((c) => c.length)).toEqual([1]);
        expect(chunkCatalogDescriptors(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length)).toEqual([250]);
        expect(chunkCatalogDescriptors(Array.from({ length: 1000 }, (_, i) => i)).map((c) => c.length)).toEqual([
            250, 250, 250, 250,
        ]);
        expect(chunkCatalogDescriptors([1, 2, 3], 0).map((c) => c.length)).toEqual([1, 1, 1]);
    });

    it('makes storage.applyReady() idempotent once isDataReady is true', () => {
        let notifications = 0;
        const unsubscribe = storage.subscribe(() => {
            notifications += 1;
        });

        expect(storage.getState().isDataReady).toBe(false);
        storage.getState().applyReady();
        expect(storage.getState().isDataReady).toBe(true);
        expect(notifications).toBe(1);

        const readySnapshot = storage.getState();
        storage.getState().applyReady();
        storage.getState().applyReady();
        storage.getState().applyReady();
        expect(storage.getState()).toBe(readySnapshot);
        expect(notifications).toBe(1);

        unsubscribe();
    });

    it('applies a 200-row initial catalog page in 1 chunk with zero inter-chunk yields and a 1000-row page in 4 chunks with 3 yields', async () => {
        const applySessionsSpy = vi.spyOn(engine, 'applySessions');

        const smallRows = Array.from({ length: 200 }, (_, i) => descriptor(i));
        mocks.peerRequest.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                version: 2,
                mode: 'full',
                watermark: 'wm-small',
                baseWatermark: null,
                machineIds: ['machine-1'],
                sessions: smallRows,
                removedIds: [],
                hasMore: false,
                nextCursor: null,
            }),
        });

        await engine.fetchPeerCatalog();
        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0][0]).toHaveLength(200);
        expect(mocks.delay).toHaveBeenCalledTimes(0);

        applySessionsSpy.mockClear();
        mocks.delay.mockClear();
        storage.setState((state) => ({ ...state, sessions: {}, isDataReady: false }));

        const largeRows = Array.from({ length: 1000 }, (_, i) => descriptor(i + 1000));
        mocks.peerRequest.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                version: 2,
                mode: 'full',
                watermark: 'wm-large',
                baseWatermark: null,
                machineIds: ['machine-1'],
                sessions: largeRows,
                removedIds: [],
                hasMore: false,
                nextCursor: null,
            }),
        });

        let readyFlips = 0;
        let prevReady = storage.getState().isDataReady;
        const unsub = storage.subscribe((next) => {
            if (next.isDataReady !== prevReady) {
                readyFlips += 1;
                prevReady = next.isDataReady;
            }
        });

        await engine.fetchPeerCatalog();
        unsub();

        expect(applySessionsSpy).toHaveBeenCalledTimes(4);
        expect(applySessionsSpy.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([250, 250, 250, 250]);
        expect(mocks.delay).toHaveBeenCalledTimes(3);
        expect(readyFlips).toBe(1);
        expect(Object.keys(storage.getState().sessions)).toHaveLength(1000);
    });

    it('aborts remaining catalog chunks when discovery generation changes during an inter-chunk yield', async () => {
        const applySessionsSpy = vi.spyOn(engine, 'applySessions');
        const rows = Array.from({ length: 500 }, (_, i) => descriptor(i));

        mocks.peerRequest.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                version: 2,
                mode: 'full',
                watermark: 'wm-abort',
                baseWatermark: null,
                machineIds: ['machine-1'],
                sessions: rows,
                removedIds: [],
                hasMore: false,
                nextCursor: null,
            }),
        });

        mocks.delay.mockImplementationOnce(async () => {
            codelyncLoadingProgress.beginDiscovery();
        });

        await engine.fetchPeerCatalog();

        expect(applySessionsSpy).toHaveBeenCalledTimes(1);
        expect(applySessionsSpy.mock.calls[0][0]).toHaveLength(250);
        expect(Object.keys(storage.getState().sessions)).toHaveLength(250);
    });
});
