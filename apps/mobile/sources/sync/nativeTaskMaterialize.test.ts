import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { nativeTaskDigestText, nativeTaskTransfer } from '@codelync/wire/native-tasks';
import type { NativeTasks } from './nativeTasks';
vi.mock('expo-crypto', async () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async (_algorithm: string, text: string) => {
    const { createHash } = await import('node:crypto'); return createHash('sha256').update(text).digest('hex');
} }));
import { materializeNativeTaskReply } from './nativeTaskMaterialize';

const full = (): NativeTasks => ({ version: 1, scope: { app: 'claude-desktop', nativeCollection: 'claude-code-sessions', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
    parentConversationId: 'parent', ownerGeneration: 'owner', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli' },
    tasks: Array.from({ length: 8 }, (_, i) => ({ nativeTaskId: 'task-' + i, name: 'native worker ' + i, taskType: 'local_agent', kind: 'agent' as const,
        status: 'running' as const, isBackgrounded: false, statusSource: 'native-task-lifecycle' })),
    dispatchChildren: [], tasksAvailable: true, tasksComplete: true, tasksTruncated: false, backgroundTasksComplete: false,
    dispatchChildrenAvailable: true, dispatchChildrenComplete: true, dispatchChildrenTruncated: false, partial: false });
const signed = (value: NativeTasks): NativeTasks => ({ ...value, digest: createHash('sha256').update(nativeTaskDigestText(value)).digest('hex') });
it('materializes full, one-row delta and unchanged using the shared contract plus SHA256', async () => {
    const a = signed(full()), next = full(); next.tasks[2].status = 'completed'; const b = signed(next);
    expect(await materializeNativeTaskReply(null, a)).toEqual(a);
    const delta = nativeTaskTransfer(a, b); expect(delta.kind).toBe('native-task-delta'); expect(delta.taskUpserts).toHaveLength(1);
    expect(await materializeNativeTaskReply(a, delta)).toEqual(b);
    expect(await materializeNativeTaskReply(b, nativeTaskTransfer(b, b))).toEqual(b);
    expect(a.tasks[2].status).toBe('running');
});
it('refuses base, removal/order/count conflicts before changing the accepted baseline', async () => {
    const a = signed(full()), next = full(); next.tasks[0].status = 'completed'; const b = signed(next), delta = nativeTaskTransfer(a, b);
    for (const broken of [{ ...delta, baseDigest: 'f'.repeat(64) }, { ...delta, taskRemovedIds: ['missing'] },
        { ...delta, taskRemovedIds: ['task-0'] }, { ...delta, taskOrder: ['task-0'] }, { ...delta, taskCount: 1 }]) {
        await expect(materializeNativeTaskReply(a, broken)).rejects.toThrow();
    }
    expect(a.tasks[0].status).toBe('running'); await expect(materializeNativeTaskReply(null, delta)).rejects.toThrow();
});
it('rejects a syntactically valid but false digest and never treats delta arrays as a full snapshot', async () => {
    const a = signed(full()); await expect(materializeNativeTaskReply(null, { ...a, digest: 'f'.repeat(64) })).rejects.toThrow('digest mismatch');
    const next = full(); next.tasks[0].status = 'completed'; const delta = nativeTaskTransfer(a, signed(next));
    await expect(materializeNativeTaskReply(a, { ...delta, tasks: a.tasks, dispatchChildren: a.dispatchChildren, baseDigest: 'f'.repeat(64) })).rejects.toThrow();
});
it('allows structural digestless legacy full materialization without inventing a digest baseline', async () => {
    const legacy = full(); expect(await materializeNativeTaskReply(null, legacy)).toEqual(legacy); expect(legacy).not.toHaveProperty('digest');
});
