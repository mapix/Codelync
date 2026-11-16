import * as React from 'react';
// @ts-expect-error The existing native renderer ships no declarations.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { codeLightTaskLabels, nativeTaskEventLabel } from '@/text/codeLightTaskLabels';
import { SUPPORTED_LANGUAGE_CODES } from '@/text/_all';
const mock = vi.hoisted(() => ({ tasks: vi.fn(), logs: vi.fn(), session: null as Session | null, active: true, peer: 'peer:A', appListeners: new Set<() => void>() }));
vi.mock('react-native', () => ({ ActivityIndicator: 'Spinner', Pressable: 'Button', Text: 'Text', View: 'View', Modal: (p: any) => p.visible ? React.createElement('Modal', p, p.children) : null,
    AppState: { addEventListener: (_event: string, callback: () => void) => { mock.appListeners.add(callback); return { remove: () => mock.appListeners.delete(callback) }; } },
    FlatList: (p: any) => React.createElement('List', p, p.data.map((item: any) => React.createElement(React.Fragment, { key: p.keyExtractor(item) }, p.renderItem({ item }))), p.data.length ? null : p.ListEmptyComponent, p.ListFooterComponent) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({}) }, useUnistyles: () => ({ theme: { colors: { textSecondary: 'gray' } } }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/sync/storage', () => ({ useSocketStatus: () => ({ status: 'connected' }), storage: { getState: () => ({ sessions: mock.session ? { [mock.session.id]: mock.session } : {} }) } }));
vi.mock('@/sync/nativeTasksRpc', () => ({ nativeTaskReader: { tasks: mock.tasks, logs: mock.logs } }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerConnected: () => true, peerIdentity: () => mock.peer, onStatusChange: () => () => {} }, getCurrentAppState: () => mock.active ? 'active' : 'background' }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://fixture.invalid' }));
vi.mock('expo-crypto', async () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async (_algorithm: string, text: string) => {
    const { createHash } = await import('node:crypto'); return createHash('sha256').update(text).digest('hex');
} }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
import { CodeLightNativeTasks } from './CodeLightNativeTasks';
import { nativeTaskCache } from '@/sync/nativeTaskStore';
beforeEach(() => { nativeTaskCache.clear(); mock.active = true; mock.peer = 'peer:A'; });

const session = () => ({ id: 'parent', metadata: { machineId: 'mac', client: { id: 'noninvasive-bridge' }, capabilities: { rpcMethods: ['native-task-read', 'native-task-log-read'] },
    bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null, source: { app: 'claude-desktop', kind: 'session', protocol: 'claude-desktop-native', appMode: 'code',
        nativeCollection: 'claude-code-sessions', hostId: 'local:claude-desktop:' + 'a'.repeat(64), id: 'desktop-parent', runtimeGeneration: 'owner' } } },
    agentState: { nativeQuery: { version: 1, app: 'claude-desktop', nativeConversationId: 'desktop-parent', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
        ownerGeneration: 'owner', queryToken: 'query', status: 'running', canSend: true, activeSendMode: 'queue', canCancel: true },
    nativeTasks: { version: 1, scope: { app: 'claude-desktop', nativeCollection: 'claude-code-sessions', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
        parentConversationId: 'desktop-parent', ownerGeneration: 'owner', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli' },
    tasks: [{ nativeTaskId: 'task', name: 'native worker', taskType: 'local_bash', kind: 'shell', status: 'paused', isBackgrounded: true, statusSource: 'native-task-lifecycle' }],
    tasksAvailable: true, tasksComplete: false, tasksTruncated: false, backgroundTasksComplete: true, partial: true,
    dispatchChildren: [], dispatchChildrenAvailable: false, dispatchChildrenComplete: false, dispatchChildrenTruncated: false } } }) as unknown as Session;
const page = (value: Session) => ({ scope: value.agentState!.nativeTasks!.scope, status: 'ok', available: true, hasMore: false, nextCursor: null, logs: [{ id: 'log-1', identity: 'local-log', sequence: 1,
    nativeTaskId: 'task', subtype: 'task_updated', taskType: 'local_bash', kind: 'shell', status: 'paused', nativeStatus: 'paused', nativeEventId: null, isBackgrounded: true, timestamp: null }] });
const texts = (screen: ReturnType<typeof create>) => screen.root.findAllByType('Text').map((node: any) => node.props.children).flat().join(' ');

it('reads only after expansion and explicit log selection, with 12-row metadata pages and no task/source controls', async () => {
    const value = session(); mock.session = value; mock.tasks.mockReset().mockResolvedValue(value.agentState!.nativeTasks); mock.logs.mockReset().mockResolvedValue(page(value));
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodeLightNativeTasks, { session: value })); });
    expect(mock.tasks).not.toHaveBeenCalled(); expect(mock.logs).not.toHaveBeenCalled(); expect(texts(screen)).toContain('Partial list');
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-tasks-toggle' }).props.onPress());
    expect(mock.tasks).toHaveBeenCalledOnce(); expect(texts(screen)).toContain('Shell'); expect(texts(screen)).toContain('Paused'); expect(texts(screen)).toContain('Background');
    expect(screen.root.findAllByProps({ testID: 'codelight-subagent:task' })).toHaveLength(0); expect(mock.logs).not.toHaveBeenCalled();
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-task-log:task' }).props.onPress());
    expect(mock.logs).toHaveBeenCalledExactlyOnceWith('parent', value.agentState!.nativeTasks!.scope, { taskId: 'task', before: null, limit: 12 });
    expect(texts(screen)).toContain('Status updated');
    act(() => screen.root.findByProps({ testID: 'codelight-native-task-log-close' }).props.onPress());
    expect(screen.root.findAllByProps({ testID: 'codelight-native-task-log-panel' })).toHaveLength(0);
    act(() => screen.unmount());
});
it('keeps missing task data unconfirmed without a zero or successful empty roster', async () => {
    const value = session(); delete value.agentState!.nativeTasks; mock.session = value; mock.tasks.mockClear(); mock.logs.mockClear();
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodeLightNativeTasks, { session: value })); });
    expect(texts(screen)).toContain('Unconfirmed'); expect(texts(screen)).not.toContain('0');
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-tasks-toggle' }).props.onPress());
    expect(texts(screen)).toContain('Task status could not be confirmed. Try again.'); expect(texts(screen)).not.toContain('No native tasks'); expect(mock.tasks).not.toHaveBeenCalled();
    act(() => screen.unmount());
});
it('an earlier activity failure retains the visible page and retries only its failed cursor', async () => {
    const value = session(); mock.session = value; mock.tasks.mockReset().mockResolvedValue(value.agentState!.nativeTasks);
    const latest = { ...page(value), hasMore: true, nextCursor: 'owned-older-cursor' };
    mock.logs.mockReset().mockResolvedValueOnce(latest).mockRejectedValueOnce(Error('PRIVATE_ACTIVITY_URL'))
        .mockResolvedValueOnce({ ...page(value), logs: [{ ...page(value).logs[0], id: 'older-log', sequence: 0 }] });
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodeLightNativeTasks, { session: value })); });
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-tasks-toggle' }).props.onPress());
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-task-log:task' }).props.onPress());
    const list = screen.root.findByProps({ testID: 'codelight-native-task-log-list' });
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-task-log-more' }).props.onPress());
    expect(screen.root.findByProps({ testID: 'codelight-native-task-log-list' }).props.data.map((row: any) => row.id)).toEqual(['log-1']);
    expect(texts(screen)).toContain('Task activity could not be loaded'); expect(texts(screen)).not.toContain('PRIVATE_ACTIVITY_URL');
    const retry = screen.root.findByProps({ testID: 'codelight-native-task-log-retry' }).props.onPress;
    await act(async () => { retry(); retry(); });
    expect(mock.logs.mock.calls.map(call => call[2].before)).toEqual([null, 'owned-older-cursor', 'owned-older-cursor']);
    expect(screen.root.findByProps({ testID: 'codelight-native-task-log-list' }).props.data.map((row: any) => row.id)).toEqual(['older-log', 'log-1']);
    expect(list.props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
    expect(texts(screen)).not.toContain('could not be loaded'); act(() => screen.unmount());
});
it('closes the scoped log immediately on a current owner/query change and rejects stale task row clicks', async () => {
    const value = session(); mock.session = value; mock.tasks.mockReset().mockResolvedValue(value.agentState!.nativeTasks); mock.logs.mockReset().mockResolvedValue(page(value));
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodeLightNativeTasks, { session: value })); });
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-tasks-toggle' }).props.onPress());
    const oldRow = screen.root.findByProps({ testID: 'codelight-native-task-log:task' });
    await act(async () => oldRow.props.onPress()); expect(texts(screen)).toContain('Status updated');
    const changed = session(); changed.agentState!.nativeQuery!.queryToken = 'other-query'; mock.session = changed;
    act(() => screen.update(React.createElement(CodeLightNativeTasks, { session: changed })));
    expect(screen.root.findAllByProps({ testID: 'codelight-native-task-log-panel' })).toHaveLength(0);
    expect(texts(screen)).not.toContain('Status updated');
    mock.logs.mockClear(); act(() => oldRow.props.onPress()); expect(mock.logs).not.toHaveBeenCalled();
    act(() => screen.unmount());
});
it('retries a failed metadata log read without replaying a native task command', async () => {
    const value = session(); mock.session = value; mock.tasks.mockReset().mockResolvedValue(value.agentState!.nativeTasks); mock.logs.mockReset().mockRejectedValueOnce(Error('Unavailable')).mockResolvedValueOnce(page(value));
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodeLightNativeTasks, { session: value })); });
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-tasks-toggle' }).props.onPress());
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-task-log:task' }).props.onPress());
    expect(texts(screen)).toContain('Task activity could not be loaded. Try again.');
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-task-log-retry' }).props.onPress());
    expect(mock.logs).toHaveBeenCalledTimes(2); expect(texts(screen)).toContain('Status updated'); act(() => screen.unmount());
});
it('does not let one expanded read hide newer native task metadata in the same owner/query scope', async () => {
    const value = session(); mock.session = value; mock.tasks.mockReset().mockResolvedValue(value.agentState!.nativeTasks); mock.logs.mockReset();
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodeLightNativeTasks, { session: value })); });
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-tasks-toggle' }).props.onPress());
    expect(texts(screen)).toContain('Paused');
    const fresh = session(); fresh.agentState!.nativeTasks!.tasks[0].status = 'completed'; mock.session = fresh;
    act(() => screen.update(React.createElement(CodeLightNativeTasks, { session: fresh })));
    expect(texts(screen)).toContain('Completed'); expect(texts(screen)).not.toContain('Paused'); expect(mock.tasks).toHaveBeenCalledOnce();
    act(() => screen.unmount());
});
it('closes the task log when its navigation screen becomes inactive', async () => {
    const value = session(); mock.session = value; mock.tasks.mockReset().mockResolvedValue(value.agentState!.nativeTasks); mock.logs.mockReset().mockResolvedValue(page(value));
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodeLightNativeTasks, { session: value, active: true })); });
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-tasks-toggle' }).props.onPress());
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-task-log:task' }).props.onPress());
    act(() => screen.update(React.createElement(CodeLightNativeTasks, { session: value, active: false })));
    expect(screen.root.findAllByProps({ testID: 'codelight-native-task-log-panel' })).toHaveLength(0);
    expect(screen.root.findByProps({ testID: 'codelight-native-task-log:task' }).props.disabled).toBe(true); expect(mock.logs).toHaveBeenCalledOnce();
    act(() => screen.unmount());
});
it.each(SUPPORTED_LANGUAGE_CODES)('%s labels task kinds, paused state and unavailable logs', language => {
    const labels = codeLightTaskLabels[language];
    for (const value of [labels.title, labels.unavailable, labels.empty, labels.logs, labels.loading, labels.emptyLogs, labels.more, labels.close, labels.background, labels.paused, labels.truncated, ...Object.values(labels.events), ...Object.values(labels.kinds)]) expect(value.trim()).not.toBe('');
    for (const [subtype, label] of [['task_started', labels.events.started], ['task_progress', labels.events.progress], ['task_updated', labels.events.updated],
        ['task_notification', labels.events.result], ['future_sdk_event', labels.events.activity]]) {
        expect(nativeTaskEventLabel(language, subtype)).toBe(label); expect(label).not.toMatch(/task_|sdk_/);
    }
});
it('shows native truncation even on the first page, without implying that retained rows are full history', async () => {
    const value = session(); mock.session = value; mock.tasks.mockReset().mockResolvedValue(value.agentState!.nativeTasks);
    mock.logs.mockReset().mockResolvedValue({ ...page(value), truncated: true });
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodeLightNativeTasks, { session: value })); });
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-tasks-toggle' }).props.onPress());
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-task-log:task' }).props.onPress());
    expect(texts(screen)).toContain('Only part of the activity is shown.');
    expect(screen.root.findAllByProps({ testID: 'codelight-native-task-log-more' })).toHaveLength(0); expect(mock.logs).toHaveBeenCalledOnce();
    act(() => screen.unmount());
});
it('stops older reads at 512 retained rows and a stale older button cannot trigger another read', async () => {
    const value = session(); mock.session = value; mock.tasks.mockReset().mockResolvedValue(value.agentState!.nativeTasks);
    let count = 0;
    mock.logs.mockReset().mockImplementation(async () => {
        const batch = count++;
        return { ...page(value), truncated: false, hasMore: true, nextCursor: 'cursor-' + count,
            logs: Array.from({ length: 12 }, (_, index) => ({ ...page(value).logs[0], id: `log-${batch}-${index}`, sequence: 1000 - batch * 12 - index, subtype: 'task_progress' })) };
    });
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodeLightNativeTasks, { session: value })); });
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-tasks-toggle' }).props.onPress());
    await act(async () => screen.root.findByProps({ testID: 'codelight-native-task-log:task' }).props.onPress());
    let staleOlder!: () => void;
    for (let i = 0; i < 42; i++) {
        staleOlder = screen.root.findByProps({ testID: 'codelight-native-task-log-more' }).props.onPress;
        await act(async () => staleOlder());
    }
    expect(mock.logs).toHaveBeenCalledTimes(43);
    expect(screen.root.findByProps({ testID: 'codelight-native-task-log-list' }).props.data).toHaveLength(512);
    expect(texts(screen)).toContain('Only part of the activity is shown.'); expect(texts(screen)).not.toContain('task_progress');
    expect(screen.root.findAllByProps({ testID: 'codelight-native-task-log-more' })).toHaveLength(0);
    await act(async () => staleOlder()); expect(mock.logs).toHaveBeenCalledTimes(43);
    act(() => screen.unmount());
});
it.each([['task_started', 'Started'], ['task_progress', 'Progress'], ['task_updated', 'Status updated'], ['task_notification', 'Result'], ['future_sdk_event', 'Activity']])(
    'renders human event %s without its internal SDK subtype', async (subtype, label) => {
        const value = session(); mock.session = value; mock.tasks.mockReset().mockResolvedValue(value.agentState!.nativeTasks);
        mock.logs.mockReset().mockResolvedValue({ ...page(value), logs: [{ ...page(value).logs[0], subtype }] });
        let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodeLightNativeTasks, { session: value })); });
        await act(async () => screen.root.findByProps({ testID: 'codelight-native-tasks-toggle' }).props.onPress());
        await act(async () => screen.root.findByProps({ testID: 'codelight-native-task-log:task' }).props.onPress());
        expect(texts(screen)).toContain(label); expect(texts(screen)).not.toContain(subtype);
        expect(screen.root.findAllByProps({ testID: 'codelight-native-task-log-truncated' })).toHaveLength(0);
        act(() => screen.unmount());
    });
