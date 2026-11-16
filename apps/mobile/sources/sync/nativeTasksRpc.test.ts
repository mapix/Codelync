import { expect, it, vi } from 'vitest';
import type { Session } from './storageTypes';
vi.mock('./apiSocket', () => ({ apiSocket: {} }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'local' }));
vi.mock('./storage', () => ({ storage: {} }));
import { createNativeTaskReader } from './nativeTasksRpc';

const scope = { app: 'claude-desktop' as const, nativeCollection: 'claude-code-sessions' as const, hostId: 'local:claude-desktop:' + 'a'.repeat(64),
    parentConversationId: 'desktop-parent', ownerGeneration: 'owner', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli' };
const session = () => ({ id: 'parent', metadata: { client: { id: 'noninvasive-bridge' }, bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null,
    source: { app: 'claude-desktop', kind: 'session', protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: scope.nativeCollection, id: scope.parentConversationId,
        hostId: scope.hostId, runtimeGeneration: scope.ownerGeneration } } }, agentState: { nativeQuery: { version: 1, app: scope.app, nativeConversationId: scope.parentConversationId,
        hostId: scope.hostId, ownerGeneration: scope.ownerGeneration, queryToken: scope.queryToken, status: 'running', canSend: true, activeSendMode: 'queue', canCancel: true },
    nativeTasks: { version: 1, scope, tasks: [], tasksAvailable: true, tasksComplete: false, tasksTruncated: false, backgroundTasksComplete: false,
        dispatchChildren: [], dispatchChildrenAvailable: false, dispatchChildrenComplete: false, dispatchChildrenTruncated: false, partial: true } } }) as unknown as Session;
const row = { id: 'log', identity: 'local-log', sequence: 1, nativeTaskId: 'task', subtype: 'task_started', taskType: 'local_agent', kind: 'agent', status: 'running',
    nativeStatus: 'running', isBackgrounded: false };
const page = () => ({ scope, status: 'ok', available: true, logs: [row], hasMore: false, nextCursor: null });

it('reads metadata without a command journal and strips output/controls from the response', async () => {
    const current = session(), rpc = vi.fn().mockResolvedValue({ ...page(), output: 'private', logs: [{ ...row, output: 'private', canStop: true }] });
    const reader = createNativeTaskReader({ current: () => current, authority: () => 'peer:A', rpc });
    const result = await reader.logs('parent', scope, { taskId: 'task', limit: 25 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('parent', 'native-task-log-read', { scope, taskId: 'task', before: null, limit: 25 });
    expect(result).not.toHaveProperty('output'); expect(result.logs[0]).not.toHaveProperty('canStop'); expect(result.logs[0].nativeEventId).toBeNull();
});
it('reads exact task output without a command and enforces the UTF8 byte boundary and returned scope', async () => {
    const current = session(), rpc = vi.fn();
    const reader = createNativeTaskReader({ current: () => current, authority: () => 'peer:A', rpc });
    rpc.mockResolvedValue({ scope, taskId: 'task', output: '😀'.repeat(16384), truncated: true });
    expect((await reader.output('parent', scope, 'task')).truncated).toBe(true);
    expect(rpc).toHaveBeenCalledWith('parent', 'native-task-output-read', { scope, taskId: 'task' });
    rpc.mockResolvedValue({ scope, taskId: 'task', output: '😀'.repeat(16385), truncated: false });
    await expect(reader.output('parent', scope, 'task')).rejects.toThrow('unavailable');
    rpc.mockResolvedValue({ scope, taskId: 'other', output: '', truncated: false });
    await expect(reader.output('parent', scope, 'task')).rejects.toThrow('unavailable');
    rpc.mockResolvedValue({ scope: { ...scope, cliSessionId: 'foreign' }, taskId: 'task', output: '', truncated: false });
    await expect(reader.output('parent', scope, 'task')).rejects.toThrow('unavailable');
});
it('rejects a late response after the current peer, owner or query changes', async () => {
    for (const change of ['peer', 'owner', 'query']) {
        const current = session(); let authority = 'peer:A', finish!: (v: unknown) => void;
        const rpc = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        const reader = createNativeTaskReader({ current: () => current, authority: () => authority, rpc });
        const pending = reader.logs('parent', scope);
        if (change === 'peer') authority = 'peer:B';
        else if (change === 'owner') current.metadata!.bridge!.source.runtimeGeneration = 'new-owner';
        else current.agentState!.nativeQuery!.queryToken = 'new-query';
        finish(page()); await expect(pending).rejects.toThrow('scope changed'); expect(rpc).toHaveBeenCalledOnce();
    }
});
it('refuses foreign page scope/task, invalid pagination and new task data from another owner', async () => {
    const current = session(), rpc = vi.fn(); const reader = createNativeTaskReader({ current: () => current, authority: () => 'peer:A', rpc });
    rpc.mockResolvedValueOnce({ ...page(), scope: { ...scope, cliSessionId: 'other-cli' } }); await expect(reader.logs('parent', scope)).rejects.toThrow('unavailable');
    rpc.mockResolvedValueOnce(page()); await expect(reader.logs('parent', scope, { taskId: 'other-task' })).rejects.toThrow('unavailable');
    rpc.mockResolvedValueOnce({ ...page(), hasMore: true, nextCursor: null }); await expect(reader.logs('parent', scope)).rejects.toThrow('unavailable');
    rpc.mockResolvedValueOnce({ ...page(), logs: Array(13).fill(row) }); await expect(reader.logs('parent', scope)).rejects.toThrow('unavailable');
    const before = rpc.mock.calls.length; await expect(reader.logs('parent', scope, { limit: 101 })).rejects.toThrow('Invalid'); expect(rpc.mock.calls).toHaveLength(before);
    rpc.mockResolvedValueOnce({ ...current.agentState!.nativeTasks!, scope: { ...scope, ownerGeneration: 'foreign' } }); await expect(reader.tasks('parent', scope)).rejects.toThrow('unavailable');
});
