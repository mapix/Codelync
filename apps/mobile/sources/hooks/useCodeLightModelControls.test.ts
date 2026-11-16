import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
const mocks = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn(), recover: vi.fn(), connected: true, sessions:{} as Record<string,Session> }));
vi.mock('@/sync/noninvasiveRpc', () => ({ runCodeLightModelRpc: mocks.write, recoverCodeLightModelRpc: mocks.recover, recoverCodeLightNativeModelRpc: mocks.recover }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerConnected: () => mocks.connected, sessionRPC: mocks.read } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/storage', () => ({ useSocketStatus: () => ({ status: mocks.connected ? 'connected' : 'error' }), storage: { getState: () => ({ sessions: mocks.sessions }) } }));
import { useCodeLightModelControls } from './useCodeLightModelControls';
const fixture = { id: 'relay', metadata: { client: { id: 'noninvasive-bridge' }, bridge: { controlMode: 'session', sourceStatus: 'connected', source: { app: 'codex', id: 'native', hostId: 'local', kind: 'session', runtimeGeneration: 'owner' } }, capabilities: { rpcMethods: ['codex-controls-read', 'codex-controls-update'] }, nativeControls: { model: { available: true,
    current: { model: 'a', reasoningEffort: 'low', modelProvider: 'fixture' }, models: [{ id: 'a', label: 'Model A', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }, { id: 'b', label: 'Model B', reasoningEfforts: ['medium', 'high'], defaultReasoningEffort: 'medium' }] } } } } as unknown as Session;
let controls!: ReturnType<typeof useCodeLightModelControls>;
function Harness() { mocks.sessions[fixture.id]??=fixture; controls = useCodeLightModelControls(fixture); return null; }
it('writes the original settings with compare conditions and leaves displayed state owned by native metadata', async () => {
    mocks.write.mockResolvedValue(undefined); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let root!: ReturnType<typeof create>; act(() => { root = create(React.createElement(Harness)); });
    await act(async () => { controls.selectModel(controls.models[1]); });
    expect(mocks.write).toHaveBeenCalledWith('relay', { model: 'b', reasoningEffort: 'medium', expectedModel: 'a', expectedReasoningEffort: 'low' });
    expect(controls.currentModel?.key).toBe('a'); act(() => root.unmount());
});
it('does not offer unsupported reasoning levels', async () => {
    mocks.write.mockClear(); let root!: ReturnType<typeof create>; act(() => { root = create(React.createElement(Harness)); });
    await act(async () => { controls.selectEffort({ key: 'unsupported', name: 'Unsupported' }); });
    expect(mocks.write).not.toHaveBeenCalled(); act(() => root.unmount());
});
it('an older enabled picker cannot write after the current source becomes cached readonly',async()=>{
 mocks.write.mockClear();mocks.sessions[fixture.id]=fixture;
 let root!:ReturnType<typeof create>;act(()=>{root=create(React.createElement(Harness));});
 const select=controls.selectModel,model=controls.models[1];
 mocks.sessions[fixture.id]={...fixture,metadata:{...fixture.metadata!,capabilities:{...fixture.metadata!.capabilities!,readOnly:true,rpcMethods:['bridge-receipt']}}};
 await act(async()=>{select(model);});expect(mocks.write).not.toHaveBeenCalled();
 act(()=>root.unmount());mocks.sessions[fixture.id]=fixture;
});
