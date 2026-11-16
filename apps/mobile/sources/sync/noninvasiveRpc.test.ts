import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { rpcTarget } from '@slopus/happy-wire/codelight';
const state = vi.hoisted(() => ({ values: new Map<string, string>(), rpc: vi.fn(), id: vi.fn(() => 'never-generated') }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
    getItem: async (key: string) => state.values.get(key) ?? null, setItem: async (key: string, value: string) => { state.values.set(key, value); },
    removeItem: async (key: string) => { state.values.delete(key); }, getAllKeys: async () => [...state.values.keys()],
} }));
vi.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA256' }, randomUUID: state.id,
    digestStringAsync: async (_algorithm: string, value: string) => createHash('sha256').update(value).digest('hex') }));
vi.mock('./apiSocket', () => ({ apiSocket: { peerIdentity: () => 'peer:test', sessionRPC: state.rpc, machineRPC: vi.fn(), onReconnected: vi.fn() } }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://fixture.invalid' }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ sessions: {} }) } }));
import { recoverNoninvasiveRpcDetailed } from './noninvasiveRpc';
beforeEach(() => { state.values.clear(); vi.clearAllMocks(); });

it.each(['matching', 'foreign', 'missing'])('the public original-command check handles %s without execute, replay or a new ID', async kind => {
    const params = { taskId: 'task', scope: { queryToken: 'query' } }, target = rpcTarget('native-task-stop', params);
    const key = 'noninvasive-rpc-v3:' + createHash('sha256').update(JSON.stringify(['peer:test', 'parent', target])).digest('hex');
    const record = JSON.stringify({ serverUrl: 'peer:test', sessionId: 'parent', method: 'native-task-stop', target,
        commandId: kind === 'foreign' ? 'foreign-command' : 'original-command', digest: 'kept', createdAt: 1 });
    if (kind !== 'missing') state.values.set(key, record);
    state.rpc.mockResolvedValue({ receipt: { id: 'original-command', status: 'complete', result: { requested: true } } });
    const result = await recoverNoninvasiveRpcDetailed('parent', 'native-task-stop', params, 'original-command');
    expect(result.confirmed).toBe(kind === 'matching'); expect(state.id).not.toHaveBeenCalled();
    if (kind === 'matching') expect(state.rpc).toHaveBeenCalledExactlyOnceWith('parent', 'bridge-receipt', { commandId: 'original-command' }, 'https://fixture.invalid');
    else { expect(state.rpc).not.toHaveBeenCalled(); expect(state.values.get(key)).toBe(kind === 'foreign' ? record : undefined); }
});
