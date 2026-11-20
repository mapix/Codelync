import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';

vi.hoisted(() => {
    vi.stubGlobal('__DEV__', false);
});

const mocks = vi.hoisted(() => ({
    os: 'android' as 'android' | 'ios' | 'web',
    appState: {
        currentState: 'active' as 'active' | 'background' | 'inactive',
        listeners: [] as Array<(state: 'active' | 'background' | 'inactive') => void>,
        addEventListener: vi.fn((_event: string, cb: (state: 'active' | 'background' | 'inactive') => void) => {
            mocks.appState.listeners.push(cb);
            return {
                remove: vi.fn(() => {
                    mocks.appState.listeners = mocks.appState.listeners.filter(item => item !== cb);
                }),
            };
        }),
    },
    config: {
        noninvasiveLocal: true,
    },
    addPushTokenListener: vi.fn(),
    scheduleNotificationAsync: vi.fn(async () => 'notif-id-1'),
    cancelScheduledNotificationAsync: vi.fn(async () => {}),
    syncCurrentPushToken: vi.fn(),
    startCodelyncPresence: vi.fn((..._args: unknown[]) => vi.fn()),
    renewCodelyncPresence: vi.fn(),
    registerCodelyncBackgroundTask: vi.fn(async () => {}),
    loadCodelyncPeerCatalog: vi.fn(async () => []),
    state: {
        sessions: {} as Record<string, any>,
        sessionMessages: {} as Record<string, any>,
        currentViewingSessionId: null as string | null,
        settings: { analyticsOptOut: true },
    },
    applyMessages: vi.fn(() => ({ changed: [], hasReadyEvent: false, enteredPlanMode: false })),
    applyReady: vi.fn(),
}));

vi.mock('expo-constants', () => ({ default: { expoConfig: { android: { package: 'com.learnings.codelync' } } } }));
vi.mock('expo-device', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-fixture' }));
vi.mock('expo-notifications', () => ({
    SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
    addPushTokenListener: mocks.addPushTokenListener,
    scheduleNotificationAsync: mocks.scheduleNotificationAsync,
    cancelScheduledNotificationAsync: mocks.cancelScheduledNotificationAsync,
}));
vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return mocks.os;
        },
    },
    AppState: mocks.appState,
}));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/utils/parseToken', () => ({ parseToken: () => 'server-user-id' }));
vi.mock('@/sync/apiSocket', () => ({
    apiSocket: {
        request: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
        peerRequest: vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [], watermark: '1' }) })),
        onMessage: vi.fn(),
        peerReadChannelRevision: vi.fn(() => 0),
        onStatusChange: vi.fn(() => vi.fn()),
        onReconnected: vi.fn(() => vi.fn()),
        sendAppState: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
    },
    getCurrentAppState: () => (mocks.appState.currentState === 'active' ? 'active' : 'background'),
    getCodelyncClientId: () => 'android/1.0.1',
}));
vi.mock('@/sync/webTabTitle', () => ({ notifyUnreadMessage: vi.fn() }));
vi.mock('@/sync/encryption/encryption', () => ({ Encryption: class {} }));
vi.mock('@/sync/encryption/artifactEncryption', () => ({ ArtifactEncryption: class {} }));
vi.mock('@/sync/encryption/encryptionCache', () => ({ EncryptionCache: class {} }));
vi.mock('@/sync/storage', () => ({
    storage: {
        subscribe: vi.fn(() => vi.fn()),
        getState: () => ({
            ...mocks.state,
            applyReady: mocks.applyReady,
            applyMachines: vi.fn(),
            getActiveSessions: () => [],
            applySessions: vi.fn(),
            applyMessages: mocks.applyMessages,
            applyMessagesLoaded: vi.fn(),
            applyOlderMessagesPagination: vi.fn(),
            applyOlderMessagesLoading: vi.fn(),
            deleteSession: vi.fn(),
        }),
    },
}));
vi.mock('@/sync/ops', () => ({ sessionSetAgentModes: vi.fn() }));
vi.mock('@/sync/persistence', () => ({ loadPendingSettings: () => ({}), savePendingSettings: vi.fn() }));
vi.mock('@/sync/revenueCat', () => ({ RevenueCat: {}, LogLevel: {}, PaywallResult: {} }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'http://192.168.1.10:50256' }));
vi.mock('@/sync/pushRegistration', () => ({ syncCurrentPushToken: mocks.syncCurrentPushToken }));
vi.mock('@/sync/apiArtifacts', () => ({ fetchArtifact: vi.fn(), fetchArtifacts: vi.fn(async () => []), createArtifact: vi.fn(), updateArtifact: vi.fn() }));
vi.mock('@/sync/apiFriends', () => ({ getFriendsList: vi.fn(async () => []), getUserProfile: vi.fn() }));
vi.mock('@/sync/apiFeed', () => ({ fetchFeed: vi.fn(async () => ({ items: [], hasMore: false })) }));
vi.mock('@/sync/apiAttachments', () => ({ requestAttachmentUpload: vi.fn(), uploadEncryptedBlob: vi.fn() }));
vi.mock('@/sync/apiProjects', () => ({ fetchProjects: vi.fn(async () => []) }));
vi.mock('@/sync/projects', () => ({ decryptProjectRecord: vi.fn(), loadProjectAvatar: vi.fn() }));
vi.mock('@/sync/sessionAvatars', () => ({ loadSessionAvatar: vi.fn(async () => null) }));
vi.mock('@/sync/typesRaw', () => ({ normalizeRawMessage: (_id: string, _localId: string, _time: number, content: unknown) => content }));
vi.mock('@/sync/codelyncBackgroundTask', () => ({ registerCodelyncBackgroundTask: mocks.registerCodelyncBackgroundTask }));
vi.mock('@/sync/codelyncNotifications', () => ({
    startCodelyncPresence: mocks.startCodelyncPresence,
    renewCodelyncPresence: mocks.renewCodelyncPresence,
}));
vi.mock('@/sync/codelyncBackgroundCache', () => ({
    rememberCodelyncSession: vi.fn(),
    codelyncAccountScope: async () => 'fixture',
    loadCodelyncBackgroundCache: () => ({ sessions: [], messages: {} }),
    saveCodelyncBackgroundCache: vi.fn(),
}));
vi.mock('@/sync/codelyncSessionSelection', () => ({ selectCodelyncSession: vi.fn() }));
vi.mock('@/sync/codelyncSourceActivation', () => ({ activateCodelyncSource: vi.fn() }));
vi.mock('@/sync/codelyncPeerCatalogCache', () => ({
    loadCodelyncPeerCatalog: mocks.loadCodelyncPeerCatalog,
    loadCodelyncPeerCatalogState: vi.fn(async () => ({ sessions: [], watermark: null })),
    saveCodelyncPeerCatalog: vi.fn(async () => {}),
}));
vi.mock('@/sync/codelyncSessionPages', () => ({
    fetchCodelyncSessionPages: vi.fn(async () => ({ sessions: [], watermark: '1' })),
    mergeCodelyncCatalog: vi.fn((items: any[]) => items),
}));
vi.mock('@/config', () => ({ config: mocks.config }));
vi.mock('@/log', () => ({ log: { log: vi.fn() } }));
vi.mock('@/track', () => ({ tracking: null, initializeTracking: vi.fn(), trackGitHubConnected: vi.fn(), trackMessageSent: vi.fn(), trackPaywallCancelled: vi.fn(), trackPaywallError: vi.fn(), trackPaywallPresented: vi.fn(), trackPaywallPurchased: vi.fn(), trackPaywallRestored: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/encryption/blob', () => ({}));
vi.mock('@/utils/readFileBytes', () => ({}));
vi.mock('@/sync/gitStatusSync', () => ({ gitStatusSync: { getSync: () => ({ invalidate: vi.fn() }), clearForSession: vi.fn() } }));
vi.mock('@/realtime/hooks/voiceHooks', () => ({
    voiceHooks: { onSessionFocus: vi.fn(), onMessages: vi.fn(), onReady: vi.fn() },
}));

import { sync } from './sync';

const SyncClass = sync.constructor as new () => typeof sync;

const credentials: AuthCredentials = {
    token: 'fixture-token',
    secret: 'fixture-secret',
    serverUrl: 'http://192.168.1.10:50256',
    peer: {
        id: 'f'.repeat(64),
        key: 'a'.repeat(43),
        channels: [{ id: 'local', kind: 'local', url: 'http://192.168.1.10:50256' }],
        device: { publicKey: 'b'.repeat(43), secretKey: 'c'.repeat(43) },
        automatic: true,
        selectedChannel: 'local',
    },
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.os = 'android';
    mocks.config.noninvasiveLocal = true;
    mocks.appState.currentState = 'active';
    mocks.appState.listeners = [];
    mocks.state = {
        sessions: { s1: { id: 's1', permissionMode: 'auto', metadata: {} } },
        sessionMessages: {},
        currentViewingSessionId: 's1',
        settings: { analyticsOptOut: true },
    };
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('Sync push-free Android mode', () => {
    it('does not attach addPushTokenListener on Android and suppresses false push failure logs on unsupported permission', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mocks.syncCurrentPushToken.mockResolvedValueOnce({
            registered: false,
            token: null,
            permission: {
                status: 'unsupported',
                granted: false,
                canAskAgain: false,
            },
        });

        const engine: any = new SyncClass();
        engine.credentials = credentials;

        expect(mocks.addPushTokenListener).not.toHaveBeenCalled();

        await engine.registerPushToken();

        expect(mocks.syncCurrentPushToken).toHaveBeenCalledExactlyOnceWith(credentials);
        expect(consoleLogSpy).not.toHaveBeenCalledWith('Failed to get push token for push notification!');
    });

    it('still logs push failure warning when permission status is denied on iOS', async () => {
        mocks.os = 'ios';
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mocks.syncCurrentPushToken.mockResolvedValueOnce({
            registered: false,
            token: null,
            permission: {
                status: 'denied',
                granted: false,
                canAskAgain: false,
            },
        });

        const engine: any = new SyncClass();
        engine.credentials = credentials;

        expect(mocks.addPushTokenListener).toHaveBeenCalledOnce();

        await engine.registerPushToken();

        expect(consoleLogSpy).toHaveBeenCalledWith('Failed to get push token for push notification!');
    });

    it('skips Notifications.scheduleNotificationAsync during background outbox watchdog timeout on push-free Android while failing timed-out sends cleanly', async () => {
        vi.useFakeTimers();
        const engine: any = new SyncClass();
        engine.credentials = credentials;
        engine.pendingOutbox.set('s1', [{ localId: 'msg-1' }]);

        mocks.appState.currentState = 'background';
        for (const listener of mocks.appState.listeners) {
            listener('background');
        }

        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.scheduleNotificationAsync).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(30_000);
        expect(mocks.scheduleNotificationAsync).not.toHaveBeenCalled();
        expect(engine.pendingOutbox.has('s1')).toBe(false);
    });

    it('skips Notifications.scheduleNotificationAsync on resume after >=30s background send timeout on push-free Android', async () => {
        const engine: any = new SyncClass();
        for (const queueName of [
            'sessionsSync',
            'projectsSync',
            'settingsSync',
            'profileSync',
            'purchasesSync',
            'machinesSync',
            'pushTokenSync',
            'nativeUpdateSync',
            'friendsSync',
            'friendRequestsSync',
            'artifactsSync',
            'feedSync',
        ]) {
            engine[queueName]?.stop();
        }
        engine.credentials = credentials;
        engine.pendingOutbox.set('s1', [{ localId: 'msg-resume-1' }]);
        engine.backgroundSendStartedAt = Date.now() - 35_000;

        mocks.appState.currentState = 'active';
        for (const listener of mocks.appState.listeners) {
            listener('active');
        }

        await Promise.resolve();
        expect(mocks.scheduleNotificationAsync).not.toHaveBeenCalled();
        expect(engine.pendingOutbox.has('s1')).toBe(false);
    });

    it('starts foreground presence cleanly in restore() on push-free Android without push errors', async () => {
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mocks.syncCurrentPushToken.mockResolvedValue({
            registered: false,
            token: null,
            permission: {
                status: 'unsupported',
                granted: false,
                canAskAgain: false,
            },
        });

        const engine: any = new SyncClass();
        for (const queueName of [
            'sessionsSync',
            'projectsSync',
            'settingsSync',
            'profileSync',
            'purchasesSync',
            'machinesSync',
            'nativeUpdateSync',
            'friendsSync',
            'friendRequestsSync',
            'artifactsSync',
            'feedSync',
        ]) {
            engine[queueName]?.stop();
        }
        const encryption: any = { anonID: 'anon-1', getSessionEncryption: () => undefined };

        await engine.restore(credentials, encryption);
        await engine.pushTokenSync.awaitQueue();

        expect(mocks.startCodelyncPresence).toHaveBeenCalledExactlyOnceWith(
            credentials,
            expect.any(Function),
            expect.any(Function),
        );
        expect(mocks.syncCurrentPushToken).toHaveBeenCalledExactlyOnceWith(credentials);
        expect(consoleLogSpy).not.toHaveBeenCalledWith('Failed to get push token for push notification!');
    });
});
