import * as React from 'react';
import { createHash } from 'node:crypto';
// @ts-expect-error The existing renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { nativeTaskDigestText, nativeTaskSignal, nativeTaskTransfer } from '@codelync/wire/native-tasks';
import type { NativeTasks } from '@/sync/nativeTasks';
import type { Session } from '@/sync/storageTypes';
const mock = vi.hoisted(() => ({ read: vi.fn(), active: true, peer: 'peer:A', sessions: {} as Record<string, Session>, app: new Set<() => void>() }));
vi.mock('react-native', () => ({ ActivityIndicator: 'Spinner', Pressable: 'Button', ScrollView: 'Scroll', Text: 'Text', View: 'View',
    AppState: { addEventListener: (_name: string, callback: () => void) => { mock.app.add(callback); return { remove: () => mock.app.delete(callback) }; } },
    Modal: (p: any) => p.visible ? React.createElement('Modal', p, p.children) : null,
    FlatList: (p: any) => React.createElement('List', p, p.data.map((item: any) => React.createElement(React.Fragment, { key: p.keyExtractor(item) }, p.renderItem({ item }))), p.data.length ? null : p.ListEmptyComponent, p.ListFooterComponent) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({}) }, useUnistyles: () => ({ theme: { colors: { textSecondary: 'gray' } } }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('@/hooks/useNavigateToSession', () => ({ navigateToSession: vi.fn() }));
vi.mock('./CodelyncSubagentActivity', () => ({ CodelyncSubagentActivity: 'Activity' }));
vi.mock('@/sync/storage', () => ({ useSocketStatus: () => ({ status: 'connected' }), storage: { getState: () => ({ sessions: mock.sessions }) }, useAllSessions: () => Object.values(mock.sessions) }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerConnected: () => true, peerIdentity: () => mock.peer, onStatusChange: () => () => {} }, getCurrentAppState: () => mock.active ? 'active' : 'background' }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://fixture.invalid' }));
vi.mock('@/sync/nativeTasksRpc', () => ({ nativeTaskReader: { tasks: mock.read, logs: vi.fn() } }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
vi.mock('expo-crypto', async () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async (_algorithm: string, text: string) => {
    const { createHash } = await import('node:crypto'); return createHash('sha256').update(text).digest('hex');
} }));
import { CodelyncSubagents } from './CodelyncSubagents';
import { nativeTaskCache, currentNativeTasksSnapshot } from '@/sync/nativeTaskStore';
import { codelyncSubagentParent } from '@/utils/codelyncSubagents';
beforeEach(() => { nativeTaskCache.clear(); mock.active = true; mock.peer = 'peer:A'; mock.read.mockReset(); mock.sessions = {}; });
const snapshot = (): NativeTasks => ({ version: 1, scope: { app: 'claude-desktop', nativeCollection: 'claude-code-sessions', parentConversationId: 'parent',
    hostId: 'local:claude-desktop:' + 'a'.repeat(64), ownerGeneration: 'owner', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli' },
    tasks: Array.from({ length: 12 }, (_, i) => ({ nativeTaskId: 'task-' + i, name: 'worker ' + i, taskType: 'local_agent', kind: 'agent' as const, status: 'running' as const, isBackgrounded: false, statusSource: 'native-task-lifecycle' })),
    dispatchChildren: [{ nativeConversationId: 'child', name: 'child before', nativeCollection: 'local-agent-mode-sessions', hostId: 'local:claude-desktop:' + 'b'.repeat(64), ownerGeneration: 'child-owner', status: 'running', statusSource: 'native-collection-header' }],
    tasksAvailable: true, tasksComplete: true, tasksTruncated: false, backgroundTasksComplete: false, dispatchChildrenAvailable: true,
    dispatchChildrenComplete: true, dispatchChildrenTruncated: false, partial: false });
const signed = (value: NativeTasks): NativeTasks => ({ ...value, digest: createHash('sha256').update(nativeTaskDigestText(value)).digest('hex') });
const parent = (native: NativeTasks): Session => ({ id: 'parent-relay', metadata: { machineId: 'mac', client: { id: 'noninvasive-bridge' }, capabilities: { rpcMethods: ['native-task-read', 'native-task-log-read'], send: true },
    bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null, source: { app: 'claude-desktop', kind: 'session', protocol: 'claude-desktop-native', appMode: 'code',
        nativeCollection: native.scope.nativeCollection, hostId: native.scope.hostId, id: native.scope.parentConversationId, runtimeGeneration: native.scope.ownerGeneration } } },
    agentState: { nativeTaskSignal: nativeTaskSignal(native), nativeQuery: { version: 1, app: 'claude-desktop', nativeConversationId: native.scope.parentConversationId,
        hostId: native.scope.hostId, ownerGeneration: native.scope.ownerGeneration, queryToken: native.scope.queryToken, status: 'running', canSend: true, activeSendMode: 'queue', canCancel: true } } }) as unknown as Session;
const child = (p: Session): Session => ({ ...p, id: 'child-relay', metadata: { ...p.metadata, nativeSession: { title: 'child', parentId: 'parent', isSubagent: true },
    bridge: { ...p.metadata!.bridge, source: { ...p.metadata!.bridge!.source, id: 'child', hostId: 'local:claude-desktop:' + 'b'.repeat(64), nativeCollection: 'local-agent-mode-sessions', appMode: 'chat', runtimeGeneration: 'child-owner' } } } }) as unknown as Session;
const text = (screen: ReturnType<typeof create>) => screen.root.findAllByType('Text').map((n: any) => n.props.children).flat().join(' ');
it('keeps Tasks collapsed while expanded Subagents fetches full then delta, with passive parent lookup and untouched controls', async () => {
    const a = signed(snapshot()), value = parent(a), worker = child(value), query = value.agentState!.nativeQuery, controls = value.metadata!.capabilities;
    mock.sessions = { [value.id]: value, [worker.id]: worker }; mock.read.mockResolvedValueOnce(a);
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodelyncSubagents, { session: value })); });
    expect(mock.read).not.toHaveBeenCalled(); expect(value.agentState).not.toHaveProperty('nativeTasks');
    await act(async () => screen.root.findByProps({ testID: 'codelync-subagents-toggle' }).props.onPress());
    expect(mock.read).toHaveBeenCalledExactlyOnceWith(value.id, a.scope, undefined); expect(text(screen)).toContain('child before');
    expect(screen.root.findAllByProps({ testID: 'codelync-native-task-list' })).toHaveLength(0);
    expect(codelyncSubagentParent(worker, [value], currentNativeTasksSnapshot)?.id).toBe(value.id); expect(mock.read).toHaveBeenCalledOnce();
    const target = snapshot(); target.tasks[0].status = 'completed'; target.dispatchChildren[0].name = 'child after'; const b = signed(target), delta = nativeTaskTransfer(a, b);
    expect(delta.kind).toBe('native-task-delta'); const next = { ...value, agentState: { ...value.agentState, nativeTaskSignal: nativeTaskSignal(b) } } as Session;
    mock.sessions[value.id] = next; mock.read.mockResolvedValueOnce(delta);
    await act(async () => screen.update(React.createElement(CodelyncSubagents, { session: next })));
    expect(mock.read.mock.calls[1]).toEqual([value.id, b.scope, a.digest]); expect(text(screen)).toContain('child after');
    expect(next.agentState!.nativeQuery).toBe(query); expect(next.metadata!.capabilities).toBe(controls); expect(next.agentState).not.toHaveProperty('nativeTasks');
    act(() => screen.unmount());
});
it('starts no delta while collapsed or background and foreground resumes from the last accepted digest', async () => {
    const a = signed(snapshot()), value = parent(a); mock.sessions[value.id] = value; mock.read.mockResolvedValueOnce(a);
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodelyncSubagents, { session: value })); });
    await act(async () => screen.root.findByProps({ testID: 'codelync-subagents-toggle' }).props.onPress());
    act(() => screen.root.findByProps({ testID: 'codelync-subagents-toggle' }).props.onPress());
    const target = snapshot(); target.tasks[1].status = 'paused'; const b = signed(target), next = parent(b); mock.sessions[next.id] = next;
    await act(async () => screen.update(React.createElement(CodelyncSubagents, { session: next }))); expect(mock.read).toHaveBeenCalledOnce();
    mock.active = false; act(() => { for (const listener of mock.app) listener(); });
    await act(async () => screen.root.findByProps({ testID: 'codelync-subagents-toggle' }).props.onPress()); expect(mock.read).toHaveBeenCalledOnce();
    mock.read.mockResolvedValueOnce(nativeTaskTransfer(a, b)); mock.active = true;
    await act(async () => { for (const listener of mock.app) listener(); });
    expect(mock.read.mock.calls[1]).toEqual([value.id, b.scope, a.digest]); expect(mock.read).toHaveBeenCalledTimes(2);
    act(() => screen.unmount());
});
it('keeps expanded inactive navigation screens passive while the current screen still coalesces reads', async () => {
    const a = signed(snapshot()), value = parent(a); mock.sessions[value.id] = value; mock.read.mockResolvedValueOnce(a);
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodelyncSubagents, { session: value, active: true })); });
    await act(async () => screen.root.findByProps({ testID: 'codelync-subagents-toggle' }).props.onPress());
    await act(async () => screen.root.findByProps({ testID: 'codelync-native-tasks-toggle' }).props.onPress());
    expect(mock.read).toHaveBeenCalledOnce();
    const target = snapshot(); target.tasks[0].status = 'completed'; const b = signed(target), next = parent(b); mock.sessions[next.id] = next;
    await act(async () => screen.update(React.createElement(CodelyncSubagents, { session: next, active: false })));
    expect(mock.read).toHaveBeenCalledOnce(); mock.read.mockResolvedValueOnce(nativeTaskTransfer(a, b));
    await act(async () => screen.update(React.createElement(CodelyncSubagents, { session: next, active: true })));
    expect(mock.read).toHaveBeenCalledTimes(2); expect(mock.read.mock.calls[1][2]).toBe(a.digest);
    act(() => screen.unmount());
});
