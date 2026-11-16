import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { rpcTarget } from '@slopus/happy-wire/codelight';
import { NoninvasiveRpcJournal, BridgeRpcUnconfirmedError } from '@/sync/noninvasiveRpcJournal';
import { createNativeTaskActions, nativeTaskActionAllowed } from './nativeTaskActions';

export function taskFixture() {
    const scope = { app: 'claude-desktop' as const, nativeCollection: 'claude-code-sessions' as const, hostId: 'local:claude-desktop:' + 'a'.repeat(64),
        parentConversationId: 'parent-native', ownerGeneration: 'owner', runtimeGeneration: 'runtime', queryToken: 'query', cliSessionId: 'cli' };
    const native = { version: 1 as const, scope, tasks: [{ nativeTaskId: 'task-A', name: 'Worker A', taskType: 'local_bash', kind: 'shell' as const,
        status: 'running' as const, isBackgrounded: true, statusSource: 'native-task-lifecycle' }], tasksAvailable: true, tasksComplete: false,
        tasksTruncated: false, backgroundTasksComplete: true, partial: true, dispatchChildren: [], dispatchChildrenAvailable: true,
        dispatchChildrenComplete: true, dispatchChildrenTruncated: false };
    const session = { id: 'parent', metadata: { client: { id: 'noninvasive-bridge' }, capabilities: { readOnly: false,
        nativeTaskControls: { version: 1, outputTaskTypes: ['local_bash'], stopTaskTypes: ['local_bash'] }, rpcMethods: ['native-task-output-read', 'native-task-stop'] },
        bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null, source: { app: scope.app, kind: 'session', protocol: 'claude-desktop-native',
            appMode: 'code', nativeCollection: scope.nativeCollection, id: scope.parentConversationId, hostId: scope.hostId, runtimeGeneration: scope.ownerGeneration } } },
        agentState: { nativeQuery: { version: 1, app: scope.app, nativeConversationId: scope.parentConversationId, hostId: scope.hostId,
            ownerGeneration: scope.ownerGeneration, queryToken: scope.queryToken, status: 'running', canSend: false, activeSendMode: 'unverified', canCancel: false }, nativeTasks: native } } as unknown as Session;
    return { scope, native, session, active: true };
}

describe('native task capability boundaries', () => {
    it('allows only the verified row type, independently of parent Send/Cancel readiness', () => {
        const view = taskFixture();
        expect(nativeTaskActionAllowed(view, view.scope, 'task-A', 'output')).toBe(true);
        expect(nativeTaskActionAllowed(view, view.scope, 'task-A', 'stop')).toBe(true);
        expect(nativeTaskActionAllowed(view, view.scope, 'missing', 'stop')).toBe(false);
        view.session.metadata!.capabilities!.nativeTaskControls!.stopTaskTypes = [];
        expect(nativeTaskActionAllowed(view, view.scope, 'task-A', 'stop')).toBe(false);
        expect(nativeTaskActionAllowed(view, view.scope, 'task-A', 'output')).toBe(true);
    });
    it.each(['readonly', 'missing-policy', 'no-cap', 'missing-capabilities', 'inactive', 'owner', 'query', 'missing-task', 'unknown-type'])('disables %s without a parent fallback', change => {
        const view = taskFixture();
        if (change === 'readonly') view.session.metadata!.capabilities!.readOnly = true;
        if (change === 'missing-policy') delete view.session.metadata!.capabilities!.readOnly;
        if (change === 'no-cap') delete view.session.metadata!.capabilities!.nativeTaskControls;
        if (change === 'missing-capabilities') delete view.session.metadata!.capabilities;
        if (change === 'inactive') view.active = false;
        if (change === 'owner') view.session.metadata!.bridge!.source.runtimeGeneration = 'other';
        if (change === 'query') view.session.agentState!.nativeQuery!.queryToken = 'other';
        if (change === 'missing-task') view.native.tasks = [];
        if (change === 'unknown-type') view.native.tasks[0].taskType = 'unverified';
        expect(nativeTaskActionAllowed(view, view.scope, 'task-A', 'output')).toBe(change === 'readonly' || change === 'missing-policy');
        expect(nativeTaskActionAllowed(view, view.scope, 'task-A', 'stop')).toBe(false);
    });
    it.each(['completed', 'failed', 'stopped', 'unknown'] as const)('does not stop a %s row', status => {
        const view = taskFixture(); view.native.tasks[0].status = status as 'running';
        expect(nativeTaskActionAllowed(view, view.scope, 'task-A', 'stop')).toBe(false);
        expect(nativeTaskActionAllowed(view, view.scope, 'task-A', 'output')).toBe(true);
    });
});

describe('task actions use the existing operation boundary', () => {
    it('coalesces one pending task Stop and keeps different task/query targets distinct', async () => {
        const view = taskFixture(); let finish!: () => void;
        const journal = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
        const actions = createNativeTaskActions({ current: () => view, authority: () => 'peer:A', output: vi.fn(), journal });
        const first = actions.stop('parent', view.scope, 'task-A');
        expect(actions.stop('parent', view.scope, 'task-A')).toBe(first);
        await Promise.resolve(); expect(journal).toHaveBeenCalledExactlyOnceWith('parent', 'native-task-stop', { scope: view.scope, taskId: 'task-A' });
        expect(rpcTarget('native-task-stop', { scope: view.scope, taskId: 'task-A' })).not.toBe(rpcTarget('native-task-stop', { scope: view.scope, taskId: 'task-B' }));
        expect(rpcTarget('native-task-stop', { scope: view.scope, taskId: 'task-A' })).not.toBe(rpcTarget('native-task-stop', { scope: { ...view.scope, queryToken: 'next' }, taskId: 'task-A' }));
        finish(); await first;
    });
    it('retains an unknown command and queries its receipt on another explicit attempt without replay', async () => {
        const view = taskFixture(); let saved: string | null = null;
        const rpc = vi.fn(async (_id, _method, params: any) => ({ receipt: { id: params.commandId, status: 'unknown' as const } }));
        const journal = new NoninvasiveRpcJournal({ get: async () => saved, set: async value => { saved = value; }, remove: async () => { saved = null; } }, rpc,
            () => 'original-command', async () => 'digest');
        const actions = createNativeTaskActions({ current: () => view, authority: () => 'peer:A', output: vi.fn(),
            journal: (id, method, params) => journal.execute({ serverUrl: 'peer:A', sessionId: id, method, target: rpcTarget(method, params) }, params) });
        await expect(actions.stop('parent', view.scope, 'task-A')).rejects.toBeInstanceOf(BridgeRpcUnconfirmedError);
        await expect(actions.stop('parent', view.scope, 'task-A')).rejects.toBeInstanceOf(BridgeRpcUnconfirmedError);
        expect(rpc.mock.calls.map(call => call[1])).toEqual(['native-task-stop', 'bridge-receipt']);
        expect(JSON.parse(saved!).commandId).toBe('original-command');
    });
    it('rejects a late output when the peer or foreground changes and never writes a journal for output', async () => {
        for (const change of ['peer', 'inactive']) {
            const view = taskFixture(); let peer = 'peer:A', finish!: (value: unknown) => void;
            const journal = vi.fn(), output = vi.fn(() => new Promise(resolve => { finish = resolve; }));
            const actions = createNativeTaskActions({ current: () => view, authority: () => peer, output, journal });
            const pending = actions.output('parent', view.scope, 'task-A');
            if (change === 'peer') peer = 'peer:B'; else view.active = false;
            finish({ output: 'late' }); await expect(pending).rejects.toThrow('unavailable'); expect(journal).not.toHaveBeenCalled();
        }
    });
});
