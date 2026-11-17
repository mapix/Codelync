import * as React from 'react';
// @ts-expect-error The native renderer package has no declarations.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
const mocks = vi.hoisted(() => ({ session: null as Session | null, connected: true, active: true, peer: 'peer:A', output: vi.fn(), journal: vi.fn(), recover: vi.fn(), confirm: vi.fn() }));
vi.mock('react-native', () => ({ ActivityIndicator: 'Spinner', Pressable: 'Button', ScrollView: 'Scroll', Text: 'Text', View: 'View',
    Modal: (p: any) => p.visible ? React.createElement('Modal', p, p.children) : null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({}) }, useUnistyles: () => ({ theme: { colors: { textSecondary: 'gray' } } }) }));
vi.mock('@/sync/storage', () => ({ useSocketStatus: () => ({ status: mocks.connected ? 'connected' : 'error' }), storage: { getState: () => ({ sessions: mocks.session ? { [mocks.session.id]: mocks.session } : {} }) } }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerConnected: () => mocks.connected, peerIdentity: () => mocks.peer }, getCurrentAppState: () => mocks.active ? 'active' : 'background' }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'local' }));
vi.mock('@/sync/nativeTasksRpc', () => ({ nativeTaskReader: { output: mocks.output } }));
vi.mock('@/sync/noninvasiveRpc', () => ({ runNoninvasiveRpc: mocks.journal, recoverNoninvasiveRpcDetailed: mocks.recover }));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
import { CodelyncNativeTaskActions } from './CodelyncNativeTaskActions';

function fixture() {
    const scope = { app: 'claude-desktop' as const, nativeCollection: 'claude-code-sessions' as const, hostId: 'local:claude-desktop:' + 'a'.repeat(64),
        parentConversationId: 'native-parent', ownerGeneration: 'owner', runtimeGeneration: 'runtime', queryToken: 'query', cliSessionId: 'cli' };
    const task = { nativeTaskId: 'task-A', name: 'Worker A', taskType: 'local_bash', kind: 'shell' as const, status: 'running' as const, isBackgrounded: true, statusSource: 'native-task-lifecycle' };
    const native = { version: 1 as const, scope, tasks: [task], tasksAvailable: true, tasksComplete: true, tasksTruncated: false, backgroundTasksComplete: true,
        partial: false, dispatchChildren: [], dispatchChildrenAvailable: true, dispatchChildrenComplete: true, dispatchChildrenTruncated: false };
    const session = { id: 'parent', metadata: { client: { id: 'noninvasive-bridge' }, capabilities: { readOnly: false,
        nativeTaskControls: { version: 1, outputTaskTypes: ['local_bash'], stopTaskTypes: ['local_bash'] }, rpcMethods: ['native-task-output-read', 'native-task-stop'] },
        bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null, source: { app: scope.app, kind: 'session', protocol: 'claude-desktop-native',
            appMode: 'code', nativeCollection: scope.nativeCollection, id: scope.parentConversationId, hostId: scope.hostId, runtimeGeneration: scope.ownerGeneration } } },
        agentState: { nativeQuery: { version: 1, app: scope.app, nativeConversationId: scope.parentConversationId, hostId: scope.hostId,
            ownerGeneration: scope.ownerGeneration, queryToken: scope.queryToken, status: 'running', canSend: true, activeSendMode: 'queue', canCancel: true }, nativeTasks: native } } as unknown as Session;
    return { scope, task, native, session, props: { sessionId: session.id, native, scope, task, active: true } };
}
beforeEach(() => { vi.clearAllMocks(); mocks.connected = true; mocks.active = true; mocks.peer = 'peer:A'; mocks.confirm.mockResolvedValue(true); mocks.journal.mockResolvedValue({}); });

it('keeps missing types disabled, while readonly policy permits admitted output and rejects Stop', () => {
    const f = fixture(); f.session.metadata!.capabilities!.nativeTaskControls!.outputTaskTypes = [];
    f.session.metadata!.capabilities!.nativeTaskControls!.stopTaskTypes = []; mocks.session = f.session;
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodelyncNativeTaskActions, f.props)); });
    for (const suffix of ['output', 'stop']) expect(screen.root.findByProps({ testID: `codelync-native-task-${suffix}:task-A` }).props.disabled).toBe(true);
    expect(mocks.output).not.toHaveBeenCalled(); expect(mocks.journal).not.toHaveBeenCalled();
    f.session.metadata!.capabilities!.nativeTaskControls = { version: 1, outputTaskTypes: ['local_bash'], stopTaskTypes: ['local_bash'] };
    f.session.metadata!.capabilities!.readOnly = true; act(() => screen.update(React.createElement(CodelyncNativeTaskActions, f.props)));
    expect(screen.root.findByProps({ testID: 'codelync-native-task-output:task-A' }).props.disabled).toBe(false);
    expect(screen.root.findByProps({ testID: 'codelync-native-task-stop:task-A' }).props.disabled).toBe(true);
    act(() => screen.unmount());
});
it('reads admitted output from a readonly source only on a press and drops its panel when inactive', async () => {
    const f = fixture(); f.session.metadata!.capabilities!.readOnly = true;
    mocks.session = f.session; mocks.output.mockResolvedValue({ scope: f.scope, taskId: 'task-A', output: 'BOUNDED_FIXTURE', truncated: true });
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodelyncNativeTaskActions, f.props)); });
    expect(mocks.output).not.toHaveBeenCalled();
    await act(async () => screen.root.findByProps({ testID: 'codelync-native-task-output:task-A' }).props.onPress());
    expect(mocks.output).toHaveBeenCalledExactlyOnceWith('parent', f.scope, 'task-A'); expect(mocks.journal).not.toHaveBeenCalled();
    expect(screen.root.findAllByProps({ testID: 'codelync-native-task-output-truncated' })).toHaveLength(1);
    expect(screen.root.findAllByType('Text').some((n: any) => n.props.selectable && n.props.children === 'BOUNDED_FIXTURE')).toBe(true);
    act(() => screen.update(React.createElement(CodelyncNativeTaskActions, { ...f.props, active: false })));
    expect(screen.root.findAllByProps({ testID: 'codelync-native-task-output-panel' })).toHaveLength(0);
    act(() => screen.update(React.createElement(CodelyncNativeTaskActions, f.props)));
    expect(screen.root.findAllByProps({ testID: 'codelync-native-task-output-panel' })).toHaveLength(0); expect(mocks.output).toHaveBeenCalledOnce();
    act(() => screen.unmount());
});
it('confirms the specific task and blocks duplicate presses while pending or after an unknown result', async () => {
    const f = fixture(); mocks.session = f.session; let finish!: (v: boolean) => void;
    mocks.confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; })); mocks.journal.mockRejectedValue(Error('Unknown receipt'));
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodelyncNativeTaskActions, f.props)); });
    const oldButton = screen.root.findByProps({ testID: 'codelync-native-task-stop:task-A' });
    await act(async () => { oldButton.props.onPress(); oldButton.props.onPress(); });
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith('Stop this task?', 'Worker A', { destructive: true, confirmText: 'Stop' });
    expect(mocks.journal).not.toHaveBeenCalled();
    await act(async () => finish(true));
    expect(mocks.journal).toHaveBeenCalledExactlyOnceWith('parent', 'native-task-stop', { scope: f.scope, taskId: 'task-A' });
    expect(screen.root.findByProps({ testID: 'codelync-native-task-stop:task-A' }).props.disabled).toBe(true);
    act(() => screen.unmount());
});
it('does not dispatch Stop if the owner changes while the native confirmation is open', async () => {
    const f = fixture(); mocks.session = f.session; let finish!: (v: boolean) => void;
    mocks.confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodelyncNativeTaskActions, f.props)); });
    await act(async () => screen.root.findByProps({ testID: 'codelync-native-task-stop:task-A' }).props.onPress());
    f.session.metadata!.bridge!.source.runtimeGeneration = 'new-owner';
    await act(async () => finish(true)); expect(mocks.journal).not.toHaveBeenCalled(); act(() => screen.unmount());
});
it('HTTP-good task metadata stays readable while socket loss disables Stop and rejects a captured button', async () => {
    const f = fixture(); mocks.session = f.session; let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodelyncNativeTaskActions, f.props)); });
    const stop = screen.root.findByProps({ testID: 'codelync-native-task-stop:task-A' }).props.onPress;
    mocks.connected = false; act(() => screen.update(React.createElement(CodelyncNativeTaskActions, f.props)));
    expect(screen.root.findByProps({ testID: 'codelync-native-task-stop:task-A' }).props.disabled).toBe(true);
    expect(screen.root.findByProps({ testID: 'codelync-native-task-output:task-A' }).props.disabled).toBe(false);
    await act(async () => stop()); expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.journal).not.toHaveBeenCalled();
    mocks.connected = true; act(() => screen.update(React.createElement(CodelyncNativeTaskActions, f.props)));
    expect(screen.root.findByProps({ testID: 'codelync-native-task-stop:task-A' }).props.disabled).toBe(false); expect(mocks.journal).not.toHaveBeenCalled(); act(() => screen.unmount());
});
it('failed output is retryable as one scoped read, clears the error and never dispatches a task command', async () => {
    const f = fixture(); mocks.session = f.session;
    mocks.output.mockRejectedValueOnce(Error('PRIVATE_URL_TOKEN')).mockResolvedValueOnce({ scope: f.scope, taskId: 'task-A', output: 'Retained output', truncated: false });
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodelyncNativeTaskActions, f.props)); });
    await act(async () => screen.root.findByProps({ testID: 'codelync-native-task-output:task-A' }).props.onPress());
    const text = () => screen.root.findAllByType('Text').map((n: any) => n.props.children).join(' ');
    expect(text()).toContain('Task output could not be loaded'); expect(text()).not.toContain('PRIVATE_URL_TOKEN'); expect(screen.root.findAllByType('Spinner')).toHaveLength(0);
    const retry = screen.root.findByProps({ testID: 'codelync-native-task-output-retry' }).props.onPress;
    await act(async () => { retry(); retry(); });
    expect(mocks.output).toHaveBeenCalledTimes(2); expect(mocks.journal).not.toHaveBeenCalled(); expect(text()).toContain('Retained output'); expect(text()).not.toContain('could not be loaded');
    act(() => screen.unmount());
});
it('closing a pending output does not let its late result reopen the panel', async () => {
    const f = fixture(); mocks.session = f.session; let finish!: (v: any) => void;
    mocks.output.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodelyncNativeTaskActions, f.props)); });
    await act(async () => screen.root.findByProps({ testID: 'codelync-native-task-output:task-A' }).props.onPress());
    act(() => screen.root.findByProps({ testID: 'codelync-native-task-output-close' }).props.onPress());
    await act(async () => finish({ scope: f.scope, taskId: 'task-A', output: 'Late output', truncated: false }));
    expect(screen.root.findAllByProps({ testID: 'codelync-native-task-output-panel' })).toHaveLength(0); act(() => screen.unmount());
});
it('unknown Stop offers only a coalesced original-command check, including a completed task or readonly source', async () => {
    const f = fixture(); mocks.session = f.session; mocks.journal.mockRejectedValueOnce(Object.assign(Error('PRIVATE_STOP_ERROR'), { commandId: 'original-stop' }));
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodelyncNativeTaskActions, f.props)); });
    await act(async () => screen.root.findByProps({ testID: 'codelync-native-task-stop:task-A' }).props.onPress());
    f.task.status = 'stopped' as 'running'; f.session.metadata!.capabilities!.readOnly = true;
    act(() => screen.update(React.createElement(CodelyncNativeTaskActions, f.props)));
    let finish!: (v: any) => void; mocks.recover.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const check = screen.root.findByProps({ testID: 'codelync-native-task-check-result' }); expect(check.props.disabled).toBe(false);
    await act(async () => { check.props.onPress(); check.props.onPress(); });
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith('parent', 'native-task-stop', { scope: f.scope, taskId: 'task-A' }, 'original-stop');
    expect(mocks.journal).toHaveBeenCalledOnce(); expect(screen.root.findByProps({ testID: 'codelync-native-task-check-result' }).props.disabled).toBe(true);
    await act(async () => finish({ confirmed: true, pending: { commandId: 'original-stop' }, result: { requested: true } }));
    expect(screen.root.findAllByProps({ testID: 'codelync-native-task-check-result' })).toHaveLength(0);
    expect(screen.root.findAllByType('Text').map((n: any) => n.props.children)).toContain('Stop requested'); act(() => screen.unmount());
});
it.each(['peer', 'scope', 'foreign-receipt', 'missing'])('an unknown Stop %s cannot confirm or resubmit the original action', async change => {
    const f = fixture(); mocks.session = f.session; mocks.journal.mockRejectedValueOnce(Object.assign(Error('Unknown'), { commandId: 'original-stop' }));
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodelyncNativeTaskActions, f.props)); });
    await act(async () => screen.root.findByProps({ testID: 'codelync-native-task-stop:task-A' }).props.onPress());
    const oldCheck = screen.root.findByProps({ testID: 'codelync-native-task-check-result' }).props.onPress;
    if (change === 'peer') mocks.peer = 'peer:other';
    if (change === 'scope') f.session.agentState!.nativeQuery!.queryToken = 'foreign-query';
    if (change === 'foreign-receipt') mocks.recover.mockResolvedValueOnce({ confirmed: true, pending: { commandId: 'foreign-stop' } });
    if (change === 'missing') mocks.recover.mockResolvedValueOnce({ confirmed: false });
    await act(async () => oldCheck());
    expect(mocks.journal).toHaveBeenCalledOnce(); expect(mocks.recover).toHaveBeenCalledTimes(change === 'peer' || change === 'scope' ? 0 : 1);
    expect(screen.root.findAllByType('Text').map((n: any) => n.props.children)).not.toContain('Stop requested'); act(() => screen.unmount());
});
