import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ peer: 'peer:original-peer', request: vi.fn(), url: 'http://192.0.2.10:9000', sequenceStore: new Map<string, string>(), appState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) } }));
vi.mock('expo-notifications', () => ({ getDevicePushTokenAsync: vi.fn() }));
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: mocks.appState }));
vi.mock('@/config', () => ({ config: { codeLightPushEnvironment: null } }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => mocks.url }));
vi.mock('./apiSocket', () => ({ apiSocket: { peerIdentity: () => mocks.peer, request: mocks.request } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async (key: string) => mocks.sequenceStore.get(key) ?? null, setItem: async (key: string, value: string) => { mocks.sequenceStore.set(key, value); } } }));
import { startCodeLightPresence, renewCodeLightPresence } from './codeLightNotifications';
let stop: (() => void) | undefined;
const credentials = { token: 'fixture-token', secret: 'fixture-secret', serverUrl: 'http://192.0.2.10:8000', peer: { id: 'original-peer' } } as any;
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); mocks.request.mockReset(); mocks.peer = 'peer:original-peer'; mocks.appState.currentState = 'active'; });

it('foreground session heartbeats use the current authenticated peer route after a same-Mac endpoint change without APNs', async () => {
    vi.useFakeTimers(); mocks.request.mockResolvedValue({ ok: true, json: async () => ({ registered: true, available: false }) });
    let session: string | null = null, changed!: () => void;
    stop = startCodeLightPresence(credentials, () => session, callback => { changed = callback; return () => {}; });
    await Promise.resolve(); session = 'actual-visible-session'; changed(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.request.mock.calls.some(call => call[0] === '/codelight/notifications/presence' && JSON.parse(call[1].body).sessionId === session && Number.isSafeInteger(JSON.parse(call[1].body).sequence))).toBe(true);
    expect(mocks.request.mock.calls.filter(call => JSON.parse(call[1].body).sessionId === session).length).toBeGreaterThanOrEqual(4);
});

it('an old presence owner does not post to a newly selected different Mac', async () => {
    vi.useFakeTimers(); mocks.peer = 'peer:different-peer';
    stop = startCodeLightPresence(credentials, () => 'old-session', () => () => {});
    await vi.advanceTimersByTimeAsync(30000); expect(mocks.request).not.toHaveBeenCalled();
});

it('serializes foreground heartbeats and coalesces delayed entries to the latest current viewer', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ok: true, json: async () => ({ registered: true, available: false }) });
    let session = 'old-view', changed!: () => void;
    stop = startCodeLightPresence(credentials, () => session, callback => { changed = callback; return () => {}; });
    await vi.advanceTimersByTimeAsync(1); expect(mocks.request).toHaveBeenCalledTimes(1);
    session = 'intermediate'; changed(); session = 'current-view'; changed(); renewCodeLightPresence();
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
    stop = startCodeLightPresence(credentials, () => 'old-view', callback => { oldCallback = callback; return () => {}; });
    await vi.advanceTimersByTimeAsync(1); const oldSignal = mocks.request.mock.calls[0][1].signal;
    stop = startCodeLightPresence(credentials, () => 'current-view', () => () => {});
    expect(oldSignal.aborted).toBe(true); oldCallback(); await vi.advanceTimersByTimeAsync(1);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.request.mock.calls[1][1].body).sessionId).toBe('current-view');
});
