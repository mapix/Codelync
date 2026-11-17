import { beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ initialize: vi.fn(), select: vi.fn(),probe:vi.fn(),manifest:vi.fn(),recover:vi.fn(), decode: vi.fn(), request: vi.fn(), credentials: vi.fn() }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: calls.credentials } }));
vi.mock('./peerNetwork', () => ({ peerAuthorization: () => 'sealed-fixture-proof', decodePeerResponse: calls.decode }));
vi.mock('./codelyncConnection', () => ({ recoverCodelyncConnection:calls.recover,probeCodelyncChannel:calls.probe,readCodelyncChannelManifest:calls.manifest }));
import { bootstrapMacDiagnostics } from './bootstrapMacDiagnostics';
const owner = { token: 'fixture-token', secret: 'fixture-secret', peer: { id: 'paired-mac', key: 'fixture-mac-key', channels: [], device: { publicKey: 'fixture-public', secretKey: 'fixture-private' } } };
const channels = [{ id: 'local-0', kind: 'local', label: 'Local network', url: 'http://10.0.0.2:1234' }];
beforeEach(() => {
    vi.clearAllMocks(); calls.credentials.mockResolvedValue(owner); calls.select.mockResolvedValue(undefined);calls.probe.mockImplementation(async(channel:any)=>({channel,latencyMs:1}));calls.manifest.mockImplementation(async()=>{calls.decode();return channels;});calls.recover.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', calls.request); calls.request.mockResolvedValue({ ok: true, json: async () => ({ sealed: true }) }); calls.decode.mockReturnValue({ channels });
});
it('only hands authenticated same-peer locators to the intent-preserving recovery owner', async () => {
    await bootstrapMacDiagnostics([channels[0].url], { expectedPeerId: owner.peer.id });
    expect(calls.recover).toHaveBeenCalledExactlyOnceWith(channels,owner);
    expect(calls.initialize).not.toHaveBeenCalled();expect(calls.select).not.toHaveBeenCalled();
});
it('does not hand an unauthenticated Mac response to the selector', async () => {
    calls.decode.mockImplementation(() => { throw Error('Wrong Mac'); });
    await expect(bootstrapMacDiagnostics([channels[0].url])).rejects.toThrow();
    expect(calls.initialize).not.toHaveBeenCalled(); expect(calls.select).not.toHaveBeenCalled();
});
it('does no network work for a mismatched expected peer', async () => {
    await expect(bootstrapMacDiagnostics([channels[0].url], { expectedPeerId: 'different' })).rejects.toThrow('The saved Mac changed');
    expect(calls.request).not.toHaveBeenCalled(); expect(calls.initialize).not.toHaveBeenCalled();
});
it('rejects replaced device/account authority after authenticating before any selection', async () => {
    calls.credentials.mockResolvedValueOnce(owner).mockResolvedValueOnce({ ...owner, peer: { ...owner.peer, device: { ...owner.peer.device, secretKey: 'replaced' } } });
    await expect(bootstrapMacDiagnostics([channels[0].url])).rejects.toThrow('The saved Mac changed');
    expect(calls.initialize).not.toHaveBeenCalled(); expect(calls.select).not.toHaveBeenCalled();
});
it('selection failure restores only the unchanged owner', async () => {
    calls.recover.mockRejectedValue(Error('Fixture failure'));
    await expect(bootstrapMacDiagnostics([channels[0].url])).rejects.toThrow('Fixture failure');
    expect(calls.initialize).not.toHaveBeenCalled();expect(calls.recover).toHaveBeenCalledOnce();
});
it('an old failed bootstrap cannot initialize or restore a newly paired owner', async () => {
    calls.recover.mockRejectedValue(Error('Fixture failure'));
    calls.credentials.mockResolvedValueOnce(owner).mockResolvedValueOnce(owner).mockResolvedValueOnce({ ...owner, token: 'new-account' });
    await expect(bootstrapMacDiagnostics([channels[0].url])).rejects.toThrow('Fixture failure');
    expect(calls.initialize).not.toHaveBeenCalled();
});
