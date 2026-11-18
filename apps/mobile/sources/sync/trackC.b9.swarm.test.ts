import * as React from 'react';
// @ts-expect-error The native test renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    vi.stubGlobal('__DEV__', false);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

const mocks = vi.hoisted(() => ({
    state: { sessions: {}, sessionMessages: {}, currentViewingSessionId: null } as any,
    request: vi.fn(),
    peerRequest: vi.fn(),
    activate: vi.fn(async () => {}),
    select: vi.fn(async () => {}),
    applyMessages: vi.fn(),
    applyMessagesLoaded: vi.fn(),
    applyOlderMessagesPagination: vi.fn(),
    config: { noninvasiveLocal: false },
    peerIdentity: 'peer:mac-1' as string | null,
    statusListeners: new Set<(status: 'disconnected' | 'connecting' | 'connected' | 'error') => void>(),
    statusAddCount: 0,
    statusRemoveCount: 0,
}));

vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('expo-device', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-1' }));
vi.mock('expo-notifications', () => ({ addPushTokenListener: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: vi.fn() } }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/sync/apiSocket', () => ({
    apiSocket: {
        request: mocks.request,
        peerRequest: mocks.peerRequest,
        peerIdentity: () => mocks.peerIdentity,
        onStatusChange: (listener: (status: 'disconnected' | 'connecting' | 'connected' | 'error') => void) => {
            mocks.statusAddCount += 1;
            mocks.statusListeners.add(listener);
            listener('connected');
            return () => {
                mocks.statusRemoveCount += 1;
                mocks.statusListeners.delete(listener);
            };
        },
    },
    getCurrentAppState: () => 'active',
    getCodelyncClientId: () => 'test',
}));
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
            applySessions: (sessions: any[]) => {
                mocks.state.sessions = { ...mocks.state.sessions };
                for (const session of sessions) mocks.state.sessions[session.id] = session;
            },
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
vi.mock('@/sync/gitStatusSync', () => ({ gitStatusSync: { getSync: () => ({ invalidate: vi.fn() }), clearForSession: vi.fn() } }));
vi.mock('@/realtime/hooks/voiceHooks', () => ({ voiceHooks: { onSessionFocus: vi.fn(), onMessages: vi.fn(), onReady: vi.fn() } }));

import { useCodelyncSessionActivityForSource } from '@/hooks/useCodelyncSessionActivity';
import { codelyncActivitySourceScope, codelyncProjectActivityStore } from './codelyncProjectActivity';
import type { Session } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { AsyncLock } from '@/utils/lock';
import { sync } from './sync';

function makeNativeSession(id: string, nativeId = `native-${id}`, available = true): Session {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 100,
        active: true,
        activeAt: 100,
        thinking: false,
        thinkingAt: 0,
        metadataVersion: 1,
        agentStateVersion: 0,
        agentState: null,
        metadata: {
            path: '/fixture',
            host: 'mac',
            machineId: 'machine-1',
            client: { id: 'noninvasive-bridge' },
            nativeSession: { catalogueAvailable: available },
            bridge: {
                controlMode: 'session',
                sourceStatus: 'connected',
                source: { app: 'codex', kind: 'session', id: nativeId, hostId: 'local:codex:host', runtimeGeneration: 'gen-1' },
            },
        },
    } as unknown as Session;
}

describe('Track C Batch 9: R083 shared peer status subscription in useCodelyncSessionActivityForSource', () => {
    const roots: ReturnType<typeof create>[] = [];

    beforeEach(() => {
        mocks.peerIdentity = 'peer:mac-1';
        mocks.statusListeners.clear();
        mocks.statusAddCount = 0;
        mocks.statusRemoveCount = 0;
        codelyncProjectActivityStore.reset('');
    });

    afterEach(() => {
        act(() => {
            while (roots.length) roots.pop()!.unmount();
        });
        codelyncProjectActivityStore.reset('');
    });

    it('shares a single apiSocket.onStatusChange subscription across many scoped rows, skips unscoped rows, and only notifies on peerIdentity changes', () => {
        codelyncProjectActivityStore.reset('peer:mac-1:acc');
        const sessions = Array.from({ length: 25 }, (_, i) => makeNativeSession(`s-${i}`));
        const requested = new Set(['g1']);
        const wanted = new Map([['g1', new Set(sessions.map((s) => s.id))]]);
        const scopes = new Map(sessions.map((s) => [s.id, codelyncActivitySourceScope('machine-1', 'codex', 'local:codex:host', `native-${s.id}`)]));
        codelyncProjectActivityStore.apply(
            'machine-1',
            {
                ok: true,
                version: 1,
                epoch: 'ep',
                sequence: 1,
                observedAt: 10,
                groups: [{
                    id: 'g1',
                    total: 25,
                    active: 25,
                    waiting: 0,
                    unknown: 0,
                    status: 'ready',
                    sessions: sessions.map((s) => ({ id: s.id, known: true, active: true, waiting: false })),
                }],
            },
            requested,
            wanted,
            scopes,
        );

        let renders = 0;
        const latestStatuses: Array<ReturnType<typeof useCodelyncSessionActivityForSource>> = [];
        function Row({ session, index }: { session: Session; index: number }) {
            if (index === 0) renders += 1;
            latestStatuses[index] = useCodelyncSessionActivityForSource(session);
            return null;
        }
        function UnscopedRow({ session }: { session: Session }) {
            useCodelyncSessionActivityForSource(session);
            return null;
        }

        // Unscoped legacy session creates zero socket listeners.
        const legacySession = { id: 'legacy', metadata: { path: '/a', host: 'h' } } as unknown as Session;
        let unscopedRoot!: ReturnType<typeof create>;
        act(() => { unscopedRoot = create(React.createElement(UnscopedRow, { session: legacySession })); });
        roots.push(unscopedRoot);
        expect(mocks.statusAddCount).toBe(0);
        expect(mocks.statusListeners.size).toBe(0);

        let listRoot!: ReturnType<typeof create>;
        act(() => {
            listRoot = create(React.createElement(
                React.Fragment,
                null,
                ...sessions.map((session, index) => React.createElement(Row, { key: session.id, session, index })),
            ));
        });
        roots.push(listRoot);

        // Only 1 shared apiSocket.onStatusChange registration across all 25 rows.
        expect(mocks.statusAddCount).toBe(1);
        expect(mocks.statusListeners.size).toBe(1);
        expect(latestStatuses[0].status).toBe('ready');
        expect(latestStatuses[0].active).toBe(true);
        const initialRenders = renders;

        // Same-peer socket status churn does not re-render rows.
        act(() => {
            for (const listener of [...mocks.statusListeners]) listener('disconnected');
            for (const listener of [...mocks.statusListeners]) listener('connected');
        });
        expect(renders).toBe(initialRenders);
        expect(latestStatuses[0].status).toBe('ready');

        // Actual peer identity switch notifies subscribed rows immediately.
        act(() => {
            mocks.peerIdentity = 'peer:mac-2';
            for (const listener of [...mocks.statusListeners]) listener('connected');
        });
        expect(renders).toBeGreaterThan(initialRenders);
        expect(latestStatuses[0].status).toBe('refreshing');

        // Unmounting all rows tears down the shared subscription once.
        act(() => {
            listRoot.unmount();
        });
        expect(mocks.statusRemoveCount).toBe(1);
        expect(mocks.statusListeners.size).toBe(0);
    });
});

describe('Track C Batch 9: R088 idle per-session InvalidateSync/AsyncLock pruning on catalog removal', () => {
    let engine: any;

    beforeEach(() => {
        vi.resetAllMocks();
        mocks.config.noninvasiveLocal = true;
        mocks.state = {
            sessions: {
                kept: makeNativeSession('kept', 'native-kept'),
                removedFromCatalog: makeNativeSession('removedFromCatalog', 'native-removed'),
                viewedRemoved: makeNativeSession('viewedRemoved', 'native-viewed'),
                busyRemoved: makeNativeSession('busyRemoved', 'native-busy'),
            },
            sessionMessages: {},
            currentViewingSessionId: 'viewedRemoved',
        };
        engine = new (sync.constructor as new () => typeof sync)();
        engine.credentials = { token: 'tok', secret: 'sec', peer: { id: 'p'.repeat(64) } };
        engine.encryption = { initializeSessions: vi.fn(async () => {}) };
    });

    afterEach(() => {
        engine?.sessionAvatars.clear();
    });

    it('isIdle accurately tracks InvalidateSync and AsyncLock activity', async () => {
        const lock = new AsyncLock();
        expect(lock.isIdle()).toBe(true);
        let releaseLock: (() => void) | undefined;
        const holding = lock.inLock(() => new Promise<void>((resolve) => { releaseLock = resolve; }));
        expect(lock.isIdle()).toBe(false);
        await vi.waitFor(() => expect(releaseLock).toBeTypeOf('function'));
        releaseLock!();
        await holding;
        expect(lock.isIdle()).toBe(true);

        let finishSync: (() => void) | undefined;
        const inv = new InvalidateSync(() => new Promise<void>((resolve) => { finishSync = resolve; }));
        expect(inv.isIdle()).toBe(true);
        const waiting = inv.invalidateAndAwait();
        expect(inv.isIdle()).toBe(false);
        await vi.waitFor(() => expect(finishSync).toBeTypeOf('function'));
        finishSync!();
        await waiting;
        expect(inv.isIdle()).toBe(true);
    });

    it('prunes idle entries for removed catalog sessions while keeping active, viewed, and busy entries intact', async () => {
        // Populate per-session maps for all 4 sessions + 1 absent id.
        for (const id of ['kept', 'removedFromCatalog', 'viewedRemoved', 'busyRemoved', 'absentId']) {
            engine.getMessagesSync(id);
            engine.getSendSync(id);
            engine.getSessionMessageLock(id);
        }

        // Hold an active lock + active InvalidateSync on busyRemoved so it must NOT be pruned.
        let releaseBusyLock: (() => void) | undefined;
        const busyLockPromise = engine.getSessionMessageLock('busyRemoved').inLock(
            () => new Promise<void>((resolve) => { releaseBusyLock = resolve; }),
        );
        let finishBusySync: (() => void) | undefined;
        const busyMsgSync = engine.getMessagesSync('busyRemoved');
        busyMsgSync._command = () => new Promise<void>((resolve) => { finishBusySync = resolve; });
        const busyMsgAwait = busyMsgSync.invalidateAndAwait();
        await vi.waitFor(() => {
            expect(releaseBusyLock).toBeTypeOf('function');
            expect(finishBusySync).toBeTypeOf('function');
        });

        // Catalog returns only `kept`; `removedFromCatalog`, `viewedRemoved`, `busyRemoved` are reconciled as hidden.
        mocks.peerRequest.mockResolvedValue({
            ok: true,
            json: async () => ({
                version: 1,
                sessions: [{
                    id: 'kept',
                    nativeUpdatedAt: 200,
                    metadata: mocks.state.sessions.kept.metadata,
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    active: true,
                    activeAt: 200,
                    createdAt: 1,
                    basicOnly: false,
                    seq: 1,
                }],
                hasMore: false,
                nextCursor: null,
            }),
        });

        await engine.fetchSessions();

        // Removed idle entries are pruned.
        expect(engine.messagesSync.has('removedFromCatalog')).toBe(false);
        expect(engine.sendSync.has('removedFromCatalog')).toBe(false);
        expect(engine.sessionMessageLocks.has('removedFromCatalog')).toBe(false);
        expect(engine.messagesSync.has('absentId')).toBe(false);
        expect(engine.sendSync.has('absentId')).toBe(false);
        expect(engine.sessionMessageLocks.has('absentId')).toBe(false);

        // Active catalog session & currentViewingSessionId are retained.
        expect(engine.messagesSync.has('kept')).toBe(true);
        expect(engine.sendSync.has('kept')).toBe(true);
        expect(engine.sessionMessageLocks.has('kept')).toBe(true);
        expect(engine.messagesSync.has('viewedRemoved')).toBe(true);
        expect(engine.sendSync.has('viewedRemoved')).toBe(true);
        expect(engine.sessionMessageLocks.has('viewedRemoved')).toBe(true);

        // Busy removed session keeps its active InvalidateSync/AsyncLock while idle sendSync is pruned.
        expect(engine.messagesSync.has('busyRemoved')).toBe(true);
        expect(engine.sessionMessageLocks.has('busyRemoved')).toBe(true);
        expect(engine.sendSync.has('busyRemoved')).toBe(false);

        // Once settled, a subsequent catalog sync prunes busyRemoved as well.
        releaseBusyLock!();
        finishBusySync!();
        await Promise.all([busyLockPromise, busyMsgAwait]);
        await engine.fetchSessions();
        expect(engine.messagesSync.has('busyRemoved')).toBe(false);
        expect(engine.sessionMessageLocks.has('busyRemoved')).toBe(false);
    });
});
