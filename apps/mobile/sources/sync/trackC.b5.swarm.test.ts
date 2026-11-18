import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodelyncActivityTransport } from './codelyncActivityTransport';
import {
    CodelyncProjectActivityController,
    CodelyncProjectActivityStore,
    type CodelyncProjectDescriptor,
} from './codelyncProjectActivity';

function replyV2(sequence: number, mode: 'full' | 'delta' | 'unchanged' = 'full') {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            ok: true,
            version: 2,
            machineId: 'mac-1',
            epoch: 'epoch-1',
            sequence,
            observedAt: sequence * 1000,
            interestToken: `tok-${sequence}`,
            mode,
            watermark: `wm-${sequence}`,
            baseWatermark: mode === 'full' ? null : `wm-${sequence - 1}`,
            groups: mode === 'full'
                ? [{ id: 'p-1', total: 1, active: 1, waiting: 0, unknown: 0, status: 'ready', sessions: [{ id: 's-1', known: true, active: true, waiting: false }] }]
                : [],
            removedIds: [],
        }),
    };
}

function groupPayload(suffix = '1') {
    return [
        {
            id: `p-${suffix}`,
            projectKey: `/repo/${suffix}`,
            hostId: 'local',
            app: 'codex' as const,
            sessions: [{ id: `s-${suffix}`, nativeId: `native-${suffix}` }],
        },
    ];
}

function projectDescriptor(id: string, nativeId = 'native-1'): CodelyncProjectDescriptor {
    return {
        id,
        projectKey: `/repo/${id}`,
        hostId: 'local',
        machineId: 'mac-1',
        app: 'codex',
        sessions: [{ id: `row-${id}`, nativeId }],
    };
}

describe('Track C Batch 5 — R043 CodelyncActivityTransport', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reuses cached group fingerprints across freshly mapped polls and detects in-place mutations', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce(replyV2(1, 'full'))
            .mockResolvedValueOnce(replyV2(2, 'unchanged'))
            .mockResolvedValueOnce(replyV2(3, 'unchanged'))
            .mockResolvedValueOnce(replyV2(4, 'full'))
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    ok: true,
                    version: 2,
                    machineId: 'mac-1',
                    epoch: 'epoch-1',
                    sequence: 5,
                    observedAt: 5000,
                    interestToken: null,
                    mode: 'full',
                    watermark: 'wm-5',
                    baseWatermark: null,
                    groups: [],
                    removedIds: [],
                }),
            });
        const transport = new CodelyncActivityTransport({
            peerIdentity: () => 'peer:mac-1',
            endpoint: () => 'https://relay.invalid',
            request,
        });

        const stringifySpy = vi.spyOn(JSON, 'stringify');

        // Poll 1: initial miss computes fingerprint for groups once.
        await transport.read('mac-1', { clientId: 'c1', requestSeq: 1, groups: groupPayload('1') });
        expect(stringifySpy.mock.calls.filter((call) => Array.isArray(call[0]) && (call[0][0] as any)?.id === 'p-1')).toHaveLength(1);

        // Polls 2-3: freshly constructed group arrays with identical fields hit cached fingerprint cleanly.
        stringifySpy.mockClear();
        await transport.read('mac-1', { clientId: 'c1', requestSeq: 2, groups: groupPayload('1') });
        await transport.read('mac-1', { clientId: 'c1', requestSeq: 3, groups: groupPayload('1') });
        expect(stringifySpy.mock.calls.filter((call) => Array.isArray(call[0]) && (call[0][0] as any)?.id === 'p-1')).toHaveLength(0);
        expect(request.mock.calls[1][0]).toMatchObject({ interestToken: 'tok-1', since: 'wm-1' });
        expect(request.mock.calls[2][0]).toMatchObject({ interestToken: 'tok-2', since: 'wm-2' });

        // Poll 4: caller mutates group object in place -> cached snapshot stays isolated and detects change!
        const sharedGroups = groupPayload('1');
        sharedGroups[0].sessions[0].nativeId = 'native-mutated';
        await transport.read('mac-1', { clientId: 'c1', requestSeq: 4, groups: sharedGroups });
        expect(request.mock.calls[3][0]).not.toHaveProperty('interestToken');
        expect(request.mock.calls[3][0]).toHaveProperty('groups');

        // Poll 5: empty release bypasses JSON.stringify(groups) too.
        stringifySpy.mockClear();
        await transport.read('mac-1', { clientId: 'c1', requestSeq: 5, groups: [] });
        expect(stringifySpy.mock.calls.filter((call) => Array.isArray(call[0]) && call[0].length === 0)).toHaveLength(0);
    });

    it('refreshes LRU order in this.latest so actively polling clients are not evicted after 32 transient clients', async () => {
        const request = vi.fn().mockImplementation(async (body: Record<string, unknown>) => {
            const seq = body.requestSeq as number;
            const id = Array.isArray(body.groups) && body.groups[0] ? (body.groups[0] as any).id : 'p-hot';
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    ok: true,
                    version: 2,
                    machineId: 'mac-1',
                    epoch: 'epoch-1',
                    sequence: seq,
                    observedAt: seq * 1000,
                    interestToken: `tok-${seq}`,
                    mode: body.interestToken ? 'unchanged' : 'full',
                    watermark: `wm-${seq}`,
                    baseWatermark: body.interestToken ? body.since : null,
                    groups: body.interestToken ? [] : [{ id, total: 1, active: 0, waiting: 0, unknown: 0, status: 'ready' }],
                    removedIds: [],
                }),
            };
        });
        const transport = new CodelyncActivityTransport({
            peerIdentity: () => 'peer:mac-1',
            endpoint: () => 'https://relay.invalid',
            request,
        });

        await transport.read('mac-1', { clientId: 'hot', requestSeq: 1, groups: groupPayload('hot') });
        for (let i = 1; i <= 31; i++) {
            await transport.read('mac-1', { clientId: `transient-${i}`, requestSeq: 1, groups: groupPayload('hot') });
        }
        // Touch 'hot' so it moves to MRU tail of `latest` (capacity 32) and `baselines` (capacity 16).
        await transport.read('mac-1', { clientId: 'hot', requestSeq: 2, groups: groupPayload('hot') });
        // Add 2 more transient clients (would previously evict 'hot' from `latest`).
        await transport.read('mac-1', { clientId: 'transient-32', requestSeq: 1, groups: groupPayload('hot') });
        await transport.read('mac-1', { clientId: 'transient-33', requestSeq: 1, groups: groupPayload('hot') });

        // Active 'hot' stays in `latest`, so a normal sequential poll retains delta baseline and skips stale-eviction full reload.
        await transport.read('mac-1', { clientId: 'hot', requestSeq: 3, groups: groupPayload('hot') });
        const lastCall = request.mock.calls[request.mock.calls.length - 1][0];
        expect(lastCall).toMatchObject({ clientId: 'hot', requestSeq: 3, interestToken: 'tok-2', since: 'wm-2' });
        expect((transport as any).latest.has(JSON.stringify(['', 'peer:mac-1', 'mac-1', 'hot']))).toBe(true);
    });
});

describe('Track C Batch 5 — R048 CodelyncProjectActivityController.setProjects', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('uses linear ordered field equality without JSON.stringify or localeCompare on unchanged descriptors', async () => {
        const store = new CodelyncProjectActivityStore();
        const request = vi.fn(async (_machine: string, _params: unknown) => ({
            ok: true,
            version: 1,
            epoch: 'ep-1',
            sequence: 1,
            observedAt: 1000,
            groups: [],
        }));
        const controller = new CodelyncProjectActivityController({
            store,
            clientId: 'phone-1',
            scope: async () => 'account-1',
            request,
        });

        const initial = Array.from({ length: 18 }, (_, i) => projectDescriptor(`proj-${String(i).padStart(2, '0')}`));
        controller.setProjects(initial);
        controller.setEnabled(true);
        await controller.refresh();
        expect(request).toHaveBeenCalledTimes(1);

        const stringifySpy = vi.spyOn(JSON, 'stringify');
        const localeSpy = vi.spyOn(String.prototype, 'localeCompare');

        // Fresh descriptor instances with identical 0..15 fields (even with #16/#17 changed beyond the 16-item cap) must not refresh.
        const cloned = Array.from({ length: 18 }, (_, i) =>
            projectDescriptor(`proj-${String(i).padStart(2, '0')}`, i >= 16 ? 'changed-tail' : 'native-1'),
        );
        controller.setProjects(cloned);

        expect(stringifySpy).not.toHaveBeenCalled();
        expect(localeSpy).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledTimes(1);

        // Mutating an element inside the active 16 triggers an update cleanly.
        cloned[0] = projectDescriptor('proj-00', 'native-updated');
        controller.setProjects(cloned);
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        await Promise.resolve();
        expect(request).toHaveBeenCalledTimes(2);
        expect(localeSpy).not.toHaveBeenCalled();
        controller.close();
    });

    it('detects in-place session mutations and empty-list release transitions cleanly', async () => {
        const store = new CodelyncProjectActivityStore();
        const request = vi.fn(async (_machine: string, _params: unknown) => ({
            ok: true,
            version: 1,
            epoch: 'ep-1',
            sequence: 1,
            observedAt: 1000,
            groups: [],
        }));
        const controller = new CodelyncProjectActivityController({
            store,
            clientId: 'phone-1',
            scope: async () => 'account-1',
            request,
        });

        const descriptor = projectDescriptor('alpha', 'native-1');
        controller.setProjects([descriptor]);
        controller.setEnabled(true);
        await controller.refresh();
        expect(request).toHaveBeenCalledTimes(1);

        // Mutate session row in place after initial registration.
        descriptor.sessions![0].nativeId = 'native-2';
        controller.setProjects([descriptor]);
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        await Promise.resolve();
        expect(request).toHaveBeenCalledTimes(2);
        expect((request.mock.calls[1][1] as any).groups[0].sessions[0].nativeId).toBe('native-2');

        controller.setProjects([]);
        await Promise.resolve();
        await Promise.resolve();
        expect(request).toHaveBeenCalledTimes(3);
        expect((request.mock.calls[2][1] as any).groups).toEqual([]);
        controller.close();
    });
});
