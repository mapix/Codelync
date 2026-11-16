import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
const rpc = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), recover: vi.fn(), nativeRecover: vi.fn(), sessions:{} as Record<string,Session> }));
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('@/sync/noninvasiveRpc', () => ({ runNoninvasiveRpc: rpc.read, runCodeLightModelRpc: rpc.write, recoverCodeLightModelRpc: rpc.recover, recoverCodeLightNativeModelRpc: rpc.nativeRecover }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/storage', () => ({ useSocketStatus: () => ({ status: 'connected' }), storage: { getState: () => ({ sessions: rpc.sessions }) } }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerConnected: () => true } }));
import { useCodeLightModelControls } from './useCodeLightModelControls';
function fixture(app = 'antigravity', child = true): Session {
    const hostId = app === 'codex' ? 'local' : 'local:' + app + ':' + 'a'.repeat(64);
    return { id: 'relay-' + app, metadata: { client: { id: 'noninvasive-bridge' }, bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null,
        source: { app, id: 'original-' + app, hostId, runtimeGeneration: 'owner', kind: 'session', protocol: app === 'claude-desktop' ? 'claude-desktop-native' : app === 'antigravity' ? 'antigravity-connect' : undefined,
            ...(app === 'claude-desktop' ? { appMode: 'code', nativeCollection: 'claude-code-sessions' } : {}) } },
        nativeSession: { isSubagent: child, parentId: child ? 'native-parent' : null }, capabilities: { readOnly: false, rpcMethods: ['codex-controls-read', 'codex-controls-update'] } } } as unknown as Session;
}
function models(session: Session) {
    session.metadata!.nativeControls = { model: { available: true, current: { model: 'native-A', reasoningEffort: 'low' },
        models: [{ id: 'native-A', label: 'Native A', reasoningEfforts: ['low'] }, { id: 'native-B', label: 'Native B', reasoningEfforts: ['low'] }] } };
    return session;
}
let controls!: ReturnType<typeof useCodeLightModelControls>;
function Probe({ session }: { session: Session }) { rpc.sessions[session.id]=session; controls = useCodeLightModelControls(session); return null; }
function mount(session: Session) { let root!: ReturnType<typeof create>; act(() => { root = create(React.createElement(Probe, { session })); }); return root; }
beforeEach(() => { vi.clearAllMocks();rpc.sessions={}; rpc.read.mockResolvedValue(undefined); rpc.write.mockResolvedValue(undefined); rpc.recover.mockResolvedValue(false); rpc.nativeRecover.mockResolvedValue({ confirmed: false }); });

it.each(['antigravity', 'codex', 'claude-desktop'])('does not read or update settings for an explicit readonly %s child', async app => {
    const session = fixture(app); rpc.read.mockRejectedValue(Error('Unsupported child settings read')); const root = mount(session);
    await act(async () => controls.refresh());
    expect(rpc.read).not.toHaveBeenCalled(); expect(rpc.write).not.toHaveBeenCalled();
    expect(controls.status).toBe('idle'); expect(controls.message).toBeNull(); expect(controls.enabled).toBe(false); expect(controls.canRefresh).toBe(false);
    expect(controls.currentModel).toBeNull(); act(() => root.unmount());
});
it('retains embedded readonly observed Claude values without fetching a child settings controller', async () => {
    const session = fixture('claude-desktop'); session.metadata!.nativeObservedModel = { version: 1, app: 'claude-desktop', nativeConversationId: session.metadata!.bridge!.source.id,
        hostId: session.metadata!.bridge!.source.hostId!, ownerGeneration: 'owner', readOnly: true, model: 'native-observed-model', effort: 'native-observed-effort' };
    const root = mount(session); await act(async () => controls.refresh());
    expect(controls.currentModel?.key).toBe('native-observed-model'); expect(controls.currentEffort?.key).toBe('native-observed-effort');
    expect(controls.showReadOnlyEffort).toBe(true); expect(controls.enabled).toBe(false); expect(rpc.read).not.toHaveBeenCalled(); expect(rpc.write).not.toHaveBeenCalled(); act(() => root.unmount());
});
it('does not promote old Codex child controller settings into readonly native observations', async () => {
    const session = models(fixture('codex')); const root = mount(session); await act(async () => { controls.refresh(); controls.selectModel({ key: 'native-B', name: 'Old child model' }); });
    expect(controls.currentModel).toBeNull(); expect(controls.currentEffort).toBeNull(); expect(controls.models).toEqual([]); expect(controls.enabled).toBe(false);
    expect(rpc.read).not.toHaveBeenCalled(); expect(rpc.write).not.toHaveBeenCalled(); act(() => root.unmount());
});
it('saved Desktop history never fetches current settings even with an old advertised read capability', async () => {
    const session = fixture('codex', false), source = session.metadata!.bridge!.source;
    source.runtimeGeneration = null; session.metadata!.bridge!.sourceStatus = 'history-only';
    session.metadata!.nativeSavedHistory = { app: 'codex', version: 1, available: true, readOnly: true, originator: 'Codex Desktop', nativeId: source.id,
        hostId: 'local', namespaceHash: 'a'.repeat(64), sourceStamp: 'b'.repeat(64), byteBoundary: { start: 1, end: 2, total: 3 } };
    const root = mount(session); await act(async () => controls.refresh()); expect(rpc.read).not.toHaveBeenCalled(); expect(controls.message).toBeNull(); act(() => root.unmount());
});
it('a permitted ordinary settings read failure uses reading copy and clears after a successful read', async () => {
    const session = fixture('codex', false); rpc.read.mockRejectedValue(Error('Owner read unavailable')); let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(Probe, { session })); });
    expect(controls.status).toBe('read-error'); expect(controls.message).toBe('codeLightModels.readFailed'); expect(rpc.write).not.toHaveBeenCalled();
    rpc.read.mockResolvedValue(undefined); await act(async () => controls.refresh()); expect(controls.message).toBeNull(); expect(controls.status).toBe('idle'); act(() => root.unmount());
});
it('a late ordinary read failure cannot create an error after navigating to a readonly child', async () => {
    let reject!: (reason: Error) => void; rpc.read.mockImplementation(() => new Promise((_, failure) => { reject = failure; }));
    const root = mount(fixture('codex', false)); act(() => root.update(React.createElement(Probe, { session: fixture('antigravity') })));
    await act(async () => reject(Error('Old session read failed'))); expect(controls.message).toBeNull(); expect(controls.status).toBe('idle'); expect(rpc.read).toHaveBeenCalledOnce(); act(() => root.unmount());
});
it('unknown update recovery keeps its exact original parameters after readonly transition, with no settings read or update replay', async () => {
    const session = models(fixture('codex', false)); rpc.write.mockRejectedValue(Error('Native reply not confirmed')); const root = mount(session);
    await act(async () => controls.selectModel(controls.models[1])); expect(controls.status).toBe('unknown');
    const originalParams = rpc.write.mock.calls[0][1]; const readonly = structuredClone(session); readonly.metadata!.nativeSession!.isSubagent = true;
    act(() => root.update(React.createElement(Probe, { session: readonly })));
    await act(async () => controls.refresh()); expect(controls.status).toBe('unknown'); expect(controls.message).toBe('codeLightModels.unconfirmed');
    expect(rpc.recover).toHaveBeenCalledExactlyOnceWith(session.id, originalParams); expect(rpc.read).not.toHaveBeenCalled(); expect(rpc.write).toHaveBeenCalledOnce();
    rpc.recover.mockResolvedValue(true); await act(async () => controls.refresh()); expect(controls.status).toBe('idle'); expect(rpc.write).toHaveBeenCalledOnce(); act(() => root.unmount());
});
it('an unknown update remains tied to its original session across child navigation and return', async () => {
    const session = models(fixture('codex', false)); rpc.write.mockRejectedValue(Error('Native reply not confirmed')); const root = mount(session);
    await act(async () => controls.selectModel(controls.models[1])); expect(controls.status).toBe('unknown');
    act(() => root.update(React.createElement(Probe, { session: fixture('antigravity') }))); expect(controls.status).toBe('idle'); expect(controls.message).toBeNull();
    act(() => root.update(React.createElement(Probe, { session }))); expect(controls.status).toBe('unknown'); expect(controls.message).toBe('codeLightModels.unconfirmed');
    expect(rpc.read).not.toHaveBeenCalled(); expect(rpc.write).toHaveBeenCalledOnce(); act(() => root.unmount());
});
it('a genuine mutation rejection retains write-specific copy when its follow-up read also fails', async () => {
    const session = models(fixture('codex', false)); rpc.write.mockRejectedValue(Error('Original setting rejected')); rpc.read.mockRejectedValue(Error('Follow-up read failed'));
    const root = mount(session); await act(async () => controls.selectModel(controls.models[1]));
    expect(controls.status).toBe('error'); expect(controls.message).toBe('codeLightModels.failed'); expect(rpc.write).toHaveBeenCalledOnce(); act(() => root.unmount());
});

it('an Antigravity child ignores old next-message staging and catalogue when there is no readonly native observation', async () => {
    const session = models(fixture('antigravity'));
    session.metadata!.nativeControls!.model.selectionMode = 'next-message'; session.metadata!.nativeControls!.model.selectionState = 'staged';
    const root = mount(session); await act(async () => controls.refresh());
    expect(controls.currentModel).toBeNull(); expect(controls.currentEffort).toBeNull(); expect(controls.models).toEqual([]);
    expect(controls.catalogReadable).toBe(false); expect(controls.observedCurrent).toBe(false); expect(controls.message).toBeNull();
    expect(rpc.read).not.toHaveBeenCalled(); expect(rpc.write).not.toHaveBeenCalled(); act(() => root.unmount());
});
