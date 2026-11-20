import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ request: vi.fn(), connection: { peerId: 'fixture-peer' } }));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: vi.fn() }) } }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: {} }));
vi.mock('@/sync/codelyncConnection', () => ({ getConnectionSnapshot: () => mocked.connection, subscribeConnection: () => () => {} }));
vi.mock('livekit-client', () => ({
    Room: class { async setE2EEEnabled() {} async connect() {} async disconnect() {} on() {} },
    RoomEvent: { Disconnected: 'disconnected', Reconnecting: 'reconnecting', EncryptionError: 'encryption-error' }, setLogLevel: () => {},
}));
vi.mock('@livekit/react-native', () => ({
    registerGlobals: () => {}, RNKeyProvider: class { async setSharedKey() {} dispose() {} }, RNE2EEManager: class {},
}));
vi.mock('@/sync/remoteDesktop', () => ({
    DesktopRequestError: class extends Error { constructor(public code: string) { super(code); } },
    desktopBinding: (grant: { connectionId: string; generation: string; display: { geometry: string } }) => ({
        connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry,
    }), desktopRequest: mocked.request,
}));
import { DesktopRequestError, type DesktopView } from '@/sync/remoteDesktop';
import { useRemoteDesktop } from './useRemoteDesktop';

let renderer: ReturnType<typeof create> | undefined, controller: ReturnType<typeof useRemoteDesktop>;
const permissions = { screenRecording: true, accessibility: true, locked: false };
const display = { id: '1', name: 'Fixture display', width: 1440, height: 900, geometry: 'view-1' };
const grant = { version: 1, connectionId: 'fixture-connection', generation: 'fixture-generation', key: 'fixture-key', token: 'fixture-token',
    url: 'wss://fixture.example', hostIdentity: 'fixture-host', display, quality: { width: 1920, fps: 30 }, trackSid: 'track-1' };
let view: DesktopView;
function ownerRequest(action: string, body: { sequence?: number } = {}) {
    if (action === 'status') return { enabled: true, permissions };
    if (action === 'displays') return { displays: [display], permissions };
    if (action === 'join') return { ...grant, display: { ...display } };
    if (action === 'ready') return { ready: true };
    if (action === 'heartbeat') return view;
    if (action === 'space') return { ...view, spaceChanged: true };
    if (action === 'input') return { accepted: true, sequence: body.sequence };
    if (action === 'leave') return { stopped: true };
    throw Error('Unexpected fixture request');
}
function Harness() { controller = useRemoteDesktop(); return null; }
async function mountReady() {
    await act(async () => { renderer = create(React.createElement(Harness)); });
    await act(async () => { await controller.connect('1'); });
    await act(async () => { expect(await controller.videoReady('track-1')).toBe(true); });
    expect(controller.ready).toBe(true); mocked.request.mockClear();
}
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    view = { connected: true, capturing: true, geometry: 'view-1', trackSid: 'track-1', viewPending: false, permissions };
    mocked.request.mockReset(); mocked.request.mockImplementation(async (action, body) => ownerRequest(action, body));
});
afterEach(async () => { await act(async () => { renderer?.unmount(); }); renderer = undefined; vi.unstubAllGlobals(); });

describe('Spaces mobile readiness and recovery', () => {
    it('fences readiness during one Space operation and restores input only for its confirmed publication', async () => {
        await mountReady(); let finish!: (value: DesktopView & { spaceChanged: boolean }) => void;
        const space = new Promise<DesktopView & { spaceChanged: boolean }>(resolve => { finish = resolve; });
        mocked.request.mockImplementation(async (action, body) => action === 'space' ? space : ownerRequest(action, body));
        let navigation!: Promise<void>;
        act(() => { navigation = controller.navigateSpace('next'); });
        expect(controller.ready).toBe(false); expect(controller.busy).toBe(true);
        await act(async () => { expect(await controller.videoReady('track-1')).toBe(false); });
        expect(mocked.request.mock.calls.filter(([action]) => action === 'ready')).toHaveLength(0);
        expect(await controller.input({ action: 'key', key: 'escape', modifiers: [] })).toBe(false);
        view = { ...view, geometry: 'view-2', trackSid: 'track-2' };
        await act(async () => { finish({ ...view, spaceChanged: true }); await navigation; });
        expect(controller.ready).toBe(false); expect(controller.busy).toBe(false);
        expect(controller.grant?.trackSid).toBe('track-2');
        expect(await controller.videoReady('track-1')).toBe(false);
        await act(async () => { expect(await controller.videoReady('track-2')).toBe(true); });
        await act(async () => { expect(await controller.input({ action: 'key', key: 'escape', modifiers: [] })).toBe(true); });
        expect(mocked.request.mock.calls.filter(([action]) => action === 'space')).toHaveLength(1);
        const input = mocked.request.mock.calls.find(([action]) => action === 'input')!;
        expect(input[1]).toMatchObject({ geometry: 'view-2', sequence: 2 });
    });

    it('rejects a late same-track acknowledgement after the current view geometry advances', async () => {
        await mountReady(); let acknowledge!: (value: { ready: boolean }) => void;
        const oldReceipt = new Promise<{ ready: boolean }>(resolve => { acknowledge = resolve; });
        mocked.request.mockImplementationOnce(() => oldReceipt);
        let lateReady!: Promise<boolean>;
        act(() => { lateReady = controller.videoReady('track-1'); });
        view = { ...view, geometry: 'view-2' };
        await act(async () => { await controller.navigateSpace('previous'); });
        expect(controller.grant?.display.geometry).toBe('view-2'); expect(controller.ready).toBe(false);
        await act(async () => { acknowledge({ ready: true }); expect(await lateReady).toBe(false); });
        expect(controller.ready).toBe(false);
        await act(async () => { expect(await controller.videoReady('track-1')).toBe(true); });
        const receipts = mocked.request.mock.calls.filter(([action]) => action === 'ready');
        expect(receipts.map(([, body]) => body.geometry)).toEqual(['view-1', 'view-2']);
    });

    it.each(['desktop-space-shortcut-unavailable', 'desktop-operation-unknown'])('retains %s after unchanged-view recovery without replay', async code => {
        await mountReady();
        mocked.request.mockImplementation(async (action, body) => { if (action === 'space') throw new DesktopRequestError(code); return ownerRequest(action, body); });
        await act(async () => { await controller.navigateSpace('overview'); });
        expect(controller.notice).toBe(code); expect(controller.ready).toBe(false); expect(controller.busy).toBe(false);
        await act(async () => { expect(await controller.videoReady('track-1')).toBe(true); });
        expect(controller.notice).toBe(code); expect(controller.error).toBeNull(); expect(controller.ready).toBe(true);
        expect(mocked.request.mock.calls.filter(([action]) => action === 'space')).toHaveLength(1);
        expect(mocked.request.mock.calls.filter(([action]) => action === 'heartbeat')).toHaveLength(1);
    });

    it('ignores a retired input HTTP failure while Spaces installs a new publication and input queue', async () => {
        await mountReady(); let rejectOld!: (error: Error) => void, finishSpace!: (value: DesktopView & { spaceChanged: boolean }) => void;
        const oldInput = new Promise<never>((_, reject) => { rejectOld = reject; });
        const space = new Promise<DesktopView & { spaceChanged: boolean }>(resolve => { finishSpace = resolve; });
        mocked.request.mockImplementation(async (action, body) => {
            if (action === 'input' && body.sequence === 1) return oldInput;
            if (action === 'space') return space;
            return ownerRequest(action, body);
        });
        let pendingInput!: Promise<boolean>, navigation!: Promise<void>;
        act(() => { pendingInput = controller.input({ action: 'key', key: 'escape', modifiers: [] }); });
        act(() => { navigation = controller.navigateSpace('next'); });
        await act(async () => { rejectOld(new DesktopRequestError('desktop-input-replayed')); expect(await pendingInput).toBe(false); });
        expect(controller.grant?.connectionId).toBe('fixture-connection'); expect(controller.busy).toBe(true);
        expect(controller.error).toBeNull(); expect(mocked.request.mock.calls.filter(([action]) => action === 'leave')).toHaveLength(0);
        view = { ...view, geometry: 'view-2', trackSid: 'track-2' };
        await act(async () => { finishSpace({ ...view, spaceChanged: true }); await navigation; });
        await act(async () => { expect(await controller.videoReady('track-2')).toBe(true); });
        await act(async () => { expect(await controller.input({ action: 'key', key: 'escape', modifiers: [] })).toBe(true); });
        expect(controller.ready).toBe(true); expect(controller.grant?.display.geometry).toBe('view-2');
        expect(mocked.request.mock.calls.filter(([action]) => action === 'space')).toHaveLength(1);
        expect(mocked.request.mock.calls.filter(([action]) => action === 'leave')).toHaveLength(0);
        expect(mocked.request.mock.calls.filter(([action]) => action === 'input').map(([, body]) => body.sequence)).toEqual([1, 3]);
    });
});

describe('Virtual Phone Screen and Phase 2 window controls', () => {
    const virtualDisplay = {
        id: 'virtual',
        name: 'Phone Screen',
        kind: 'virtual' as const,
        width: 1080,
        height: 2160,
        logicalWidth: 540,
        logicalHeight: 1080,
        geometry: 'v-1',
    };

    it('HOOK-01: tracks isVirtualDisplay and forwards viewport only for virtual connect and switchDisplay', async () => {
        mocked.request.mockImplementation(async (action, body) => {
            if (action === 'status') return { enabled: true, permissions };
            if (action === 'displays') return { displays: [display, virtualDisplay], permissions, virtualDisplaySupported: true };
            if (action === 'join') return { ...grant, display: body?.displayId === 'virtual' ? { ...virtualDisplay } : { ...display }, trackSid: 'track-v1' };
            if (action === 'display') return { display: body?.displayId === 'virtual' ? { ...virtualDisplay, geometry: 'v-3' } : { ...display, geometry: 'p-2' }, trackSid: body?.displayId === 'virtual' ? 'track-v3' : 'track-p2' };
            if (action === 'ready') return { ready: true };
            if (action === 'leave') return { stopped: true };
            return ownerRequest(action, body);
        });

        await act(async () => { renderer = create(React.createElement(Harness)); });
        expect(controller.virtualDisplaySupported).toBe(true);
        expect(controller.isVirtualDisplay).toBe(false);
        expect(mocked.request.mock.calls.filter(([action]) => action === 'windows')).toHaveLength(0);

        act(() => { controller.selectDisplay('virtual'); });
        expect(controller.isVirtualDisplay).toBe(true);

        await act(async () => { await controller.connect('virtual', { width: 393, height: 759 }); });
        expect(controller.isVirtualDisplay).toBe(true);
        const joinCall = mocked.request.mock.calls.find(([action]) => action === 'join')!;
        expect(joinCall[1]).toEqual({
            displayId: 'virtual',
            quality: { width: 1920, fps: 30 },
            viewport: { width: 393, height: 759 },
        });

        await act(async () => { expect(await controller.videoReady('track-v1')).toBe(true); });
        await act(async () => { await controller.switchDisplay('1', { width: 393, height: 759 }); });
        expect(controller.isVirtualDisplay).toBe(false);
        const switchToPhysical = mocked.request.mock.calls.filter(([action]) => action === 'display')[0]!;
        expect(switchToPhysical[1]).not.toHaveProperty('viewport');
        expect(switchToPhysical[1]).toMatchObject({ displayId: '1', geometry: 'v-1' });

        await act(async () => { await controller.switchDisplay('virtual', { width: 393, height: 759 }); });
        expect(controller.isVirtualDisplay).toBe(true);
        const switchToVirtual = mocked.request.mock.calls.filter(([action]) => action === 'display')[1]!;
        expect(switchToVirtual[1]).toMatchObject({
            displayId: 'virtual',
            geometry: 'p-2',
            viewport: { width: 393, height: 759 },
        });
    });

    it('HOOK-02: syncs full upshifted DesktopDisplay dimensions in adoptView and fences input until new trackSid is ready', async () => {
        const upshiftedDisplay = {
            id: 'virtual',
            name: 'Phone Screen',
            kind: 'virtual' as const,
            width: 1520,
            height: 3040,
            logicalWidth: 760,
            logicalHeight: 1520,
            geometry: 'v-2',
        };
        mocked.request.mockImplementation(async (action, body) => {
            if (action === 'status') return { enabled: true, permissions };
            if (action === 'displays') return { displays: [display, virtualDisplay], permissions, virtualDisplaySupported: true };
            if (action === 'join') return { ...grant, display: { ...virtualDisplay }, trackSid: 'track-1' };
            if (action === 'ready') return { ready: true };
            if (action === 'window') {
                return {
                    display: upshiftedDisplay,
                    geometry: 'v-2',
                    trackSid: 'track-2',
                    viewPending: false,
                    activeWindowId: '123:456',
                    upshifted: true,
                };
            }
            if (action === 'input') return { accepted: true, sequence: body.sequence };
            if (action === 'leave') return { stopped: true };
            return ownerRequest(action, body);
        });

        await act(async () => { renderer = create(React.createElement(Harness)); });
        await act(async () => { await controller.connect('virtual', { width: 393, height: 759 }); });
        await act(async () => { expect(await controller.videoReady('track-1')).toBe(true); });

        await act(async () => { expect(await controller.fillWindow('123:456')).toBe(true); });
        expect(controller.grant?.display).toEqual(upshiftedDisplay);
        expect(controller.grant?.trackSid).toBe('track-2');
        expect(controller.activeWindowId).toBe('123:456');
        expect(controller.ready).toBe(false);
        expect(await controller.input({ action: 'scroll', deltaY: 20, x: 0.5, y: 0.5 })).toBe(false);
        await act(async () => { expect(await controller.videoReady('track-1')).toBe(false); });
        await act(async () => { expect(await controller.videoReady('track-2')).toBe(true); });
        expect(controller.ready).toBe(true);
        await act(async () => { expect(await controller.input({ action: 'scroll', deltaY: 20, x: 0.5, y: 0.5 })).toBe(true); });
        const inputCall = mocked.request.mock.calls.find(([action]) => action === 'input')!;
        expect(inputCall[1]).toMatchObject({ geometry: 'v-2', sequence: 2 });
    });

    it('HOOK-03: executes refreshWindows, fillWindow and restoreWindow with monotonic sequence reservation', async () => {
        const windowRows = [
            { id: '123:456', pid: 123, windowId: 456, appName: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'Workspace', bounds: { x: 0, y: 0, width: 1200, height: 800 }, minimized: false, onVirtualDisplay: false },
        ];
        let resolveWindows!: (val: { windows: typeof windowRows; activeWindowId: string | null }) => void;
        const windowsPromise = new Promise<{ windows: typeof windowRows; activeWindowId: string | null }>(resolve => { resolveWindows = resolve; });

        mocked.request.mockImplementation(async (action, body) => {
            if (action === 'status') return { enabled: true, permissions };
            if (action === 'displays') return { displays: [virtualDisplay], permissions, virtualDisplaySupported: true };
            if (action === 'join') return { ...grant, display: { ...virtualDisplay }, trackSid: 'track-1' };
            if (action === 'ready') return { ready: true };
            if (action === 'windows') return windowsPromise;
            if (action === 'window' && body.mode === 'fill') {
                return { display: { ...virtualDisplay, geometry: 'v-2' }, geometry: 'v-2', trackSid: 'track-2', viewPending: false, activeWindowId: '123:456', upshifted: false };
            }
            if (action === 'window' && body.mode === 'restore') {
                return { display: { ...virtualDisplay, geometry: 'v-3' }, geometry: 'v-3', trackSid: 'track-3', viewPending: false, activeWindowId: null, upshifted: false };
            }
            if (action === 'input') return { accepted: true, sequence: body.sequence };
            if (action === 'leave') return { stopped: true };
            return ownerRequest(action, body);
        });

        await act(async () => { renderer = create(React.createElement(Harness)); });
        await act(async () => { await controller.connect('virtual', { width: 393, height: 759 }); });
        await act(async () => { expect(await controller.videoReady('track-1')).toBe(true); });
        mocked.request.mockClear();

        let pendingList!: Promise<void>;
        act(() => { pendingList = controller.refreshWindows(); });
        expect(controller.windowsLoading).toBe(true);
        await act(async () => { resolveWindows({ windows: windowRows, activeWindowId: null }); await pendingList; });
        expect(controller.windowsLoading).toBe(false);
        expect(controller.windows).toHaveLength(1);
        expect(mocked.request.mock.calls.find(([action]) => action === 'windows')?.[1]).toEqual({ connectionId: 'fixture-connection' });

        await act(async () => { expect(await controller.input({ action: 'key', key: 'tab', modifiers: [] })).toBe(true); });
        await act(async () => { expect(await controller.fillWindow('123:456')).toBe(true); });
        expect(controller.ready).toBe(false);
        expect(controller.activeWindowId).toBe('123:456');
        expect(controller.windows[0]?.onVirtualDisplay).toBe(true);
        await act(async () => { expect(await controller.restoreWindow()).toBe(false); });
        await act(async () => { expect(await controller.videoReady('track-2')).toBe(true); });

        await act(async () => { expect(await controller.restoreWindow()).toBe(true); });
        expect(controller.activeWindowId).toBeNull();
        expect(controller.windows[0]?.onVirtualDisplay).toBe(false);
        await act(async () => { expect(await controller.videoReady('track-3')).toBe(true); });

        const windowCalls = mocked.request.mock.calls.filter(([action]) => action === 'window');
        expect(windowCalls.map(([, body]) => ({ mode: body.mode, sequence: body.sequence, windowId: body.windowId }))).toEqual([
            { mode: 'fill', sequence: 2, windowId: '123:456' },
            { mode: 'restore', sequence: 3, windowId: undefined },
        ]);
    });

    it.each([
        'desktop-window-unavailable',
        'desktop-window-unresponsive',
        'desktop-restore-persist-failed',
        'desktop-accessibility-required',
        'desktop-virtual-display-required',
        'desktop-operation-unknown',
    ])('HOOK-04: retains %s notice across recoverView and videoReady without replaying reserved sequence, and clears windows on physical switch/disconnect', async code => {
        const heartbeatDisplay = { ...virtualDisplay, width: 1200, height: 2400, logicalWidth: 600, logicalHeight: 1200, geometry: 'v-recovered' };
        mocked.request.mockImplementation(async (action, body) => {
            if (action === 'status') return { enabled: true, permissions };
            if (action === 'displays') return { displays: [display, virtualDisplay], permissions, virtualDisplaySupported: true };
            if (action === 'join') return { ...grant, display: { ...virtualDisplay }, trackSid: 'track-1' };
            if (action === 'ready') return { ready: true };
            if (action === 'windows') return { windows: [{ id: '10:20', pid: 10, windowId: 20, appName: 'Terminal', bundleId: 'com.apple.Terminal', title: 'zsh', bounds: { x: 0, y: 0, width: 800, height: 600 }, minimized: false, onVirtualDisplay: true }], activeWindowId: '10:20' };
            if (action === 'window') throw new DesktopRequestError(code);
            if (action === 'heartbeat') return { connected: true, capturing: true, geometry: 'v-recovered', trackSid: 'track-1', viewPending: false, permissions, display: heartbeatDisplay, activeWindowId: '10:20' };
            if (action === 'display') return { display: { ...display, geometry: 'p-1' }, trackSid: 'track-p1' };
            if (action === 'input') return { accepted: true, sequence: body.sequence };
            if (action === 'leave') return { stopped: true };
            return ownerRequest(action, body);
        });

        await act(async () => { renderer = create(React.createElement(Harness)); });
        await act(async () => { await controller.connect('virtual', { width: 393, height: 759 }); });
        await act(async () => { expect(await controller.videoReady('track-1')).toBe(true); });
        await act(async () => { await controller.refreshWindows(); });
        expect(controller.windows).toHaveLength(1);
        expect(controller.activeWindowId).toBe('10:20');
        mocked.request.mockClear();

        await act(async () => { expect(await controller.fillWindow('10:20')).toBe(false); });
        expect(controller.notice).toBe(code);
        expect(controller.error).toBeNull();
        expect(controller.grant?.display).toEqual(heartbeatDisplay);
        expect(mocked.request.mock.calls.filter(([action]) => action === 'window')).toHaveLength(1);
        expect(mocked.request.mock.calls.filter(([action]) => action === 'heartbeat')).toHaveLength(1);

        await act(async () => { expect(await controller.videoReady('track-1')).toBe(true); });
        expect(controller.notice).toBe(code);
        expect(controller.ready).toBe(true);

        await act(async () => { expect(await controller.input({ action: 'key', key: 'escape', modifiers: [] })).toBe(true); });
        const nextInput = mocked.request.mock.calls.find(([action]) => action === 'input')!;
        expect(nextInput[1]).toMatchObject({ sequence: 2, geometry: 'v-recovered' });

        await act(async () => { await controller.switchDisplay('1'); });
        expect(controller.windows).toEqual([]);
        expect(controller.activeWindowId).toBeNull();

        await act(async () => { await controller.disconnect(); });
        expect(controller.windows).toEqual([]);
        expect(controller.activeWindowId).toBeNull();
    });
});
