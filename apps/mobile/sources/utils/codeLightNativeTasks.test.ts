import { expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { NativeTasksSchema } from '@/sync/nativeTasks';
import { captureCurrentNativeTaskScope, projectCodeLightNativeTasks } from './codeLightNativeTasks';
import { projectCodeLightSubagents, codeLightSubagentParent } from './codeLightSubagents';
import { nativeSubagentInputReadOnly } from './nativeParentControl';

export const taskParent = (): Session => ({ id: 'parent-relay', metadata: { machineId: 'mac', client: { id: 'noninvasive-bridge' }, nativeSession: { title: 'parent', parentId: null },
    bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null, source: { app: 'claude-desktop', kind: 'session', appMode: 'code',
        protocol: 'claude-desktop-native', nativeCollection: 'claude-code-sessions', id: 'desktop-parent', hostId: 'local:claude-desktop:' + 'a'.repeat(64), runtimeGeneration: 'parent-owner' } } },
    agentState: { nativeQuery: { version: 1, app: 'claude-desktop', nativeConversationId: 'desktop-parent', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
        ownerGeneration: 'parent-owner', queryToken: 'query', status: 'running', canSend: true, activeSendMode: 'queue', canCancel: true },
    nativeTasks: { version: 1, scope: { app: 'claude-desktop', nativeCollection: 'claude-code-sessions', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
        parentConversationId: 'desktop-parent', ownerGeneration: 'parent-owner', runtimeGeneration: 'main-runtime', queryToken: 'query', cliSessionId: 'cli-parent' },
    tasks: [{ nativeTaskId: 'sdk-task', name: 'worker', taskType: 'local_agent', kind: 'agent', status: 'running', isBackgrounded: false, statusSource: 'native-task-lifecycle' }],
    tasksAvailable: true, tasksComplete: false, backgroundTasksComplete: true, tasksTruncated: false, dispatchChildren: [], dispatchChildrenAvailable: true,
    dispatchChildrenComplete: true, dispatchChildrenTruncated: false, partial: true } } } as unknown as Session);

it('keeps SDK task identity outside conversation navigation and does not infer total completeness from background levels', () => {
    const session = taskParent(), view = projectCodeLightNativeTasks(session);
    expect(view).toMatchObject({ present: true, available: true, complete: false });
    expect(view.rows[0]).toMatchObject({ nativeTaskId: 'sdk-task', kind: 'agent', status: 'running' });
    expect(view.rows[0]).not.toHaveProperty('nativeConversationId'); expect(view.rows[0]).not.toHaveProperty('targetSessionId');
    expect(projectCodeLightSubagents(session).rows).toEqual([]);
    expect(captureCurrentNativeTaskScope(session)?.cliSessionId).toBe('cli-parent');
});
it('retains tasks as unconfirmed for missing coverage, stale owner/query and disconnection, without a zero proof', () => {
    const empty = taskParent(); delete empty.agentState!.nativeTasks;
    expect(projectCodeLightNativeTasks(empty)).toMatchObject({ present: true, available: false, complete: false, rows: [] });
    for (const change of [
        (s: Session) => { s.metadata!.bridge!.source.runtimeGeneration = 'new-owner'; },
        (s: Session) => { s.agentState!.nativeQuery!.queryToken = 'new-query'; },
        (s: Session) => { s.metadata!.bridge!.sourceStatus = 'disconnected'; },
        (s: Session) => { s.agentState!.nativeTasks!.tasksAvailable = false; },
    ]) { const s = taskParent(); change(s); expect(projectCodeLightNativeTasks(s)).toMatchObject({ available: false, complete: false, rows: [{ status: 'unknown' }] }); }
    const foreign = taskParent(); foreign.agentState!.nativeTasks!.scope.nativeCollection = 'local-agent-mode-sessions';
    expect(projectCodeLightNativeTasks(foreign).native).toBeNull(); expect(captureCurrentNativeTaskScope(foreign)).toBeNull();
});
it('strips output/controls, bounds records and rejects duplicate native task IDs as current execution proof', () => {
    const s = taskParent(), native = s.agentState!.nativeTasks!;
    const parsed = NativeTasksSchema.parse({ ...native, logs: ['private'], state: { secret: 'private' }, tasks: [{ ...native.tasks[0], output: 'private', canStop: true }] });
    expect(parsed).not.toHaveProperty('logs'); expect(parsed).not.toHaveProperty('state'); expect(parsed.tasks[0]).not.toHaveProperty('output'); expect(parsed.tasks[0]).not.toHaveProperty('canStop');
    native.tasks.push({ ...native.tasks[0], status: 'completed' });
    expect(projectCodeLightNativeTasks(s)).toMatchObject({ available: false, rows: [{ status: 'unknown' }] });
    expect(NativeTasksSchema.safeParse({ ...native, tasks: Array(129).fill(native.tasks[0]) }).success).toBe(false);
});
it('retains cross-collection dispatch child host/owner and navigates only its exact real catalog record', () => {
    const parent = taskParent(), native = parent.agentState!.nativeTasks!;
    const host = 'local:claude-desktop:' + 'b'.repeat(64);
    native.dispatchChildren = [{ nativeConversationId: 'desktop-child', name: 'dispatch', nativeCollection: 'local-agent-mode-sessions', hostId: host,
        ownerGeneration: 'child-owner', status: 'pending', statusSource: 'native-collection-header' }];
    const child = taskParent(); child.id = 'child-relay'; child.metadata!.nativeSession = { title: 'dispatch', parentId: 'desktop-parent', isSubagent: true } as any;
    Object.assign(child.metadata!.bridge!.source, { appMode: 'chat', nativeCollection: 'local-agent-mode-sessions', id: 'desktop-child', hostId: host, runtimeGeneration: 'child-owner' });
    const row = projectCodeLightSubagents(parent, [child]).rows[0];
    expect(row).toMatchObject({ app: 'claude-desktop', parentHostId: native.scope.hostId, parentOwnerGeneration: 'parent-owner',
        hostId: host, ownerGeneration: 'child-owner', nativeCollection: 'local-agent-mode-sessions', status: 'pending', targetSessionId: 'child-relay' });
    expect(codeLightSubagentParent(child, [parent])?.id).toBe(parent.id); expect(nativeSubagentInputReadOnly(child)).toBe(true);
    child.metadata!.bridge!.source.runtimeGeneration = 'different-child-owner';
    expect(projectCodeLightSubagents(parent, [child]).rows[0].targetSessionId).toBeNull(); expect(codeLightSubagentParent(child, [parent])).toBeNull();
    child.metadata!.bridge!.source.runtimeGeneration = 'child-owner';
    expect(projectCodeLightSubagents(parent, [child, { ...child, id: 'duplicate' }]).rows[0].targetSessionId).toBeNull();
    native.dispatchChildren = []; expect(codeLightSubagentParent(child, [parent])).toBeNull();
});
