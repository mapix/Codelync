import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn(), recover: vi.fn(), connected: true }));
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('@/sync/noninvasiveRpc', () => ({ runNoninvasiveRpc: rpc.read, runCodelyncModelRpc: rpc.update, recoverCodelyncModelRpc: rpc.recover, recoverCodelyncNativeModelRpc: rpc.recover }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/storage', () => ({ useSocketStatus: () => ({ status: rpc.connected ? 'connected' : 'error' }), storage: { getState: () => ({ sessions: {} }) } }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerConnected: () => rpc.connected } }));
import { useCodelyncModelControls } from './useCodelyncModelControls';

it('displays only bound native observation while unverified model/effort RPCs and catalogs stay unavailable', () => {
    const hostId = 'local:claude-desktop:' + 'b'.repeat(64);
    const session = { id: 'relay', metadata: { client: { id: 'noninvasive-bridge' }, bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null,
        source: { app: 'claude-desktop', id: 'original', hostId, runtimeGeneration: 'owner', kind: 'session', protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions' } },
        capabilities: { rpcMethods: ['codex-controls-read'] },
        nativeObservedModel: { version: 1, app: 'claude-desktop', nativeConversationId: 'original', hostId, ownerGeneration: 'owner', readOnly: true, model: 'native-model', effort: 'high' },
        nativeControls: { model: { available: true, current: { model: 'codex-default', reasoningEffort: 'low' }, models: [] } } } } as any;
    let result!: ReturnType<typeof useCodelyncModelControls>;
    function Probe({ value }: { value: any }) { result = useCodelyncModelControls(value); return null; }
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(Probe, { value: session })); });
    expect(result.currentModel?.name).toBe('native-model'); expect(result.currentEffort?.name).toBe('high');
    expect(result.showReadOnlyEffort).toBe(true);
    expect(result.enabled).toBe(false); expect(result.models).toEqual([]); expect(result.efforts).toEqual([]);
    expect(rpc.read).not.toHaveBeenCalled(); expect(rpc.update).not.toHaveBeenCalled();
    act(() => { renderer.update(React.createElement(Probe, { value: { ...session, metadata: { ...session.metadata, nativeObservedModel: undefined } } })); });
    expect(result.currentModel).toBeNull(); expect(result.currentEffort).toBeNull();
    expect(result.showReadOnlyEffort).toBe(false);
    act(() => renderer.unmount());
});
