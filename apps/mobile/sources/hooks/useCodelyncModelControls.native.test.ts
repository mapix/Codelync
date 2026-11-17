import * as React from 'react';
// @ts-expect-error The existing native renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), recover: vi.fn(), nativeRecover: vi.fn(), session: null as Session | null, connected: true }));
vi.mock('@/sync/noninvasiveRpc', () => ({ runNoninvasiveRpc: mocks.read, runCodelyncModelRpc: mocks.write, recoverCodelyncModelRpc: mocks.recover, recoverCodelyncNativeModelRpc: mocks.nativeRecover }));
vi.mock('@/sync/storage', () => ({ useSocketStatus: () => ({ status: mocks.connected ? 'connected' : 'error' }), storage: { getState: () => ({ sessions: mocks.session ? { [mocks.session.id]: mocks.session } : {} }) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerConnected: () => mocks.connected } }));
import { useCodelyncModelControls } from './useCodelyncModelControls';
function fixture() {
    const host = 'local:claude-desktop:' + 'a'.repeat(64);
    return { id: 'relay', metadata: { client: { id: 'noninvasive-bridge' }, nativeDesktopRuntimeGeneration: 'main', capabilities: { readOnly: false,
        rpcMethods: ['codex-controls-read', 'codex-controls-update'] }, bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null,
        source: { app: 'claude-desktop', appMode: 'code', nativeCollection: 'claude-code-sessions', protocol: 'claude-desktop-native', kind: 'session', id: 'native', hostId: host, runtimeGeneration: 'owner' } },
        nativeControls: { scope: { app: 'claude-desktop', appMode: 'code', nativeCollection: 'claude-code-sessions', nativeConversationId: 'native', hostId: host,
            ownerGeneration: 'owner', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli', settingsToken: 'a'.repeat(64) },
            compatibility: { app: 'claude-desktop', protocol: 'claude-desktop-native', supported: true }, model: { available: true, currentConfirmed: true, catalogAvailable: true, complete: true,
                current: { model: 'native-A', reasoningEffort: 'native-high' }, models: [{ id: 'native-A', label: 'Native A', reasoningEfforts: ['native-high'], defaultReasoningEffort: 'native-high', canUnsetReasoningEffort: false },
                    { id: 'native-B', label: 'Native B', reasoningEfforts: ['native-minimal'], defaultReasoningEffort: 'native-minimal', canUnsetReasoningEffort: false }] } } },
        agentState: { nativeQuery: { version: 1, app: 'claude-desktop', nativeConversationId: 'native', hostId: host, ownerGeneration: 'owner', queryToken: 'query',
            status: 'idle', canSend: false, canCancel: false, activeSendMode: 'unverified' } } } as unknown as Session;
}
beforeEach(() => { vi.clearAllMocks(); mocks.connected = true; mocks.write.mockResolvedValue(undefined); mocks.read.mockResolvedValue(undefined); mocks.recover.mockResolvedValue(false); mocks.nativeRecover.mockResolvedValue({ confirmed: false }); });
let controls!: ReturnType<typeof useCodelyncModelControls>;
function Probe({ session }: { session: Session }) { controls = useCodelyncModelControls(session); return null; }

it.each(['code', 'chat'] as const)('shows confirmed readonly native %s effort while setting writes and unset effort remain disabled', async mode => {
    const session = fixture(); session.metadata!.capabilities!.readOnly = true; session.metadata!.nativeControls!.model.available = false; mocks.session = session;
    session.metadata!.bridge!.source.appMode = mode; session.metadata!.nativeControls!.scope!.appMode = mode;
    session.metadata!.bridge!.source.nativeCollection = mode === 'code' ? 'claude-code-sessions' : 'local-agent-mode-sessions';
    session.metadata!.nativeControls!.scope!.nativeCollection = session.metadata!.bridge!.source.nativeCollection as 'claude-code-sessions' | 'local-agent-mode-sessions';
    let root!: ReturnType<typeof create>; act(() => { root = create(React.createElement(Probe, { session })); });
    expect(controls.models.map(x => x.key)).toEqual(['native-A', 'native-B']); expect(controls.currentModel?.key).toBe('native-A');
    expect(controls.efforts.map(x => x.key)).toEqual(['native-high']); expect(controls.enabled).toBe(false);
    expect(controls.currentEffort?.key).toBe('native-high'); expect(controls.showReadOnlyEffort).toBe(true); expect(controls.observedCurrent).toBe(false);
    await act(async () => controls.selectEffort(controls.efforts[0])); expect(mocks.write).not.toHaveBeenCalled();
    await act(async () => controls.selectModel(controls.models[1])); expect(mocks.write).not.toHaveBeenCalled(); act(() => root.unmount());
});
it('writes expected native scope and clamps effort without changing the owner displayed settings', async () => {
    const session = fixture(); mocks.session = session; let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Probe, { session })); });
    expect(controls.enabled).toBe(true);
    expect(controls.showReadOnlyEffort).toBe(false);
    const expectedScope = session.metadata!.nativeControls!.scope!, confirmedScope = { ...expectedScope, settingsToken: 'c'.repeat(64) };
    mocks.write.mockResolvedValue({ applied: true, settingsReadbackConfirmed: true, controls: { scope: confirmedScope, model: { current: { model: 'native-B', reasoningEffort: 'native-minimal' } } },
        nativeSettingsEvidence: { version: 1, expectedScope, confirmedScope, modelAckConfirmed: true, effortAckConfirmed: true, effectiveModel: 'native-B', effectiveReasoningEffort: 'native-minimal' } });
    await act(async () => controls.selectModel(controls.models[1]));
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith('relay', { model: 'native-B', reasoningEffort: 'native-minimal', expectedModel: 'native-A', expectedReasoningEffort: 'native-high', expectedScope: session.metadata!.nativeControls!.scope });
    expect(controls.currentModel?.key).toBe('native-A'); act(() => root.unmount());
});
it('fresh HTTP metadata cannot enable model/effort writes offline, and captured pickers recheck the live socket', async () => {
    const session = fixture(); mocks.session = session; let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Probe, { session })); });
    const oldModel = controls.selectModel, oldEffort = controls.selectEffort, choice = controls.models[1], effort = controls.efforts[0];
    mocks.connected = false;
    await act(async () => { oldModel(choice); oldEffort(effort); }); expect(mocks.write).not.toHaveBeenCalled();
    act(() => root.update(React.createElement(Probe, { session })));
    expect(controls.enabled).toBe(false); expect(controls.currentModel?.key).toBe('native-A'); expect(controls.currentEffort?.key).toBe('native-high'); expect(controls.showReadOnlyEffort).toBe(true);
    mocks.connected = true; act(() => root.update(React.createElement(Probe, { session })));
    expect(controls.enabled).toBe(true); expect(mocks.write).not.toHaveBeenCalled(); act(() => root.unmount());
});
it('rejects a captured picker click after live owner/query scope changes', async () => {
    const session = fixture(); mocks.session = session; let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Probe, { session })); }); const selected = controls.selectModel, model = controls.models[1];
    mocks.session = fixture(); mocks.session.agentState!.nativeQuery!.queryToken = 'new-query';
    await act(async () => selected(model)); expect(mocks.write).not.toHaveBeenCalled(); act(() => root.unmount());
});
it('uses a native resolved alias for the option label while preserving effective CAS state', async () => {
    const session = fixture(); session.metadata!.nativeControls!.model.models[0].id = 'default';
    session.metadata!.nativeControls!.model.models[0].label = 'Original default'; session.metadata!.nativeControls!.model.models[0].nativeResolvedModel = 'native-A';
    session.metadata!.nativeControls!.model.available = false; mocks.session = session; let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Probe, { session })); });
    expect(controls.currentModel?.name).toBe('Original default'); expect(session.metadata!.nativeControls!.model.current!.model).toBe('native-A');
    expect(controls.enabled).toBe(false); expect(mocks.write).not.toHaveBeenCalled(); act(() => root.unmount());
});
it('retains unknown across headers/reads until the same original scope receipt confirms', async () => {
    const session = fixture(); mocks.session = session; mocks.write.mockRejectedValue(Error('reply not confirmed')); let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(Probe, { session })); });
    await act(async () => controls.selectModel(controls.models[1])); expect(controls.status).toBe('unknown'); expect(mocks.read).not.toHaveBeenCalled();
    const newer = fixture(); newer.metadata!.nativeControls!.scope!.settingsToken = 'b'.repeat(64); mocks.session = newer;
    act(() => root.update(React.createElement(Probe, { session: newer })));
    expect(controls.status).toBe('unknown'); expect(controls.enabled).toBe(false);
    await act(async () => controls.refresh()); expect(controls.status).toBe('unknown');
    expect(mocks.nativeRecover.mock.calls[0][1].expectedScope.settingsToken).toBe('a'.repeat(64));
    mocks.nativeRecover.mockResolvedValue({ confirmed: true }); await act(async () => controls.refresh()); expect(controls.status).toBe('unknown');
    const expectedScope = session.metadata!.nativeControls!.scope!, confirmedScope = { ...expectedScope, settingsToken: 'd'.repeat(64) };
    mocks.nativeRecover.mockResolvedValue({ confirmed: true, pending: { commandId: 'original' }, result: { applied: true, settingsReadbackConfirmed: true,
        controls: { scope: confirmedScope, model: { current: { model: 'native-B', reasoningEffort: 'native-minimal' } } }, nativeSettingsEvidence: { version: 1,
            expectedScope, confirmedScope, modelAckConfirmed: true, effortAckConfirmed: true, effectiveModel: 'native-B', effectiveReasoningEffort: 'native-minimal' } } });
    await act(async () => controls.refresh()); expect(controls.status).toBe('idle');
    expect(mocks.write).toHaveBeenCalledOnce(); act(() => root.unmount());
});

it.each(['code', 'chat'] as const)('reads native %s settings with the commandId-only read contract, preserving expectedScope for mutations', async mode => {
    const session = fixture();
    session.metadata!.bridge!.source.appMode = mode; session.metadata!.nativeControls!.scope!.appMode = mode;
    const collection = mode === 'code' ? 'claude-code-sessions' : 'local-agent-mode-sessions';
    session.metadata!.bridge!.source.nativeCollection = collection; session.metadata!.nativeControls!.scope!.nativeCollection = collection;
    session.metadata!.nativeControls!.model.catalogAvailable = false; mocks.session = session;
    mocks.read.mockImplementation(async (_id, method, params) => {
        expect(method).toBe('codex-controls-read');
        // The durable RPC journal adds only commandId to this object. The native
        // connector rejects every other settings-read parameter before dispatch.
        expect(params).toEqual({}); return undefined;
    });
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(Probe, { session })); });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith('relay', 'codex-controls-read', {});
    await act(async () => controls.refresh());
    expect(mocks.read).toHaveBeenCalledTimes(2); expect(mocks.write).not.toHaveBeenCalled();
    expect(controls.scope).toEqual(session.metadata!.nativeControls!.scope); act(() => root.unmount());
});

it('keeps unconfirmed Cowork settings scope unavailable without sending a settings read', async () => {
    const session = fixture(); session.metadata!.bridge!.source.appMode = 'cowork';
    session.metadata!.bridge!.source.nativeCollection = 'local-agent-mode-sessions';
    (session.metadata!.nativeControls!.scope as any).appMode = 'cowork';
    session.metadata!.nativeControls!.scope!.nativeCollection = 'local-agent-mode-sessions';
    session.metadata!.nativeControls!.model.catalogAvailable = false; mocks.session = session;
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(Probe, { session })); });
    await act(async () => controls.refresh());
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(controls.scope).toBeNull();
    expect(controls.message).toBeNull(); act(() => root.unmount());
});
