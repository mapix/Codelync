import { expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ initialize: vi.fn(), select: vi.fn().mockResolvedValue(undefined), decode: vi.fn(), request: vi.fn() }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: async () => ({ token: 'fixture-token', secret: 'fixture-secret', peer: { id: 'paired-mac', channels: [] } }) } }));
vi.mock('./peerNetwork', () => ({ peerAuthorization: () => 'sealed-fixture-proof', decodePeerResponse: calls.decode }));
vi.mock('./codeLightConnection', () => ({ initializeCodeLightConnection: calls.initialize, selectConnection: calls.select }));
import { bootstrapMacDiagnostics } from './bootstrapMacDiagnostics';
it('only hands authenticated same-peer locators to the existing automatic selector', async () => {
    vi.stubGlobal('fetch', calls.request);
    calls.request.mockResolvedValue({ ok: true, json: async () => ({ sealed: true }) });
    const channels = [{ id: 'local-0', kind: 'local', label: 'Local network', url: 'http://10.0.0.2:1234' }];
    calls.decode.mockReturnValue({ channels });
    await bootstrapMacDiagnostics([channels[0].url]);
    expect(calls.initialize).toHaveBeenCalledWith(expect.objectContaining({ token: 'fixture-token', secret: 'fixture-secret', peer: expect.objectContaining({ id: 'paired-mac', channels }) }));
    expect(calls.select).toHaveBeenCalledWith('auto');
    calls.initialize.mockClear(); calls.select.mockClear(); calls.decode.mockImplementation(() => { throw Error('Wrong Mac'); });
    await expect(bootstrapMacDiagnostics([channels[0].url])).rejects.toThrow();
    expect(calls.initialize).not.toHaveBeenCalled(); expect(calls.select).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
});
