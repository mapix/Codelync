import { expect, it, vi } from 'vitest';
import { CodelyncActivityTransport } from './codelyncActivityTransport';
import { CodelyncProjectActivityStore, codelyncActivitySourceScope } from './codelyncProjectActivity';

const group = (id = 'project', active = 1) => ({ id, total: 1, active, waiting: 0, unknown: 0, status: 'ready',
    sessions: [{ id: 'row', known: true, active: !!active, waiting: false }] });
const params = (requestSeq: number, id = 'project') => ({ clientId: 'client', requestSeq,
    groups: [{ id, projectKey: '/fixture', app: 'codex' as const, hostId: 'local', sessions: [{ id: 'row', nativeId: 'native' }] }] });
const reply = (mode: string, sequence: number, extra: Record<string, unknown> = {}) => ({ ok: true, version: 2, machineId: 'mac', epoch: 'epoch', sequence,
    observedAt: sequence * 100, interestToken: 'token', mode, watermark: 'watermark-' + sequence, baseWatermark: mode === 'full' ? null : 'watermark-' + (sequence - 1),
    groups: mode === 'full' ? [group()] : [], removedIds: [], ...extra });
const response = (value: unknown) => ({ ok: true, status: 200, json: async () => value });
function setup() {
    let peer: string | null = 'peer:mac', endpoint = 'https://first.invalid';
    const request = vi.fn<(_: Record<string, unknown>) => Promise<ReturnType<typeof response>>>();
    const transport = new CodelyncActivityTransport({ request, peerIdentity: () => peer, endpoint: () => endpoint });
    return { request, transport, setPeer: (value: string) => { peer = value; }, setEndpoint: (value: string) => { endpoint = value; } };
}

it('sends descriptors once, then reconstructs compact unchanged replies without repainting each subscriber', async () => {
    const { request, transport } = setup(); request.mockResolvedValueOnce(response(reply('full', 1))).mockResolvedValue(response(reply('unchanged', 2)));
    const store = new CodelyncProjectActivityStore(); store.reset('peer:mac:account');
    const wanted = new Set(['project']), rows = new Map([['project', new Set(['row'])]]), scopes = new Map([['row', codelyncActivitySourceScope('mac', 'codex', 'local', 'native')]]);
    store.apply('mac', await transport.read('mac', params(1), 'peer:mac:account'), wanted, rows, scopes);
    const projectChanged = vi.fn(), rowChanged = vi.fn(); store.subscribe('project', projectChanged); store.subscribeSession('row', rowChanged);
    const old = store.getSession('row');
    store.apply('mac', await transport.read('mac', params(2), 'peer:mac:account'), wanted, rows, scopes);
    expect(request.mock.calls[1][0]).toEqual({ activityProtocol: 2, clientId: 'client', requestSeq: 2, interestToken: 'token', since: 'watermark-1' });
    expect(JSON.stringify(request.mock.calls[1][0]).length).toBeLessThan(JSON.stringify(request.mock.calls[0][0]).length);
    expect(projectChanged).not.toHaveBeenCalled(); expect(rowChanged).not.toHaveBeenCalled();
    expect(store.getSessionScoped('row', scopes.get('row')!, 'peer:mac')).toMatchObject({ active: true, observedAt: 200 });
    expect(old.observedAt).toBe(100);
    expect(store.getSessionScoped('row', scopes.get('row')!, 'peer:different').known).toBe(false);
    expect(store.getSessionScoped('row', codelyncActivitySourceScope('mac', 'antigravity', 'local', 'native'), 'peer:mac').known).toBe(false);
});

it('applies only changed full group rows and removes groups without turning missing data into idle', async () => {
    const { request, transport } = setup(); request.mockResolvedValueOnce(response(reply('full', 1)))
        .mockResolvedValueOnce(response(reply('delta', 2, { groups: [group('project', 0)] })))
        .mockResolvedValueOnce(response(reply('delta', 3, { removedIds: ['project'] })));
    expect((await transport.read('mac', params(1))).groups[0].active).toBe(1);
    expect((await transport.read('mac', params(2))).groups[0].active).toBe(0);
    expect((await transport.read('mac', params(3))).groups).toEqual([]);
});

it('an expired device interest gets one full retry using the same read sequence', async () => {
    const { request, transport } = setup(); request.mockResolvedValueOnce(response(reply('full', 1))).mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({}) })
        .mockResolvedValueOnce(response(reply('full', 2)));
    await transport.read('mac', params(1)); await transport.read('mac', params(2));
    expect(request).toHaveBeenCalledTimes(3); expect(request.mock.calls[2][0]).toEqual({ activityProtocol: 2, clientId: 'client', requestSeq: 2, groups: params(2).groups });
});

it('coalesces the exact pending read and safely repeats it once on a changed channel of the same peer', async () => {
    const { request, transport, setEndpoint } = setup();
    let finish!: () => void;
    request.mockImplementationOnce(() => new Promise((_resolve, reject) => { finish = () => { setEndpoint('https://second.invalid'); reject(Error('old route retired')); }; }))
        .mockResolvedValueOnce(response(reply('full', 1)));
    const first = transport.read('mac', params(1)), same = transport.read('mac', params(1)); expect(first).toBe(same); expect(request).toHaveBeenCalledOnce();
    finish(); await first; expect(request).toHaveBeenCalledTimes(2);
});

it('does not accept a late response after changing peer or an invalid delta epoch/base', async () => {
    const { request, transport, setPeer } = setup();
    let finish!: (value: ReturnType<typeof response>) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = transport.read('mac', params(1)); setPeer('peer:other'); finish(response(reply('full', 1)));
    await expect(pending).rejects.toThrow('peer changed');
    setPeer('peer:mac'); request.mockResolvedValueOnce(response(reply('full', 1))).mockResolvedValueOnce(response(reply('delta', 2, { baseWatermark: 'foreign' })));
    await transport.read('mac', params(2)); await expect(transport.read('mac', params(3))).rejects.toThrow('baseline changed');
});

it('a newer release prevents an old in-flight poll from reinstalling its token', async () => {
    const { request, transport } = setup(); let finish!: (value: ReturnType<typeof response>) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(response(reply('full', 2, { groups: [], interestToken: null })))
        .mockResolvedValueOnce(response(reply('full', 3)));
    const old = transport.read('mac', params(1)); await transport.read('mac', { ...params(2), groups: [] });
    finish(response(reply('full', 1))); await old; await transport.read('mac', params(3));
    expect(request.mock.calls[2][0]).toHaveProperty('groups'); expect(request.mock.calls[2][0]).not.toHaveProperty('interestToken');
});
