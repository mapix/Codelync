import * as React from 'react';
// @ts-expect-error The existing test renderer has no shipped declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Session } from '../sync/storageTypes';
import { projectCodeLightSubagents } from '../utils/codeLightSubagents';
import { codeLightSubagentInteractionLabels, codeLightSubagentLabels } from '../text/codeLightSubagentLabels';
import { SUPPORTED_LANGUAGE_CODES } from '../text/_all';

const mock = vi.hoisted(() => ({ catalogCalls: 0, themeCalls: 0, navigate: vi.fn(), observeNavigate: vi.fn(), language: 'en', sessions: {} as Record<string, any>, failed: false, readRetry: vi.fn() }));
vi.mock('react-native', () => ({ ActivityIndicator: 'Spinner', Pressable: 'Button', ScrollView: 'Scroll', Text: 'Text', View: 'View',
    FlatList: (props: any) => React.createElement('List', props, props.data.map((item: any) => React.createElement(React.Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item }))), !props.data.length && props.ListEmptyComponent, props.ListFooterComponent) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({}) }, useUnistyles: () => { mock.themeCalls++; return { theme: { colors: { textSecondary: 'gray', textDestructive: 'red', textLink: 'blue' } } }; } }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('@/sync/storage', () => ({ useAllSessions: () => { mock.catalogCalls++; return Object.values(mock.sessions); }, storage: { getState: () => ({ sessions: mock.sessions }) } }));
vi.mock('@/hooks/useNavigateToSession', () => ({ navigateToSession: mock.navigate, navigateToObservedSession: mock.observeNavigate }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => mock.language, t: (key: string) => key }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('./CodeLightSubagentActivity', () => ({ CodeLightSubagentActivity: 'Activity' }));
vi.mock('./CodeLightNativeTasks', () => ({ CodeLightNativeTasks: 'Tasks' }));
vi.mock('@/hooks/useCodeLightNativeTaskData', () => ({ useCodeLightNativeTaskData: (s: Session | null, expanded = false) => ({ native: s?.agentState?.nativeTasks ?? null, loading: false, failed: mock.failed,
    retry: () => { if (expanded) mock.readRetry(); } }) }));
vi.mock('@/sync/nativeTaskStore', () => ({ currentNativeTasksSnapshot: (s: Session | null) => s?.agentState?.nativeTasks ?? null }));
import { CodeLightSubagents, CodeLightSubagentRowsView } from './CodeLightSubagents';

const parent = () => ({ id: 'parent-relay', metadata: { machineId: 'mac', client: { id: 'noninvasive-bridge' }, bridge: {
    controlMode: 'session', sourceStatus: 'connected', source: { app: 'codex', kind: 'session', id: 'native-parent', hostId: 'local', runtimeGeneration: 'owner' } } },
    agentState: { subagentsAvailable: true, subagents: [{ id: 'native-child', name: 'worker', app: 'codex', nativeConversationId: 'native-child',
        parentConversationId: 'native-parent', hostId: 'local', ownerGeneration: 'owner', relationship: 'native-subagent', status: 'running' }] } }) as unknown as Session;
const child = () => ({ ...parent(), id: 'child-relay', metadata: { ...parent().metadata, bridge: { ...parent().metadata!.bridge,
    source: { ...parent().metadata!.bridge!.source, id: 'native-child' } } } }) as Session;
const texts = (screen: ReturnType<typeof create>) => screen.root.findAllByType('Text').map((node: any) => node.props.children).flat().join(' ');

it('subscribes to the child catalog only after expansion and routes the exact child identity', () => {
    const data = parent(); mock.language = 'en'; mock.catalogCalls = 0; mock.navigate.mockClear(); mock.observeNavigate.mockClear();
    mock.sessions = { [data.id]: data, 'child-relay': child() };
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodeLightSubagents, { session: data })); });
    expect(mock.catalogCalls).toBe(0); expect(texts(screen)).toContain('Subagents');
    act(() => screen.root.findByProps({ testID: 'codelight-subagents-toggle' }).props.onPress());
    expect(mock.catalogCalls).toBeGreaterThan(0); expect(texts(screen)).toContain('Running'); expect(texts(screen)).toContain('native-child');
    const row = screen.root.findByProps({ testID: 'codelight-subagent:native-child' });
    expect(row.props.disabled).toBe(false); act(() => row.props.onPress());
    expect(mock.observeNavigate).toHaveBeenCalledWith(expect.anything(), 'child-relay'); expect(mock.navigate).not.toHaveBeenCalled();
    delete mock.sessions['child-relay']; mock.observeNavigate.mockClear();
    act(() => row.props.onPress()); expect(mock.observeNavigate).not.toHaveBeenCalled();
    act(() => screen.unmount());
});
it('failed expanded subagents Retry uses the enabled parent reader and leaves cached children unconfirmed', () => {
    const data = parent(); mock.failed = true; mock.readRetry.mockClear(); mock.sessions = { [data.id]: data }; mock.language = 'en';
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodeLightSubagents, { session: data })); });
    act(() => screen.root.findByProps({ testID: 'codelight-subagents-toggle' }).props.onPress());
    expect(texts(screen)).toContain('could not be confirmed'); expect(screen.root.findAllByType('Spinner')).toHaveLength(0);
    act(() => screen.root.findByProps({ testID: 'codelight-subagents-read-retry' }).props.onPress());
    expect(mock.readRetry).toHaveBeenCalledOnce(); expect(mock.navigate).not.toHaveBeenCalled();
    act(() => screen.unmount()); mock.failed = false;
});
it('an incomplete empty subagent page stays unconfirmed instead of claiming no children', () => {
    const view = { present: true, available: true, complete: false, truncated: false, rows: [] };
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(CodeLightSubagentRowsView, { view, onSelect: vi.fn() })); });
    expect(texts(screen)).toContain('could not be confirmed'); expect(texts(screen)).not.toContain('No subagents in this session'); act(() => screen.unmount());
});

it('unavailable data has no zero counter and idle/stopped never render as completion', () => {
    const data = parent(); delete data.agentState!.subagents; mock.language = 'en';
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodeLightSubagents, { session: data })); });
    expect(texts(screen)).toContain('Unconfirmed'); expect(texts(screen)).not.toContain('0');
    act(() => screen.root.findByProps({ testID: 'codelight-subagents-toggle' }).props.onPress());
    expect(texts(screen)).toContain('Subagent status could not be confirmed. Try again.');
    act(() => screen.unmount());
    const base = parent(), native = base.agentState!.subagents![0];
    const view = projectCodeLightSubagents(base, [], [{ ...native, id: 'idle', status: 'idle' }, { ...native, id: 'stopped', status: 'stopped' }]);
    act(() => { screen = create(React.createElement(CodeLightSubagentRowsView, { view, onSelect: vi.fn() })); });
    expect(texts(screen)).toContain('Idle'); expect(texts(screen)).toContain('Stopped'); expect(texts(screen)).not.toContain('Completed');
    expect(screen.root.findByProps({ testID: 'codelight-subagent:idle' }).props.disabled).toBe(true);
    act(() => screen.unmount());
});

it('returns from an exact child to its evidenced parent and rejects a stale parent at tap time', () => {
    const root = parent(), worker = child(); worker.metadata!.nativeSession = { parentId: 'native-parent' } as any;
    mock.language = 'en'; mock.sessions = { [root.id]: root, [worker.id]: worker }; mock.navigate.mockClear();
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodeLightSubagents, { session: worker })); });
    const back = screen.root.findByProps({ testID: 'codelight-subagent-parent' });
    act(() => back.props.onPress()); expect(mock.navigate).toHaveBeenCalledWith(expect.anything(), root.id);
    root.agentState!.subagents = []; mock.navigate.mockClear();
    act(() => back.props.onPress()); expect(mock.navigate).not.toHaveBeenCalled();
    act(() => screen.unmount());
});

it('retains filter choice while a native child transitions and rerenders only the changed row', () => {
    const root = parent(), native = root.agentState!.subagents![0], onSelect = vi.fn(); mock.language = 'en';
    const rows = [native, { ...native, id: 'second', nativeConversationId: 'second', status: 'waiting' }];
    let view = projectCodeLightSubagents(root, [], rows), screen!: ReturnType<typeof create>;
    mock.themeCalls = 0;
    act(() => { screen = create(React.createElement(CodeLightSubagentRowsView, { view, onSelect })); });
    const before = mock.themeCalls;
    view = projectCodeLightSubagents(root, [], [{ ...native, status: 'completed' }, { ...rows[1] }]);
    act(() => screen.update(React.createElement(CodeLightSubagentRowsView, { view, onSelect })));
    expect(mock.themeCalls - before).toBe(1);
    act(() => screen.root.findByProps({ testID: 'codelight-subagents-filter:finished' }).props.onPress());
    expect(screen.root.findAllByProps({ testID: 'codelight-subagent:second' })).toHaveLength(0);
    expect(texts(screen)).toContain('Completed');
    view = projectCodeLightSubagents(root, [], [{ ...native, status: 'running' }, { ...rows[1] }]);
    act(() => screen.update(React.createElement(CodeLightSubagentRowsView, { view, onSelect })));
    expect(screen.root.findByProps({ testID: 'codelight-subagents-filter:finished' }).props.accessibilityState.selected).toBe(true);
    expect(texts(screen)).toContain('No matching subagents.');
    act(() => screen.unmount());
});

it('retains the complete translated agent identity in its accessible action label', () => {
    const root = parent(), native = root.agentState!.subagents![0], name = 'Storage consistency verification — Long multilingual worker 子代理';
    mock.language = 'pl';
    const view = projectCodeLightSubagents(root, [], [{ ...native, name, status: 'waiting' }]);
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodeLightSubagentRowsView, { view, onSelect: vi.fn() })); });
    const row = screen.root.findByProps({ testID: 'codelight-subagent:native-child' });
    expect(row.props.accessibilityLabel).toContain(name);
    expect(row.props.accessibilityLabel).toContain('Oczekuje na działanie');
    expect(row.props.accessibilityLabel).toContain('native-child');
    expect(row.props.accessibilityState.disabled).toBe(true);
    act(() => screen.unmount()); mock.language = 'en';
});

it('marks the observed roster partial without asserting an additional child exists', () => {
    const data = parent(); mock.language = 'en';
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodeLightSubagents, { session: data })); });
    expect(texts(screen)).toMatch(/1\s+· Partial list/);
    expect(texts(screen)).not.toContain('1+');
    act(() => screen.unmount());
});

it('does not render a displayed-row counter when the Antigravity full total is unknown', () => {
    const data = parent(); mock.language = 'en';
    Object.assign(data.metadata!.bridge!.source, { app: 'antigravity', protocol: 'antigravity-connect', hostId: 'local:antigravity:' + 'a'.repeat(64) });
    data.agentState!.subagents![0] = { ...data.agentState!.subagents![0], app: 'antigravity', hostId: data.metadata!.bridge!.source.hostId };
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodeLightSubagents, { session: data })); });
    expect(texts(screen)).toContain('Unconfirmed'); expect(texts(screen)).not.toMatch(/1\s+· Partial list/);
    act(() => screen.unmount());
});

it('bounds native-depth indentation to 24 pixels and updates ancestry without changing child identity', () => {
    const root = parent(), original = root.agentState!.subagents![0], onSelect = vi.fn(); mock.language = 'en';
    const direct = { ...original, app: 'antigravity' as const, nativeParentConversationId: 'native-parent', depth: 1, targetSessionId: 'child-relay' };
    const view = { present: true, available: true, complete: false, truncated: true, rows: [direct] };
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodeLightSubagentRowsView, { view, onSelect })); });
    const padding = () => screen.root.findByProps({ testID: 'codelight-subagent:native-child' }).parent.props.style[1];
    expect(padding()).toBeUndefined();
    const before = mock.themeCalls;
    act(() => screen.update(React.createElement(CodeLightSubagentRowsView, { view: { ...view, rows: [{ ...direct, nativeParentConversationId: 'actual-intermediate', depth: 2 }] }, onSelect })));
    expect(padding()).toEqual({ paddingLeft: 22 }); expect(mock.themeCalls - before).toBe(1);
    act(() => screen.update(React.createElement(CodeLightSubagentRowsView, { view: { ...view, rows: [{ ...direct, nativeParentConversationId: 'actual-intermediate', depth: 128 }] }, onSelect })));
    expect(padding()).toEqual({ paddingLeft: 38 });
    act(() => screen.root.findByProps({ testID: 'codelight-subagent:native-child' }).props.onPress());
    expect(onSelect).toHaveBeenCalledWith('native-child', 'native-child');
    expect(texts(screen)).toContain('Running'); expect(texts(screen)).not.toContain('actual-intermediate');
    act(() => screen.unmount());
});

it.each(SUPPORTED_LANGUAGE_CODES)('%s translates every execution state and uncertainty label', language => {
    const labels = codeLightSubagentLabels[language];
    expect(Object.keys(labels.status).sort()).toEqual(['completed', 'failed', 'idle', 'pending', 'running', 'stopped', 'unknown', 'waiting']);
    for (const text of [labels.title, labels.empty, labels.unavailable, labels.partial, ...Object.values(labels.status)]) expect(text.trim()).not.toBe('');
    const interaction = codeLightSubagentInteractionLabels[language];
    for (const text of [interaction.parent, interaction.noMatches, ...Object.values(interaction.filters)]) expect(text.trim()).not.toBe('');
    expect(labels.status.idle).not.toBe(labels.status.completed); expect(labels.status.stopped).not.toBe(labels.status.completed);
});
