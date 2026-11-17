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
