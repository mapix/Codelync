import nacl from 'tweetnacl';
import { afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('expo-crypto', () => ({ getRandomBytes: () => new Uint8Array(24).fill(7) }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: vi.fn() } }));
vi.mock('./peerNetwork', () => ({ peerAuthorization: vi.fn(() => 'Codelync fixture'), decodePeerResponse: vi.fn((_peer: unknown, body: unknown) => body) }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://paired.example' }));
import { TokenStorage } from '@/auth/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { DesktopRequestError, desktopPoint, desktopRequest, isVirtualDesktopDisplay, resolvePortraitSafeViewport } from './remoteDesktop';
import { DesktopInputQueue, DesktopInputQueueError } from './desktopInputQueue';

describe('desktop coordinates', () => {
    it('rejects letterbox taps and maps video corners on a portrait phone', () => {
        const viewport = { width: 400, height: 800 }, display = { width: 1920, height: 1080 };
        expect(desktopPoint(100, 10, viewport, display)).toBeNull();
        expect(desktopPoint(0, 287.5, viewport, display)).toEqual({ x: 0, y: 0 });
        expect(desktopPoint(400, 512.5, viewport, display)).toEqual({ x: 1, y: 1 });
    });
    it('reverses zoom and pan before delivering normalized pointer input', () => {
        expect(desktopPoint(250, 360, { width: 400, height: 800 }, { width: 1920, height: 1080 }, 2, { x: 50, y: -40 })).toEqual({ x: 0.5, y: 0.5 });
        expect(desktopPoint(0, 0, { width: 0, height: 0 }, { width: 1920, height: 1080 })).toBeNull();
    });
});

describe('desktop input ordering', () => {
    it('coalesces queued moves while preserving mouse down and up', async () => {
        let release!: () => void; const first = new Promise<void>(resolve => { release = resolve; });
        const dispatch = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
        const queue = new DesktopInputQueue(dispatch, vi.fn());
        const down = queue.send({ action: 'pointer', phase: 'down', x: 0, y: 0 });
        const move1 = queue.send({ action: 'pointer', phase: 'move', x: 0.1, y: 0.1 });
        const move2 = queue.send({ action: 'pointer', phase: 'move', x: 0.2, y: 0.2 });
        const up = queue.send({ action: 'pointer', phase: 'up', x: 0.2, y: 0.2 });
        release(); await Promise.all([down, move1, move2, up]);
        expect(dispatch.mock.calls.map(([value]) => value.phase)).toEqual(['down', 'move', 'up']);
        expect(dispatch.mock.calls[1][0].x).toBe(0.2);
    });
    it('drops every pending action after an unknown outcome without replay', async () => {
        const dispatch = vi.fn().mockRejectedValue(new Error('unknown')), failed = vi.fn();
        const queue = new DesktopInputQueue(dispatch, failed);
        await Promise.all([queue.send({ action: 'text', text: 'hello' }), queue.send({ action: 'key', key: 'enter', modifiers: [] })]);
        expect(dispatch).toHaveBeenCalledTimes(1); expect(failed).toHaveBeenCalledTimes(1);
        expect(await queue.send({ action: 'key', key: 'enter', modifiers: [] })).toBe(false);
    });
    it('coalesces slow same-direction scrolls without crossing direction or text boundaries', async () => {
        let release!: () => void; const first = new Promise<void>(resolve => { release = resolve; });
        const dispatch = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined), failed = vi.fn();
        const queue = new DesktopInputQueue(dispatch, failed);
        const down = queue.send({ action: 'pointer', phase: 'down', x: 0, y: 0 });
        const forward = Array.from({ length: 32 }, () => queue.send({ action: 'scroll', deltaY: 10 }));
        const backward = [queue.send({ action: 'scroll', deltaY: -50 }), queue.send({ action: 'scroll', deltaY: -100 })];
        const text = queue.send({ action: 'text', text: '中文' });
        const next = [queue.send({ action: 'scroll', deltaY: 30 }), queue.send({ action: 'scroll', deltaY: 40 })];
        const up = queue.send({ action: 'pointer', phase: 'up', x: 0, y: 0 });
        expect(await forward[0]).toBe(false); expect(failed).not.toHaveBeenCalled();
        release(); await Promise.all([down, ...forward, ...backward, text, ...next, up]);
        expect(dispatch.mock.calls.map(([input]) => input)).toEqual([
            { action: 'pointer', phase: 'down', x: 0, y: 0 }, { action: 'scroll', deltaY: 320 },
            { action: 'scroll', deltaY: -150 }, { action: 'text', text: '中文' },
            { action: 'scroll', deltaY: 70 }, { action: 'pointer', phase: 'up', x: 0, y: 0 },
        ]);
    });
    it('preserves the 1200 scroll limit and closes unknown or saturated input without replay', async () => {
        let release!: () => void; const first = new Promise<void>(resolve => { release = resolve; });
        const dispatch = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
        const queue = new DesktopInputQueue(dispatch, vi.fn());
        const hold = queue.send({ action: 'key', key: 'tab', modifiers: [] });
        const scrolls = [800, 400, 1, 1199, -1200, -1].map(deltaY => queue.send({ action: 'scroll', deltaY }));
        release(); await Promise.all([hold, ...scrolls]);
        expect(dispatch.mock.calls.slice(1).map(([input]) => input.deltaY)).toEqual([1200, 1200, -1200, -1]);

        const unknownDispatch = vi.fn().mockRejectedValue(new Error('desktop-operation-unknown'));
        const unknown = new DesktopInputQueue(unknownDispatch, vi.fn());
        await Promise.all([unknown.send({ action: 'scroll', deltaY: 1200 }), unknown.send({ action: 'scroll', deltaY: 1 }),
            unknown.send({ action: 'key', key: 'enter', modifiers: [] })]);
        expect(unknownDispatch).toHaveBeenCalledTimes(1);
        expect(await unknown.send({ action: 'text', text: 'no replay' })).toBe(false);

        let finish!: () => void; const slow = new Promise<void>(resolve => { finish = resolve; });
        const saturatedDispatch = vi.fn(() => slow), failed = vi.fn(), saturated = new DesktopInputQueue(saturatedDispatch, failed);
        const running = saturated.send({ action: 'pointer', phase: 'down', x: 0, y: 0 });
        const backlog = Array.from({ length: 17 }, () => saturated.send({ action: 'key', key: 'tab', modifiers: [] }));
        expect(failed).toHaveBeenCalledTimes(1);
        expect(failed.mock.calls[0][0]).toBeInstanceOf(DesktopInputQueueError);
        expect(failed.mock.calls[0][0].code).toBe('desktop-input-busy');
        finish(); expect((await Promise.all([running, ...backlog])).every(accepted => accepted === false)).toBe(true);
        expect(saturatedDispatch).toHaveBeenCalledTimes(1);
    });
    it('SYNC-05: preserves initial scroll (x, y) anchor across coalesced packets without crossing sign flips or 1200 bounds', async () => {
        let release!: () => void;
        const holdPromise = new Promise<void>(resolve => { release = resolve; });
        const dispatch = vi.fn().mockImplementationOnce(() => holdPromise).mockResolvedValue(undefined);
        const queue = new DesktopInputQueue(dispatch, vi.fn());
        const firstInFlight = queue.send({ action: 'pointer', phase: 'down', x: 0.1, y: 0.1 });
        const s1 = queue.send({ action: 'scroll', deltaY: 700, x: 0.25, y: 0.4 });
        const s2 = queue.send({ action: 'scroll', deltaY: 400, x: 0.25, y: 0.8 });
        const s3 = queue.send({ action: 'scroll', deltaY: 300, x: 0.3, y: 0.9 });
        const s4 = queue.send({ action: 'scroll', deltaY: -200, x: 0.6, y: 0.5 });
        const s5 = queue.send({ action: 'scroll', deltaY: 50 });
        const s6 = queue.send({ action: 'scroll', deltaY: 70, x: 0.9, y: 0.9 });
        release();
        await Promise.all([firstInFlight, s1, s2, s3, s4, s5, s6]);
        expect(dispatch.mock.calls.slice(1).map(([item]) => item)).toEqual([
            { action: 'scroll', deltaY: 1100, x: 0.25, y: 0.4 },
            { action: 'scroll', deltaY: 300, x: 0.3, y: 0.9 },
            { action: 'scroll', deltaY: -200, x: 0.6, y: 0.5 },
            { action: 'scroll', deltaY: 120 },
        ]);
        expect(Object.keys(dispatch.mock.calls[4][0])).toEqual(['action', 'deltaY']);
    });
});

describe('portrait safe-area viewport resolution and window request semantics', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('SYNC-01: resolves Tier 1 live portrait safe-area metrics and preserves cachedPortrait while keyboard is open', () => {
        const live = resolvePortraitSafeViewport({
            window: { width: 393, height: 852 },
            insets: { top: 59, bottom: 34, left: 0, right: 0 },
            keyboardHeight: 0,
        });
        expect(live).toEqual({ width: 393, height: 759 });

        const withKeyboardOpen = resolvePortraitSafeViewport({
            window: { width: 393, height: 852 },
            insets: { top: 59, bottom: 34, left: 0, right: 0 },
            keyboardHeight: 336,
            cachedPortrait: { width: 393, height: 759 },
        });
        expect(withKeyboardOpen).toEqual({ width: 393, height: 759 });

        const fromLandscapeWithCache = resolvePortraitSafeViewport({
            window: { width: 852, height: 393 },
            insets: { top: 0, bottom: 21, left: 59, right: 59 },
            cachedPortrait: { width: 393, height: 759 },
        });
        expect(fromLandscapeWithCache).toEqual({ width: 393, height: 759 });
    });

    it('SYNC-02: resolves Tier 2 initialWindowMetrics when locked in landscape and ignores landscape initialMetrics', () => {
        const fromInitial = resolvePortraitSafeViewport({
            window: { width: 852, height: 393 },
            insets: { top: 0, bottom: 21, left: 59, right: 59 },
            cachedPortrait: null,
            initialMetrics: {
                frame: { width: 393, height: 852 },
                insets: { top: 59, bottom: 34, left: 0, right: 0 },
            },
        });
        expect(fromInitial).toEqual({ width: 393, height: 759 });

        const ignoredLandscapeInitial = resolvePortraitSafeViewport({
            window: { width: 852, height: 393 },
            insets: { top: 0, bottom: 21, left: 59, right: 59 },
            cachedPortrait: null,
            initialMetrics: {
                frame: { width: 852, height: 393 },
                insets: { top: 0, bottom: 21, left: 59, right: 59 },
            },
            platformOS: 'android',
        });
        expect(ignoredLandscapeInitial).toEqual({ width: 393, height: 772 });
    });

    it('SYNC-03: resolves Tier 3 landscape-to-portrait inset fallback across iPhone, iPad and Android', () => {
        const iphone = resolvePortraitSafeViewport({
            window: { width: 852, height: 393 },
            insets: { top: 0, bottom: 21, left: 59, right: 59 },
            cachedPortrait: null,
            initialMetrics: null,
            platformOS: 'ios',
            isPad: false,
        });
        expect(iphone).toEqual({ width: 393, height: 759 });

        const ipad = resolvePortraitSafeViewport({
            window: { width: 1194, height: 834 },
            insets: { top: 24, bottom: 20, left: 0, right: 0 },
            cachedPortrait: null,
            initialMetrics: null,
            platformOS: 'ios',
            isPad: true,
        });
        expect(ipad).toEqual({ width: 834, height: 1150 });

        const android = resolvePortraitSafeViewport({
            window: { width: 915, height: 412 },
            insets: { top: 0, bottom: 24, left: 48, right: 0 },
            cachedPortrait: null,
            initialMetrics: null,
            platformOs: 'android',
        });
        expect(android).toEqual({ width: 412, height: 843 });
    });

    it('SYNC-04: clamps near-square foldables and extreme dimensions into finite integers in 100..10000 with height >= width', () => {
        const foldable = resolvePortraitSafeViewport({
            window: { width: 700, height: 710 },
            insets: { top: 48, bottom: 34, left: 0, right: 0 },
        });
        expect(foldable).toEqual({ width: 700, height: 700 });
        expect(foldable.height).toBeGreaterThanOrEqual(foldable.width);
        expect(Object.keys(foldable).sort()).toEqual(['height', 'width']);

        const tiny = resolvePortraitSafeViewport({
            window: { width: 20, height: 40 },
            insets: { top: 0, bottom: 0, left: 0, right: 0 },
        });
        expect(tiny).toEqual({ width: 100, height: 100 });

        const degenerate = resolvePortraitSafeViewport({
            window: { width: Number.NaN, height: 0 },
            insets: { top: 0, bottom: 0, left: 0, right: 0 },
        });
        expect(degenerate).toEqual({ width: 540, height: 1080 });

        const huge = resolvePortraitSafeViewport({
            window: { width: 15_000, height: 25_000 },
            insets: { top: 0, bottom: 0, left: 0, right: 0 },
        });
        expect(huge).toEqual({ width: 10_000, height: 10_000 });
        expect(isVirtualDesktopDisplay({ id: 'virtual' })).toBe(true);
        expect(isVirtualDesktopDisplay({ id: '2', kind: 'virtual' })).toBe(true);
        expect(isVirtualDesktopDisplay({ id: '1', kind: 'physical' })).toBe(false);
    });

    it('SYNC-06: assigns 25_000ms timeouts to windows/window and classifies uncertain window errors as desktop-operation-unknown', async () => {
        const mac = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(3));
        const phone = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(4));
        const credentials = {
            token: 'fixture-token',
            secret: 'fixture-secret',
            peer: {
                id: 'fixture-peer',
                key: encodeBase64(mac.publicKey, 'base64url'),
                channels: [{ id: 'local', kind: 'local' as const, url: 'https://paired.example' }],
                device: {
                    publicKey: encodeBase64(phone.publicKey, 'base64url'),
                    secretKey: encodeBase64(phone.secretKey, 'base64url'),
                },
            },
        };
        vi.mocked(TokenStorage.getCredentials).mockResolvedValue(credentials as never);

        const timeouts: number[] = [];
        const realSetTimeout = globalThis.setTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler, ms?: number) => {
            if (typeof ms === 'number') timeouts.push(ms);
            return realSetTimeout(fn, ms);
        }) as typeof setTimeout);

        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ windows: [], activeWindowId: null }) });
        await expect(desktopRequest('windows', { connectionId: 'conn-1' }, 'fixture-peer')).resolves.toEqual({ windows: [], activeWindowId: null });

        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ activeWindowId: '10:20' }) });
        await expect(desktopRequest('window', { connectionId: 'conn-1', geometry: 'v-1', sequence: 1, mode: 'fill', windowId: '10:20' }, 'fixture-peer')).resolves.toEqual({ activeWindowId: '10:20' });

        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ accepted: true, sequence: 1 }) });
        await desktopRequest('input', { connectionId: 'conn-1', geometry: 'v-1', sequence: 1, input: { action: 'scroll', deltaY: 10 } }, 'fixture-peer');

        expect(timeouts).toEqual([25_000, 25_000, 10_000]);

        const deterministicCodes = [
            'desktop-virtual-display-required',
            'desktop-window-unavailable',
            'desktop-window-unresponsive',
            'desktop-restore-persist-failed',
            'desktop-accessibility-required',
            'desktop-virtual-display-unavailable',
            'desktop-view-changed',
            'desktop-display-changed',
        ];
        for (const code of deterministicCodes) {
            fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: code }) });
            await expect(desktopRequest('window', { mode: 'restore', sequence: 2 }, 'fixture-peer')).rejects.toMatchObject({ code });
        }

        for (const status of [500, 502, 503]) {
            fetchMock.mockResolvedValueOnce({ ok: false, status, json: async () => ({ error: 'internal-host-timeout' }) });
            await expect(desktopRequest('window', { mode: 'restore', sequence: 3 }, 'fixture-peer')).rejects.toEqual(new DesktopRequestError('desktop-operation-unknown'));
        }

        fetchMock.mockRejectedValueOnce(new Error('network reset'));
        await expect(desktopRequest('window', { mode: 'fill', windowId: '10:20', sequence: 4 }, 'fixture-peer')).rejects.toEqual(new DesktopRequestError('desktop-operation-unknown'));

        fetchMock.mockRejectedValueOnce(new Error('network reset'));
        await expect(desktopRequest('windows', { connectionId: 'conn-1' }, 'fixture-peer')).rejects.toEqual(new DesktopRequestError('desktop-relay-unavailable'));
    });
});
