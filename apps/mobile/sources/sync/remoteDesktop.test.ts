import { describe, it, expect, vi } from 'vitest';
vi.mock('expo-crypto', () => ({ getRandomBytes: () => new Uint8Array(24) }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: vi.fn() } }));
vi.mock('./peerNetwork', () => ({ peerAuthorization: vi.fn(), decodePeerResponse: vi.fn() }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://paired.example' }));
import { desktopPoint } from './remoteDesktop';
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
});
