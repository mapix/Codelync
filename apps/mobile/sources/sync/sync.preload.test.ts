import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messagePlanMode } from './messagePlanMode';

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
    setModes: vi.fn(),
    gitInvalidate: vi.fn(),
    voiceFocus: vi.fn(),
    voiceMessages: vi.fn(),
    voiceReady: vi.fn(),
    loadAvatar: vi.fn(async () => null),
    config: { noninvasiveLocal: false },
}));

// Exercise the real Sync orchestration, locking and pagination with only the
// native services/network/store boundary replaced. No Expo runtime or sockets.
vi.mock('expo-constants', () => ({ default: {} }));
vi.mock('expo-device', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
vi.mock('expo-notifications', () => ({}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: vi.fn() } }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { request: mocks.request, peerRequest: mocks.peerRequest }, getCurrentAppState: () => 'active', getCodelyncClientId: () => 'test' }));
vi.mock('@/sync/webTabTitle', () => ({ notifyUnreadMessage: vi.fn() }));
vi.mock('@/sync/encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('@/sync/encryption/artifactEncryption', () => ({ ArtifactEncryption: class {} }));
vi.mock('@/sync/encryption/encryptionCache', () => ({ EncryptionCache: class {} }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({
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
    applyOlderMessagesLoading: (id: string, isLoading: boolean) => {
        if (mocks.state.sessionMessages[id]) mocks.state.sessionMessages[id].isLoadingOlder = isLoading;
    },
    deleteSession: (id: string) => {
        delete mocks.state.sessions[id];
        delete mocks.state.sessionMessages[id];
    },
}) } }));
vi.mock('@/sync/ops', () => ({ sessionSetAgentModes: mocks.setModes }));
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
vi.mock('@/sync/sessionAvatars', () => ({ loadSessionAvatar: mocks.loadAvatar }));
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
vi.mock('@/sync/gitStatusSync', () => ({ gitStatusSync: { getSync: () => ({ invalidate: mocks.gitInvalidate }), clearForSession: vi.fn() } }));
vi.mock('@/realtime/hooks/voiceHooks', () => ({ voiceHooks: {
    onSessionFocus: mocks.voiceFocus, onMessages: mocks.voiceMessages, onReady: mocks.voiceReady,
} }));

import { sync } from './sync';
import { codelyncLoadingProgress } from './codelyncLoadingProgress';

let engine: any;
let encryption: { decryptMessages: ReturnType<typeof vi.fn> };
afterEach(() => { engine?.sessionAvatars.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function response(messages: any[], hasMore = false) {
    return { ok: true, json: async () => ({ messages, hasMore }) };
}
function message(name?: string) {
    return {
        id: 'message', seq: 100, localId: null, createdAt: 1,
        content: { role: 'agent', content: name ? [{ type: 'tool-call', name }] : [{ type: 'text', text: 'Hello' }] },
    };
}
async function waitForPreload() {
    await vi.waitFor(() => expect(mocks.applyMessagesLoaded).toHaveBeenCalled());
    await Promise.resolve();
}

beforeEach(() => {
    vi.resetAllMocks();
    mocks.config.noninvasiveLocal = false;
    mocks.activate.mockResolvedValue(undefined); mocks.select.mockResolvedValue(undefined);
    vi.stubGlobal('__DEV__', false);
    mocks.state = {
        sessions: { a: { id: 'a', permissionMode: 'auto', metadata: {} }, b: { id: 'b', permissionMode: 'auto', metadata: {} } },
        sessionMessages: {}, currentViewingSessionId: null,
    };
    mocks.request.mockResolvedValue(response([message()]));
    mocks.applyMessages.mockImplementation((id, messages, source) => {
        mocks.state.sessionMessages[id] = { messages, messagesMap: { message: messages[0] }, hasMoreOlder: false };
        const enteredPlanMode = messagePlanMode(messages) === true;
        if (enteredPlanMode && source !== 'preload') mocks.state.sessions[id].permissionMode = 'plan';
        return { changed: ['message'], hasReadyEvent: true, enteredPlanMode };
    });
    mocks.applyOlderMessagesPagination.mockImplementation((id, { hasMore }) => {
        if (mocks.state.sessionMessages[id]) mocks.state.sessionMessages[id].hasMoreOlder = hasMore;
    });
    mocks.applyMessagesLoaded.mockImplementation((id) => {
        mocks.state.sessionMessages[id] ??= { messages: [], messagesMap: {}, hasMoreOlder: false, isLoadingOlder: false };
        mocks.state.sessionMessages[id].isLoaded = true;
    });
    mocks.setModes.mockImplementation((id, patch) => Object.assign(mocks.state.sessions[id], patch));
    engine = new (sync.constructor as new () => typeof sync)();
    encryption = { decryptMessages: vi.fn(async (messages: any[]) => messages) };
    engine.encryption = { getSessionEncryption: (id: string) => mocks.state.sessions[id] ? encryption : undefined };
});

it('a restored connection queues new visible-session progress before connected UI can reveal an old error', () => {
    mocks.config.noninvasiveLocal = true; mocks.state.currentViewingSessionId = 'a';
    const previous = codelyncLoadingProgress.beginSession('a'); codelyncLoadingProgress.endSession('a', previous, true);
    engine.onCodelyncConnectionRestored(); codelyncLoadingProgress.endSession('a', previous, true);
    expect(codelyncLoadingProgress.getSession('a')).toMatchObject({ phase: 'loading', queued: true });
    expect(codelyncLoadingProgress.getDiscovery()).toMatchObject({ phase: 'loading', queued: true });
});

describe('background history budget', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        engine.historyPrefetchSessions.add('a');
        mocks.request.mockImplementation(async (url: string) => {
            const query = new URL(url, 'https://example.invalid').searchParams;
            if (query.has('after_seq')) return response([]);
            const end = Math.min(Number(query.get('before_seq')) - 1, 10000);
            const page = Array.from({ length: Math.min(100, end) }, (_, index) => ({
                ...message(), id: `m${end - index}`, seq: end - index,
            }));
            return response(page, end > 100);
        });
        mocks.applyMessages.mockImplementation((id, messages) => {
            const previous = mocks.state.sessionMessages[id]?.messagesMap ?? {};
            const messagesMap = { ...previous, ...Object.fromEntries(messages.map((m: any) => [m.id, m])) };
            mocks.state.sessionMessages[id] = { ...mocks.state.sessionMessages[id], messagesMap };
            return { changed: [], hasReadyEvent: false, enteredPlanMode: false };
        });
        // Preserve IDs in this fixture's normalized payload (the boundary mock
        // returns content directly) so duplicate/missing pages are observable.
        encryption.decryptMessages.mockImplementation(async (messages: any[]) => messages.map(m => ({
            ...m, content: { ...m.content, id: m.id },
        })));
    });

    async function openHistory() {
        await engine.fetchMessages('a');
        await vi.runAllTimersAsync();
    }

    it('shares five attempts across visits, reconnects and gap invalidations', async () => {
        await openHistory();
        expect(Object.keys(mocks.state.sessionMessages.a.messagesMap)).toHaveLength(600);
        expect(engine.sessionOldestSeq.get('a')).toBe(9401);
        for (let i = 0; i < 20; i++) {
            // The same invalidation entry point used by reconnect/gap handling;
            // visibility also re-adds history eligibility on every visit.
            engine.historyPrefetchSessions.add('a');
            await engine.getMessagesSync('a').invalidateAndAwait();
            await vi.runAllTimersAsync();
        }
        expect(mocks.request.mock.calls.filter(([url]) => url.includes('before_seq='))).toHaveLength(6);
        expect(engine.sessionOldestSeq.get('a')).toBe(9401);
        expect(mocks.state.sessionMessages.a.hasMoreOlder).toBe(true);
    });

    it('Codelync loads just the latest page until the reader requests history', async () => {
        mocks.config.noninvasiveLocal = true;
        vi.useRealTimers();
        await engine.fetchInitialLatestPage('a', encryption);
        await engine.prefetchOlderMessagesInBackground('a');
        expect(mocks.request).toHaveBeenCalledTimes(1);
        expect(mocks.request.mock.calls[0][0]).toContain('limit=50');
        expect(mocks.state.sessionMessages.a.hasMoreOlder).toBe(true);
        await engine.loadOlderMessages('a');
        expect(mocks.request).toHaveBeenCalledTimes(2);
        expect(engine.sessionOldestSeq.get('a')).toBeLessThan(9951);
    });

    it('Codelync data notifications do not refetch already admitted messages or Git', () => {
        mocks.config.noninvasiveLocal = true;
        engine.refreshSessionData = vi.fn();
        engine.onSessionDataUpdated('a');
        expect(engine.refreshSessionData).not.toHaveBeenCalled();
    });

    it('coalesces live catalog activity and preserves concurrent metadata changes', async () => {
        mocks.state.sessions.a = { id: 'a', seq: 0, updatedAt: 0, metadata: { version: 'old' } };
        engine.applySessions = vi.fn();
        for (let seq = 1; seq <= 100; seq++) engine.queueCodelyncActivity('a', { seq, updatedAt: seq });
        mocks.state.sessions.a.metadata = { version: 'new' };
        await vi.runAllTimersAsync();
        expect(engine.applySessions).toHaveBeenCalledTimes(1);
        expect(engine.applySessions.mock.calls[0][0][0]).toMatchObject({ seq: 100, metadata: { version: 'new' } });
    });

    it('keeps every older page reachable with a continuous exclusive cursor', async () => {
        await openHistory();
        while (mocks.state.sessionMessages.a.hasMoreOlder) await engine.loadOlderMessages('a');
        expect(Object.keys(mocks.state.sessionMessages.a.messagesMap)).toHaveLength(10000);
        expect(engine.sessionOldestSeq.get('a')).toBe(1);
        const cursors = mocks.request.mock.calls.slice(1).map(([url]) => Number(new URL(url, 'https://example.invalid').searchParams.get('before_seq')));
        expect(cursors).toEqual(Array.from({ length: 99 }, (_, i) => 9901 - i * 100));
        expect(engine.sessionLastSeq.get('a')).toBe(10000);
    });

    it('does not multiply the budget for concurrent triggers or replenish it after manual loading', async () => {
        await engine.fetchInitialLatestPage('a', encryption);
        const pending = Promise.all(Array.from({ length: 20 }, () => engine.prefetchOlderMessagesInBackground('a')));
        await vi.runAllTimersAsync();
        await pending;
        expect(mocks.request).toHaveBeenCalledTimes(6);
        await engine.loadOlderMessages('a');
        await engine.prefetchOlderMessagesInBackground('a');
        expect(mocks.request).toHaveBeenCalledTimes(7);
        expect(engine.sessionOldestSeq.get('a')).toBe(9301);
    });

    it('bounds retries after failures while allowing on-demand recovery', async () => {
        await engine.fetchInitialLatestPage('a', encryption);
        const requestPage = mocks.request.getMockImplementation()!;
        mocks.request.mockRejectedValue(new Error('synthetic offline'));
        for (let i = 0; i < 20; i++) await engine.prefetchOlderMessagesInBackground('a');
        expect(mocks.request).toHaveBeenCalledTimes(6);
        expect(engine.sessionOldestSeq.get('a')).toBe(9901);
        mocks.request.mockImplementation(requestPage);
        await engine.loadOlderMessages('a');
        expect(engine.sessionOldestSeq.get('a')).toBe(9801);
    });

    it('stops between pages when history is unloaded or its key disappears', async () => {
        await engine.fetchInitialLatestPage('a', encryption);
        delete mocks.state.sessionMessages.a;
        await engine.prefetchOlderMessagesInBackground('a');
        mocks.state.sessionMessages.a = { hasMoreOlder: true };
        engine.encryption.getSessionEncryption = () => undefined;
        await engine.prefetchOlderMessagesInBackground('a');
        expect(mocks.request).toHaveBeenCalledTimes(1);
        expect(engine.olderMessagesPrefetchAttempts.has('a')).toBe(false);
    });

    it('clears the budget together with deleted history and cursors', async () => {
        await openHistory();
        engine.encryption.removeSessionEncryption = vi.fn();
        engine.projectsSync = { invalidate: vi.fn() };
        await engine.handleUpdate({ id: 'delete', seq: 1, createdAt: 1, body: { t: 'delete-session', sid: 'a' } });
        expect(engine.olderMessagesPrefetchAttempts.has('a')).toBe(false);
        expect(engine.sessionOldestSeq.has('a')).toBe(false);
        expect(mocks.state.sessionMessages.a).toBeUndefined();
        await engine.prefetchOlderMessagesInBackground('a');
        expect(mocks.request).toHaveBeenCalledTimes(6);
    });
});

describe('Codelync recent-first entry and peer reads', () => {
    function recent(id = 'a', cursor: string | null = 'earlier', text = 'full latest native content') {
        return { version: 1, session: { id, nativeUpdatedAt: 500, metadata: { path: '/fixture', host: 'fixture' }, metadataVersion: 1, agentState: null, agentStateVersion: 0,
            active: true, activeAt: 100, createdAt: 1, basicOnly: false, seq: 100, sessionKey: Buffer.alloc(32, 1).toString('base64') },
            rows: [{ id: `${id}-source-row`, role: 'assistant', text, turnId: 'original-turn', at: 500, order: 0, projectionRevision: 1, streamRevision: 0, snapshotRevision: 2, ownerGeneration: 'owner', replaceIds: [] }],
            nextCursor: cursor, hasMore: !!cursor, ownerGeneration: 'owner', revision: 1, currentTurnId: 'original-turn', status: 'active', seq: 100, observedAt: 1000 };
    }
    function peer() {
        mocks.config.noninvasiveLocal = true;
        engine.credentials = { token: 'fixture-token', secret: 'fixture-secret', peer: { id: 'verified-peer' } };
        engine.encryption.initializeSessions = vi.fn(async () => {});
        mocks.state.currentViewingSessionId = 'a';
        mocks.peerRequest.mockResolvedValue({ ok: true, json: async () => recent() });
    }
    function uncachedChild() {
        const data = recent('child');
        data.session.metadata = { path: '/fixture', host: 'fixture', machineId: 'machine', client: { id: 'noninvasive-bridge' },
            nativeSession: { isSubagent: true, parentId: 'native-parent', catalogueAvailable: true }, bridge: {
                controlMode: 'session', sourceStatus: 'connected', source: { app: 'antigravity', kind: 'session', protocol: 'antigravity-connect',
                    id: 'native-child', hostId: 'local:antigravity:' + 'a'.repeat(64), runtimeGeneration: 'owner' } } } as any;
        return data;
    }
    it('initializes the exact uncached foreground child from one authenticated recent read without Desktop selection', async () => {
        peer(); mocks.state.currentViewingSessionId = 'child';
        mocks.peerRequest.mockResolvedValue({ ok: true, json: async () => uncachedChild() });
        engine.onSessionVisible('child'); engine.onSessionVisible('child');
        await vi.waitFor(() => expect(mocks.applyMessagesLoaded).toHaveBeenCalledWith('child'));
        expect(mocks.peerRequest).toHaveBeenCalledOnce(); expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.activate).not.toHaveBeenCalled();
        expect(mocks.state.sessions.child.metadata.nativeSession).toMatchObject({ isSubagent: true, parentId: 'native-parent', catalogueAvailable: true });
        expect(engine.encryption.initializeSessions).toHaveBeenCalledOnce();
    });
    it('an unavailable child Retry awaits its exact bounded read without a directory scan or Desktop navigation', async () => {
        peer(); mocks.state.currentViewingSessionId = 'child';
        mocks.peerRequest.mockResolvedValue({ ok: true, json: async () => uncachedChild() });
        await engine.retryCodelyncSession('child');
        expect(mocks.peerRequest).toHaveBeenCalledOnce(); expect(mocks.peerRequest.mock.calls[0][0]).toBe('/api/peer/sessions/child/recent');
        expect(mocks.applyMessagesLoaded).toHaveBeenCalledWith('child'); expect(mocks.select).not.toHaveBeenCalled();
    });
    it('a failed foreground peer read completes with an error and permits a new exact Retry', async () => {
        peer(); mocks.state.currentViewingSessionId = 'child';
        mocks.peerRequest.mockResolvedValue({ ok: false, status: 503 });
        await expect(engine.retryCodelyncSession('child')).rejects.toThrow('503');
        expect(mocks.peerRequest).toHaveBeenCalledOnce(); expect(engine.codelyncEntryFlights.has('child')).toBe(false);
        expect(codelyncLoadingProgress.getSession('child').phase).toBe('error');
        mocks.peerRequest.mockResolvedValue({ ok: true, json: async () => uncachedChild() });
        await engine.retryCodelyncSession('child');
        expect(mocks.peerRequest).toHaveBeenCalledTimes(2); expect(mocks.applyMessagesLoaded).toHaveBeenCalledWith('child');
        expect(codelyncLoadingProgress.getSession('child').phase).toBe('complete'); expect(mocks.select).not.toHaveBeenCalled();
    });
    it('cached first body finishes immediately, preserves expanded rows/cursors, and shares one background fresh read', async () => {
        peer(); mocks.state.currentViewingSessionId = 'child';
        const data: any = uncachedChild(); data.freshness = { version: 1, mode: 'cached', capturedAt: 900, ownerGeneration: 'owner', currentControlAuthority: false, revalidationPending: true };
        mocks.state.sessions.child = { ...data.session, draft: 'local draft' };
        mocks.state.sessionMessages.child = { messages: ['expanded-retained-row'], hasMoreOlder: true };
        engine.codelyncHistoryCursors.set('child', 'previous-fresh-cursor'); engine.codelyncHistoryOwners.set('child', 'owner');
        mocks.applyMessages.mockImplementation((id, messages) => {
            mocks.state.sessionMessages[id] = { ...mocks.state.sessionMessages[id], messages: [...mocks.state.sessionMessages[id].messages, ...messages] };
            return { changed: [], hasReadyEvent: false, enteredPlanMode: false };
        });
        let finish!: (value: any) => void;
        mocks.peerRequest.mockResolvedValueOnce({ ok: true, json: async () => data }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await engine.retryCodelyncSession('child');
        await vi.waitFor(() => expect(mocks.peerRequest).toHaveBeenCalledTimes(2));
        expect(codelyncLoadingProgress.getSession('child')).toMatchObject({ phase: 'complete', revalidating: true });
        expect(mocks.state.sessionMessages.child.messages).toContain('expanded-retained-row'); expect(mocks.state.sessions.child.draft).toBe('local draft');
        expect(mocks.state.sessions.child.metadata.capabilities).toMatchObject({ readOnly: true, steering: false });
        expect(engine.codelyncHistoryCursors.get('child')).toBe('previous-fresh-cursor');
        await engine.fetchMessages('child'); await engine.retryCodelyncSession('child');
        expect(mocks.peerRequest).toHaveBeenCalledTimes(2); expect(codelyncLoadingProgress.getSession('child').phase).toBe('complete');
        expect(await engine.loadOlderMessages('child')).toBe(false);
        const fresh: any = uncachedChild(); fresh.session.metadata.capabilities = { readOnly: false, steering: true };
        finish({ ok: true, json: async () => fresh });
        await vi.waitFor(() => expect(codelyncLoadingProgress.getSession('child').revalidating).toBe(false));
        expect(mocks.state.sessions.child.metadata.capabilities.readOnly).toBe(false);
        expect(engine.codelyncHistoryCursors.get('child')).toBe('earlier'); expect(mocks.select).not.toHaveBeenCalled();
        expect(JSON.parse(mocks.peerRequest.mock.calls[0][1].body)).toEqual({ limit: 25, readPolicy: 'cache-first' });
        expect(JSON.parse(mocks.peerRequest.mock.calls[1][1].body)).toEqual({ limit: 25 });
    });
    it('failed fresh revalidation retains the cached body/draft and ends without an initial-error spinner', async () => {
        peer(); mocks.state.currentViewingSessionId = 'child'; const data: any = uncachedChild();
        data.freshness = { version: 1, mode: 'cached', capturedAt: 900, ownerGeneration: 'owner', currentControlAuthority: false, revalidationPending: true };
        mocks.state.sessions.child = { ...data.session, draft: 'local draft' };
        mocks.peerRequest.mockResolvedValueOnce({ ok: true, json: async () => data }).mockRejectedValueOnce(Error('packet lost'));
        await engine.retryCodelyncSession('child');
        await vi.waitFor(() => expect(codelyncLoadingProgress.getSession('child')).toMatchObject({ phase: 'complete', revalidating: false, revalidationFailed: true }));
        expect(mocks.state.sessions.child.draft).toBe('local draft'); expect(mocks.state.sessionMessages.child.messages).not.toHaveLength(0);
        expect(mocks.state.sessions.child.metadata.capabilities.readOnly).toBe(true); expect(mocks.peerRequest).toHaveBeenCalledTimes(2); expect(mocks.select).not.toHaveBeenCalled();
    });
    it('newer current-run live metadata survives late cached and older fresh packets; disk retained versions cannot lend authority', async () => {
        peer(); mocks.state.currentViewingSessionId = 'child';
        const first: any = uncachedChild(); first.session.metadata.nativeSession.isSubagent = false;
        first.session.metadata.capabilities = { readOnly: false, steering: true, rpcMethods: ['codex-controls-update'] };
        mocks.peerRequest.mockResolvedValueOnce({ ok: true, json: async () => first });
        await engine.fetchPeerRecentWindow('child');
        let releaseCache!: (value: any) => void, releaseFresh!: (value: any) => void;
        mocks.peerRequest.mockImplementationOnce(() => new Promise(resolve => { releaseCache = resolve; }))
            .mockImplementationOnce(() => new Promise(resolve => { releaseFresh = resolve; }));
        const entering = engine.retryCodelyncSession('child'); await vi.waitFor(() => expect(releaseCache).toBeTypeOf('function'));
        (encryption as any).decryptMetadata = vi.fn().mockResolvedValue({ ...first.session.metadata, name: 'newer live metadata' });
        await engine.handleUpdate({ id: 'ws-current', seq: 300, createdAt: 1000, body: { t: 'update-session', id: 'child', metadata: { version: 3, value: 'opaque-encrypted-metadata' } } });
        engine.sessionLastSeq.set('child', 300);
        const cached: any = { ...first, freshness: { version: 1, mode: 'cached', capturedAt: 900, ownerGeneration: 'owner', currentControlAuthority: false, revalidationPending: true } };
        releaseCache({ ok: true, json: async () => cached }); await entering;
        expect(mocks.state.sessions.child.metadataVersion).toBe(3); expect(mocks.state.sessions.child.metadata.capabilities.readOnly).toBe(false);
        const olderFresh = { ...first, session: { ...first.session, metadataVersion: 2 } };
        releaseFresh({ ok: true, json: async () => olderFresh });
        await vi.waitFor(() => expect(codelyncLoadingProgress.getSession('child').revalidating).toBe(false));
        expect(mocks.state.sessions.child.metadataVersion).toBe(3); expect(mocks.state.sessions.child.metadata.name).toBe('newer live metadata');
        expect(engine.sessionLastSeq.get('child')).toBe(300);
        const equalCached={...cached,session:{...cached.session,metadataVersion:3}};
        mocks.peerRequest.mockResolvedValueOnce({ok:true,json:async()=>equalCached}).mockResolvedValueOnce({ok:true,json:async()=>olderFresh});
        await engine.retryCodelyncSession('child');
        await vi.waitFor(()=>expect(codelyncLoadingProgress.getSession('child').revalidating).toBe(false));
        expect(mocks.state.sessions.child.metadataVersion).toBe(3);expect(mocks.state.sessions.child.metadata.capabilities.readOnly).toBe(false);
        engine.codelyncPeerLiveMetadata.clear();
        mocks.state.sessions.child = { ...mocks.state.sessions.child, metadataVersion: 3, draft: 'disk draft' };
        mocks.peerRequest.mockResolvedValueOnce({ ok: true, json: async () => cached }).mockResolvedValueOnce({ ok: true, json: async () => olderFresh });
        await engine.retryCodelyncSession('child');
        await vi.waitFor(() => expect(codelyncLoadingProgress.getSession('child').revalidating).toBe(false));
        expect(mocks.state.sessions.child.metadataVersion).toBe(2); expect(mocks.state.sessions.child.metadata.capabilities.readOnly).toBe(false);
        expect(mocks.state.sessions.child.draft).toBe('disk draft');
    });
    it.each([403, 423, 404, 500, 503])('a %s read failure preserves cached child identity/body and never initializes controls', async status => {
        peer(); mocks.state.currentViewingSessionId = 'child';
        const retained = uncachedChild().session; mocks.state.sessions.child = { ...retained, draft: 'Retained child draft' };
        const messages = { isLoaded: true, messages: ['Retained child body'], messagesMap: {}, hasMoreOlder: true };
        mocks.state.sessionMessages.child = messages; mocks.peerRequest.mockResolvedValue({ ok: false, status });
        await expect(engine.retryCodelyncSession('child')).rejects.toThrow(String(status));
        expect(mocks.state.sessions.child.draft).toBe('Retained child draft'); expect(mocks.state.sessionMessages.child).toBe(messages);
        expect(mocks.applyMessages).not.toHaveBeenCalled(); expect(engine.encryption.initializeSessions).not.toHaveBeenCalled();
        expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.activate).not.toHaveBeenCalled(); expect(mocks.setModes).not.toHaveBeenCalled();
        expect(engine.codelyncEntryFlights.has('child')).toBe(false); expect(codelyncLoadingProgress.getSession('child').phase).toBe('error');
    });
    it('does not initialize unknown, stale-owner or nonforeground uncached descriptors', async () => {
        for (const change of [
            (v: any) => { v.session.id = 'another-route'; },
            (v: any) => { v.session.metadata.client.id = 'unverified-client'; },
            (v: any) => { v.session.metadata.bridge.source.protocol = 'window'; },
            (v: any) => { v.ownerGeneration = 'other-owner'; },
            (v: any) => { v.session.basicOnly = true; },
        ]) {
            peer(); mocks.applyMessages.mockClear(); engine.encryption.initializeSessions.mockClear();
            mocks.state.currentViewingSessionId = 'child'; const data = uncachedChild(); change(data);
            mocks.peerRequest.mockResolvedValue({ ok: true, json: async () => data });
            await expect(engine.fetchPeerRecentWindow('child')).rejects.toThrow();
            expect(mocks.state.sessions.child).toBeUndefined(); expect(engine.encryption.initializeSessions).not.toHaveBeenCalled(); expect(mocks.applyMessages).not.toHaveBeenCalled();
        }
        peer(); mocks.state.currentViewingSessionId = null;
        mocks.peerRequest.mockResolvedValue({ ok: true, json: async () => uncachedChild() });
        await expect(engine.fetchPeerRecentWindow('child')).rejects.toThrow(); expect(mocks.state.sessions.child).toBeUndefined();
    });
    it('cannot publish an uncached child after its foreground route or source changes during key initialization', async () => {
        for (const change of [
            () => { mocks.state.currentViewingSessionId = 'a'; },
            () => { engine.credentials = { peer: { id: 'another-peer' } }; },
            () => { mocks.state.sessions.child = { id: 'child', metadata: { bridge: { source: { app: 'antigravity', id: 'foreign-child', hostId: 'foreign-host' } } } }; },
        ]) {
            peer(); delete mocks.state.sessions.child; mocks.applyMessages.mockClear(); mocks.state.currentViewingSessionId = 'child';
            mocks.peerRequest.mockResolvedValue({ ok: true, json: async () => uncachedChild() });
            let finish!: () => void;
            engine.encryption.initializeSessions.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
            const pending = engine.fetchPeerRecentWindow('child'); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
            change(); finish(); await pending;
            expect(mocks.applyMessages).not.toHaveBeenCalled(); expect(engine.codelyncHistoryCursors.has('child')).toBe(false);
        }
    });
    it('awaits legacy observation before requesting recent messages, with no speculative duplicate GET', async () => {
        mocks.config.noninvasiveLocal = true;
        let finish!: () => void;
        mocks.activate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        engine.onSessionVisible('a'); engine.onSessionVisible('a');
        expect(mocks.activate).toHaveBeenCalledTimes(1); expect(mocks.request).not.toHaveBeenCalled();
        finish();
        await vi.waitFor(() => expect(mocks.applyMessagesLoaded).toHaveBeenCalled());
        expect(mocks.request).toHaveBeenCalledTimes(1);
    });
    it('tap plus focus uses one fresh peer window and never trusts hover preload or older cache', async () => {
        peer();
        engine.sessionLastSeq.set('a', 1); engine.preloadSession('a');
        expect(mocks.request).not.toHaveBeenCalled();
        engine.onSessionSelected('a'); engine.onSessionVisible('a');
        await vi.waitFor(() => expect(mocks.applyMessagesLoaded).toHaveBeenCalled());
        expect(mocks.select).toHaveBeenCalledTimes(1); expect(mocks.activate).not.toHaveBeenCalled();
        expect(mocks.peerRequest).toHaveBeenCalledTimes(1); expect(mocks.peerRequest.mock.calls[0][0]).toContain('/recent');
        expect(JSON.parse(mocks.peerRequest.mock.calls[0][1].body)).toEqual({ limit: 25, readPolicy: 'cache-first' });
        expect(mocks.applyMessages.mock.calls.at(-1)?.[1][0].content.text).toBe('full latest native content');
    });
    it('a pending desktop navigation cannot block the combined authoritative peer recent read', async () => {
        peer(); mocks.select.mockImplementation(() => new Promise<void>(() => {}));
        engine.onSessionSelected('a'); engine.onSessionVisible('a');
        await vi.waitFor(() => expect(mocks.applyMessagesLoaded).toHaveBeenCalled(), { timeout: 300 });
        expect(mocks.peerRequest).toHaveBeenCalledTimes(1);
        expect(mocks.applyMessages.mock.calls.at(-1)?.[1][0].content.text).toBe('full latest native content');
    });
    it('cached peer back/focus entry delegates preparation to each fresh combined HTTP read', async () => {
        peer(); mocks.state.sessions.a.metadata = { bridge: { sourceStatus: 'connected', source: { runtimeGeneration: 'unchanged-owner' } } };
        engine.sessionLastSeq.set('a', 100); mocks.state.sessionMessages.a = { isLoaded: true, messages: [], messagesMap: {} };
        await engine.enterCodelyncSession('a', false);
        await engine.enterCodelyncSession('a', false);
        expect(mocks.activate).not.toHaveBeenCalled();
        expect(mocks.peerRequest).toHaveBeenCalledTimes(2);
        expect(mocks.select).not.toHaveBeenCalled();
    });
    it('unknown or failed machine observation cannot block actual peer entry message application', async () => {
        peer(); mocks.activate.mockRejectedValue(Error('Existing observation command is unconfirmed'));
        mocks.select.mockRejectedValue(Error('Desktop WS unavailable'));
        engine.onSessionSelected('a'); engine.onSessionVisible('a');
        await vi.waitFor(() => expect(mocks.applyMessagesLoaded).toHaveBeenCalled(), { timeout: 300 });
        expect(mocks.activate).not.toHaveBeenCalled(); expect(mocks.peerRequest).toHaveBeenCalledOnce();
        expect(mocks.applyMessages.mock.calls.at(-1)?.[1][0].content.text).toBe('full latest native content');
        expect(codelyncLoadingProgress.getSession('a').phase).toBe('complete');
    });
    it('loads an earlier native window only after explicit history request and advances that cursor', async () => {
        peer(); await engine.fetchMessages('a');
        await engine.prefetchOlderMessagesInBackground('a'); expect(mocks.peerRequest).toHaveBeenCalledTimes(1);
        mocks.peerRequest.mockResolvedValue({ ok: true, json: async () => recent('a', null, 'complete earlier native row') });
        expect(await engine.loadOlderMessages('a', { limit: 3 })).toBe(true);
        expect(mocks.peerRequest.mock.calls[1][0]).toContain('/history?cursor=earlier');
        expect(mocks.peerRequest.mock.calls[1][0]).toContain('limit=3');
        expect(engine.codelyncHistoryCursors.get('a')).toBeNull();
        expect(await engine.loadOlderMessages('a')).toBe(false); expect(mocks.peerRequest).toHaveBeenCalledTimes(2);
    });
    it('a history reply captured by another selected viewport cannot mutate the original cursor or visible messages', async () => {
        peer(); await engine.fetchMessages('a'); mocks.applyMessages.mockClear();
        let finish!: (value: unknown) => void;
        mocks.peerRequest.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const pending = engine.loadOlderMessages('a', { limit: 2 }); await vi.waitFor(() => expect(mocks.peerRequest).toHaveBeenCalledTimes(2));
        mocks.state.currentViewingSessionId = 'b'; finish({ ok: true, json: async () => recent('a', null, 'late history') });
        expect(await pending).toBe(false); expect(mocks.applyMessages).not.toHaveBeenCalled(); expect(engine.codelyncHistoryCursors.get('a')).toBe('earlier');
    });
    it('a superseded selection cannot publish a late recent response', async () => {
        peer(); let finish!: (value: unknown) => void;
        mocks.peerRequest.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const loading = engine.fetchMessages('a'); await vi.waitFor(() => expect(mocks.peerRequest).toHaveBeenCalled());
        mocks.state.currentViewingSessionId = 'b'; finish({ ok: true, json: async () => recent() }); await loading;
        expect(mocks.applyMessages).not.toHaveBeenCalled(); expect(engine.codelyncHistoryCursors.has('a')).toBe(false);
    });
    it('catalog uses a larger follow-up page and does not initialize keys or histories for basic entries', async () => {
        peer(); mocks.peerRequest.mockImplementation(async (path: string) => ({ ok: true, json: async () => ({ version: 1, sessions: [{ ...recent().session, id: path.includes('cursor=') ? 'old' : 'a', nativeUpdatedAt: path.includes('cursor=') ? 1 : 500, basicOnly: path.includes('cursor='), sessionKey: undefined }],
            hasMore: !path.includes('cursor='), nextCursor: path.includes('cursor=') ? null : 'older-page' }) }));
        await engine.fetchSessions();
        expect(mocks.peerRequest.mock.calls.map(([path]) => path)).toEqual(['/api/peer/catalog?limit=200&catalogVersion=2', '/api/peer/catalog?limit=1000&catalogVersion=2&cursor=older-page']);
        expect(engine.encryption.initializeSessions).not.toHaveBeenCalled(); expect(mocks.state.sessions.old.updatedAt).toBe(1);
        expect(mocks.applyMessages).not.toHaveBeenCalled();
    });
    it('a known session opens with a fresh recent read while the directory request is still pending', async () => {
        peer(); mocks.select.mockResolvedValue(undefined);
        let finishCatalog!: (value: unknown) => void;
        mocks.peerRequest.mockImplementation((path: string) => path.includes('/catalog')
            ? new Promise(resolve => { finishCatalog = resolve; })
            : Promise.resolve({ ok: true, json: async () => recent() }));
        const catalog = engine.fetchSessions();
        await vi.waitFor(() => expect(finishCatalog).toBeDefined());
        engine.onSessionSelected('a'); await waitForPreload();
        expect(mocks.applyMessagesLoaded).toHaveBeenCalledWith('a');
        finishCatalog({ ok: true, json: async () => ({ version: 1, sessions: [], hasMore: false, nextCursor: null }) }); await catalog;
    });
    it('machine loading on a verified peer uses proof-aware request with no raw LAN bearer fetch', async () => {
        peer();
        mocks.state.machines = {};
        engine.encryption.initializeMachines = vi.fn(async () => {}); engine.applyMachines = vi.fn();
        mocks.request.mockResolvedValue({ ok: true, json: async () => [] });
        const raw = vi.fn(); vi.stubGlobal('fetch', raw);
        await engine.fetchMachines();
        expect(raw).not.toHaveBeenCalled(); expect(mocks.request).toHaveBeenCalledTimes(1);
        expect(mocks.request.mock.calls[0][0]).toBe('/v1/machines');
        expect(mocks.request.mock.calls[0][1].headers.Authorization).toBeUndefined();
    });
});

describe('session avatar sync integration', () => {
    const avatar = { ref: 'sessions/a/avatar/a.enc', preview: 'opaque', version: 1 };
    const update = (seq: number, value: unknown) => ({ id: `u${seq}`, seq, createdAt: seq, body: { t: 'update-session', id: 'a', avatar: value } });

    it('applies artwork events and prevents reordered updates from undoing removal', async () => {
        engine.projectsSync = { invalidate: vi.fn() };
        await engine.handleUpdate(update(10, avatar));
        expect(mocks.state.sessions.a.avatarDescriptor).toEqual(avatar);
        await engine.handleUpdate(update(12, null));
        await engine.handleUpdate(update(11, { ...avatar, version: 2 }));
        expect(mocks.state.sessions.a.avatarDescriptor).toBeNull();
        expect(mocks.state.sessions.a.avatar).toBeNull();
        expect(mocks.state.sessions.a.avatarUpdateSeq).toBe(12);
        expect(mocks.state.sessions.a.seq).toBe(12);
    });

    it('does not resurrect an image when an old event arrives after a removal snapshot', async () => {
        engine.projectsSync = { invalidate: vi.fn() };
        engine.credentials = { token: 'test', secret: 'secret' };
        engine.encryption = {
            initializeSessions: vi.fn(),
            getSessionEncryption: () => ({ decryptMetadata: async () => ({}), decryptAgentState: async () => null }),
        };
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessions: [{ id: 'a', seq: 0, metadata: 'opaque', metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null, active: false, updatedAt: 10, createdAt: 1, avatar: null, avatarVersion: 3 }] })));
        await engine.fetchSessions();
        await engine.handleUpdate({ ...update(100, { ...avatar, version: 2 }), body: { t: 'update-session', id: 'a', avatar: { ...avatar, version: 2 }, avatarVersion: 2 } });
        expect(mocks.state.sessions.a.avatarDescriptor).toBeNull();
        expect(mocks.state.sessions.a.avatarRevision).toBe(3);
    });

    it('preserves a removal delivered while a stale session snapshot is downloading', async () => {
        engine.projectsSync = { invalidate: vi.fn() };
        engine.credentials = { token: 'test', secret: 'secret' };
        engine.encryption = {
            initializeSessions: vi.fn(),
            getSessionEncryption: () => ({ decryptMetadata: async () => ({}), decryptAgentState: async () => null }),
        };
        await engine.handleUpdate(update(10, avatar));
        let finish!: (value: Response) => void;
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
        const fetching = engine.fetchSessions();
        await engine.handleUpdate(update(11, null));
        finish(Response.json({ sessions: [{ id: 'a', seq: 0, metadata: 'opaque', metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null, active: false, updatedAt: 1, createdAt: 1, avatar }] }));
        await fetching;
        expect(mocks.state.sessions.a.avatarDescriptor).toBeNull();
        expect(mocks.state.sessions.a.avatarUpdateSeq).toBe(11);
    });
});

describe('chat preload sync integration', () => {
    it('hydrates one latest page without read, voice, git, or history side effects', async () => {
        mocks.request.mockResolvedValue(response([message()], true));
        const older = vi.spyOn(engine, 'loadOlderMessages');
        engine.preloadSession('a');
        await waitForPreload();
        expect(mocks.request).toHaveBeenCalledOnce();
        expect(mocks.request.mock.calls[0][0]).toBe('/v3/sessions/a/messages?before_seq=2147483647&limit=100');
        expect(mocks.applyMessages.mock.calls[0][2]).toBe('preload');
        expect(mocks.state.currentViewingSessionId).toBeNull();
        expect(mocks.voiceFocus).not.toHaveBeenCalled();
        expect(mocks.voiceMessages).not.toHaveBeenCalled();
        expect(mocks.voiceReady).not.toHaveBeenCalled();
        expect(mocks.gitInvalidate).not.toHaveBeenCalled();
        expect(older).not.toHaveBeenCalled();
        engine.preloadSession('a');
        await Promise.resolve();
        expect(mocks.request).toHaveBeenCalledOnce();
    });

    it('shares the in-flight first page with touch-up and activates it normally', async () => {
        let finish!: (value: unknown) => void;
        mocks.request.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        engine.preloadSession('a');
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
        mocks.state.currentViewingSessionId = 'a';
        engine.onSessionVisible('a');
        finish(response([message()]));
        await engine.getMessagesSync('a').awaitQueue();
        expect(mocks.request).toHaveBeenCalledOnce();
        expect(encryption.decryptMessages).toHaveBeenCalledOnce();
        expect(mocks.applyMessages.mock.calls[0][2]).toBe('sync');
        expect(mocks.voiceMessages).toHaveBeenCalledOnce();
        expect(mocks.voiceFocus).toHaveBeenCalledWith('a', {});
    });

    it('revalidates a completed preload and starts older history only after a visit', async () => {
        mocks.request.mockResolvedValueOnce(response([message()], true)).mockResolvedValue(response([]));
        // End this test's history loop after its first attempt, without timers.
        const older = vi.spyOn(engine, 'loadOlderMessages').mockRejectedValue(new Error('test stop'));
        engine.preloadSession('a');
        await waitForPreload();
        expect(older).not.toHaveBeenCalled();
        mocks.state.currentViewingSessionId = 'a';
        engine.onSessionVisible('a');
        await engine.getMessagesSync('a').awaitQueue();
        expect(mocks.request.mock.calls[1][0]).toBe('/v3/sessions/a/messages?after_seq=100&limit=100');
        expect(older).toHaveBeenCalledExactlyOnceWith('a');
    });

    it('defers plan-mode changes until the session is actually opened, exactly once', async () => {
        mocks.request.mockResolvedValueOnce(response([message('EnterPlanMode')])).mockResolvedValue(response([]));
        engine.preloadSession('a');
        await waitForPreload();
        expect(mocks.state.sessions.a.permissionMode).toBe('auto');
        expect(mocks.setModes).not.toHaveBeenCalled();
        engine.onSessionVisible('a');
        await engine.getMessagesSync('a').awaitQueue();
        expect(mocks.setModes).toHaveBeenCalledExactlyOnceWith('a', { permissionMode: 'plan' });
        expect(mocks.state.sessions.a.permissionMode).toBe('plan');
    });

    it.each(['new-choice', 'exit-event', 'exit-on-refresh'])('does not replay an obsolete plan transition: %s', async (reason) => {
        mocks.request.mockResolvedValueOnce(response([message('EnterPlanMode')])).mockResolvedValue(response([]));
        engine.preloadSession('a');
        await waitForPreload();
        if (reason === 'new-choice') mocks.state.sessions.a.permissionMode = 'yolo';
        else if (reason === 'exit-event') engine.applyMessages('a', [message('ExitPlanMode').content]);
        else mocks.request.mockResolvedValue(response([{ ...message('ExitPlanMode'), seq: 101 }]));
        engine.onSessionVisible('a');
        await engine.getMessagesSync('a').awaitQueue();
        expect(mocks.setModes).not.toHaveBeenCalled();
    });

    it('drops an abandoned page even if the transport ignores abort', async () => {
        let finish!: (value: unknown) => void;
        mocks.request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue(response([message()]));
        engine.preloadSession('a');
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
        engine.preloadSession('b');
        expect(mocks.request.mock.calls[0][1].signal.aborted).toBe(true);
        finish(response([message()]));
        await vi.waitFor(() => expect(mocks.applyMessagesLoaded).toHaveBeenCalledWith('b'));
        expect(mocks.applyMessagesLoaded).not.toHaveBeenCalledWith('a');
        expect(engine.sessionLastSeq.has('a')).toBe(false);
    });

    it('does not hydrate after the session is deleted during decryption', async () => {
        let finish!: (value: unknown) => void;
        encryption.decryptMessages.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        engine.preloadSession('a');
        await vi.waitFor(() => expect(encryption.decryptMessages).toHaveBeenCalledOnce());
        const pending = engine.messagePreloader.take('a');
        delete mocks.state.sessions.a;
        finish([message()]);
        await expect(pending).resolves.toBe(false);
        expect(mocks.applyMessages).not.toHaveBeenCalled();
        expect(engine.sessionLastSeq.has('a')).toBe(false);
    });

    it('server events preserve voice-follow without claiming a visit or fetching all history', async () => {
        mocks.request.mockResolvedValue(response([message()], true));
        const older = vi.spyOn(engine, 'loadOlderMessages');
        engine.onSessionDataUpdated('a');
        await engine.getMessagesSync('a').awaitQueue();
        expect(mocks.voiceFocus).toHaveBeenCalledWith('a', {});
        expect(mocks.state.currentViewingSessionId).toBeNull();
        expect(older).not.toHaveBeenCalled();
    });
});
