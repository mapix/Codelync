import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' | 'web', peer: 'peer:original-peer', request: vi.fn(), url: 'http://192.0.2.10:9000', sequenceStore: new Map<string, string>(), appState: { currentState: 'active', addEventListener: vi.fn((_event: string, _listener: () => void) => ({ remove: vi.fn() })) } }));
vi.mock('expo-notifications', () => ({ getDevicePushTokenAsync: vi.fn() }));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('react-native', () => ({ Platform: { get OS() { return mocks.os; } }, AppState: mocks.appState }));
vi.mock('@/config', () => ({ config: { codelyncPushEnvironment: null } }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => mocks.url }));
vi.mock('./apiSocket', () => ({ apiSocket: { peerIdentity: () => mocks.peer, request: mocks.request } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async (key: string) => mocks.sequenceStore.get(key) ?? null, setItem: async (key: string, value: string) => { mocks.sequenceStore.set(key, value); } } }));
import { startCodelyncPresence, renewCodelyncPresence, syncCodelyncPushToken } from './codelyncNotifications';
import * as Notifications from 'expo-notifications';
import { config } from '@/config';
let stop: (() => void) | undefined;
const credentials = { token: 'fixture-token', secret: 'fixture-secret', serverUrl: 'http://192.0.2.10:8000', peer: { id: 'original-peer' } } as any;
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); mocks.os = 'ios'; mocks.request.mockReset(); mocks.appState.addEventListener.mockClear(); vi.mocked(Notifications.getDevicePushTokenAsync).mockReset(); mocks.peer = 'peer:original-peer'; mocks.appState.currentState = 'active'; });

it('registers the native APNs token and clears registration when permission is denied', async () => {
    config.codelyncPushEnvironment = 'development';
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({ type: 'ios', data: 'a'.repeat(64) });
    mocks.request.mockResolvedValue({ ok: true, json: async () => ({ registered: true, available: true }) });
    expect(await syncCodelyncPushToken(credentials, true)).toBe('a'.repeat(64));
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toEqual({ enabled: true, token: 'a'.repeat(64), environment: 'development' });
    expect(await syncCodelyncPushToken(credentials, false)).toBeNull();
    expect(JSON.parse(mocks.request.mock.calls[1][1].body)).toEqual({ enabled: false });
    config.codelyncPushEnvironment = undefined;
});

it('does not advertise successful push when the Mac sender is unavailable', async () => {
    config.codelyncPushEnvironment = 'development';
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({ type: 'ios', data: 'a'.repeat(64) });
    mocks.request.mockResolvedValue({ ok: true, json: async () => ({ registered: true, available: false }) });
    expect(await syncCodelyncPushToken(credentials, true)).toBeNull();
    config.codelyncPushEnvironment = undefined;
});

it('foreground session heartbeats use the current authenticated peer route after a same-Mac endpoint change without APNs', async () => {
    vi.useFakeTimers(); mocks.request.mockResolvedValue({ ok: true, json: async () => ({ registered: true, available: false }) });
    let session: string | null = null, changed!: () => void;
    stop = startCodelyncPresence(credentials, () => session, callback => { changed = callback; return () => {}; });
    await Promise.resolve(); session = 'actual-visible-session'; changed(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.request.mock.calls.some(call => call[0] === '/codelync/notifications/presence' && JSON.parse(call[1].body).sessionId === session && Number.isSafeInteger(JSON.parse(call[1].body).sequence))).toBe(true);
    expect(mocks.request.mock.calls.filter(call => JSON.parse(call[1].body).sessionId === session).length).toBeGreaterThanOrEqual(4);
});

it('an old presence owner does not post to a newly selected different Mac', async () => {
    vi.useFakeTimers(); mocks.peer = 'peer:different-peer';
    stop = startCodelyncPresence(credentials, () => 'old-session', () => () => {});
    await vi.advanceTimersByTimeAsync(30000); expect(mocks.request).not.toHaveBeenCalled();
});

it('serializes foreground heartbeats and coalesces delayed entries to the latest current viewer', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ok: true, json: async () => ({ registered: true, available: false }) });
    let session = 'old-view', changed!: () => void;
    stop = startCodelyncPresence(credentials, () => session, callback => { changed = callback; return () => {}; });
    await vi.advanceTimersByTimeAsync(1); expect(mocks.request).toHaveBeenCalledTimes(1);
    session = 'intermediate'; changed(); session = 'current-view'; changed(); renewCodelyncPresence();
    await Promise.resolve(); expect(mocks.request).toHaveBeenCalledTimes(1);
    finish({ ok: true, json: async () => ({ registered: true, available: false }) });
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.request.mock.calls[1][1].body)).toMatchObject({ active: true, sessionId: 'current-view', sequence: expect.any(Number) });
});

it('replacing a presence owner aborts its old request and old screen callbacks cannot send again', async () => {
    vi.useFakeTimers();
    mocks.request.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ ok: true, json: async () => ({ registered: true, available: false }) });
    let oldCallback!: () => void;
    stop = startCodelyncPresence(credentials, () => 'old-view', callback => { oldCallback = callback; return () => {}; });
    await vi.advanceTimersByTimeAsync(1); const oldSignal = mocks.request.mock.calls[0][1].signal;
    stop = startCodelyncPresence(credentials, () => 'current-view', () => () => {});
    expect(oldSignal.aborted).toBe(true); oldCallback(); await vi.advanceTimersByTimeAsync(1);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.request.mock.calls[1][1].body).sessionId).toBe('current-view');
});

it('never calls /codelync/notifications/device or native push token APIs on Android even when invoked directly', async () => {
    mocks.os = 'android';
    config.codelyncPushEnvironment = 'production';
    expect(await syncCodelyncPushToken(credentials, false)).toBeNull();
    expect(await syncCodelyncPushToken(credentials, true)).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(Notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    config.codelyncPushEnvironment = undefined;
});

it('maintains Android <45s foreground presence leases every 15s, updates session changes, and reports backgrounding', async () => {
    vi.useFakeTimers();
    mocks.os = 'android';
    let appStateListener: (() => void) | undefined;
    mocks.appState.addEventListener.mockImplementationOnce((_event: string, listener: () => void) => {
        appStateListener = listener;
        return { remove: vi.fn() };
    });
    mocks.request.mockResolvedValue({ ok: true, json: async () => ({ registered: false, available: false }) });

    let session: string | null = 'android-session-1';
    let notifySessionChange!: () => void;
    stop = startCodelyncPresence(credentials, () => session, callback => {
        notifySessionChange = callback;
        return () => {};
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][0]).toBe('/codelync/notifications/presence');
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toMatchObject({
        active: true,
        sessionId: 'android-session-1',
        sequence: expect.any(Number),
    });

    // Advance 44 seconds (<45s Mac presence lease): initial + 15s + 30s = 3 heartbeats
    await vi.advanceTimersByTimeAsync(44_000);
    const leaseHeartbeats = mocks.request.mock.calls
        .filter(call => call[0] === '/codelync/notifications/presence')
        .map(call => JSON.parse(call[1].body));
    expect(leaseHeartbeats.length).toBeGreaterThanOrEqual(3);
    expect(leaseHeartbeats.every(item => item.active === true && item.sessionId === 'android-session-1')).toBe(true);

    // Session switch sends immediate presence update
    session = 'android-session-2';
    notifySessionChange();
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(mocks.request.mock.calls.at(-1)![1].body)).toMatchObject({
        active: true,
        sessionId: 'android-session-2',
    });

    // Backgrounding sends { active: false } and stops interval heartbeats while backgrounded
    mocks.appState.currentState = 'background';
    appStateListener?.();
    await vi.advanceTimersByTimeAsync(1);
    const afterBgCount = mocks.request.mock.calls.length;
    expect(JSON.parse(mocks.request.mock.calls.at(-1)![1].body)).toMatchObject({
        active: false,
        sessionId: 'android-session-2',
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.request.mock.calls.length).toBe(afterBgCount);
});
