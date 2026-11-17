import { beforeEach, expect, it, vi } from 'vitest';
import type { Session } from './storageTypes';

const mocks = vi.hoisted(() => ({ peer: 'peer:mac-a', origin: 'http://192.168.0.2:9000', credentials: { token: 'fixture', peer: { id: 'mac-a' } } as any,
    load: vi.fn(), rpc: vi.fn() }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: mocks.load } }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => mocks.origin }));
vi.mock('./apiSocket', () => ({ apiSocket: { peerIdentity: () => mocks.peer } }));
vi.mock('./noninvasiveRpc', () => ({ runNoninvasiveMachineRpc: mocks.rpc }));
import { activateCodelyncSource } from './codelyncSourceActivation';

function source(status: 'connected' | 'disconnected' = 'disconnected'): Session {
    return { id: 'original-relay', metadata: { machineId: 'original-machine', bridge: { controller: 'machine', sourceKey: 'original-source', sourceStatus: status,
        controlMode: 'session', source: { app: 'antigravity', id: 'original-native', kind: 'session', hostId: 'local:antigravity:' + 'a'.repeat(64), protocol: 'antigravity-connect', runtimeGeneration: 'same-native-owner' } } } } as unknown as Session;
}
beforeEach(() => { mocks.peer = 'peer:mac-a'; mocks.origin = 'http://192.168.0.2:9000'; mocks.credentials = { token: 'fixture', peer: { id: 'mac-a' } }; mocks.load.mockReset(); mocks.load.mockImplementation(async () => mocks.credentials); mocks.rpc.mockReset(); mocks.rpc.mockResolvedValue({ receipt: { status: 'complete' } }); });

it('cached connected metadata cannot skip a forced actual entry and same-owner re-entry restores observation again', async () => {
    await activateCodelyncSource(source('connected'));
    expect(mocks.rpc).not.toHaveBeenCalled();
    await activateCodelyncSource(source('connected'), { force: true, authority: 'peer:mac-a' });
    await activateCodelyncSource(source('disconnected'), { force: true, authority: 'peer:mac-a' });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledWith('original-machine', 'codelync-observe-source', { sourceKey: 'original-source' });
});

it('same-peer channel changes preserve a single concurrent original-source observation', async () => {
    let finish!: (value: unknown) => void;
    mocks.rpc.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = activateCodelyncSource(source(), { force: true, authority: 'peer:mac-a' });
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    mocks.origin = 'https://same-mac.example';
    const next = activateCodelyncSource(source(), { force: true, authority: 'peer:mac-a' });
    await Promise.resolve(); finish({ receipt: { status: 'complete' } });
    await Promise.all([first, next]); expect(mocks.rpc).toHaveBeenCalledTimes(1);
});

it('a peer change while credentials load prevents dispatch to the new Mac', async () => {
    let finish!: (value: unknown) => void;
    mocks.load.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = activateCodelyncSource(source(), { force: true, authority: 'peer:mac-a' });
    mocks.peer = 'peer:mac-b'; finish({ token: 'new-fixture', peer: { id: 'mac-b' } });
    await expect(pending).rejects.toThrow('authority changed'); expect(mocks.rpc).not.toHaveBeenCalled();
});
