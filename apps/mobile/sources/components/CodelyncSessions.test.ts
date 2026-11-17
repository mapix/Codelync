import React from 'react';
// @ts-expect-error The existing test renderer has no shipped declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), phase: 'loading', status: 'connected', session: { id: 'known-session', metadata: {} },
    sessions: null as any, machines: [] as any[], rows: null as any, activities: vi.fn() }));
vi.mock('react-native', () => ({ ActivityIndicator: 'Spinner', FlatList: 'List', Pressable: 'Button', Text: 'Text', TextInput: 'Input', View: 'View' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({}) }, useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray' } } }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('@/sync/storage', () => ({ useAllSessions: () => mocks.sessions ?? [mocks.session], useAllMachines: () => mocks.machines, useSocketStatus: () => ({ status: mocks.status }) }));
vi.mock('@/sync/codelyncLoadingProgress', () => ({ useCodelyncDiscoveryProgress: () => ({ phase: mocks.phase, found: 0 }) }));
vi.mock('@/sync/sync', () => ({ sync: { refreshSessions: vi.fn() } }));
vi.mock('@/hooks/useNavigateToSession', () => ({ navigateToSession: mocks.navigate }));
vi.mock('@/utils/codelyncSessionBrowser', () => ({ isCodelyncNativeSession: () => true, isCodelyncConversation: (session: any) => session.metadata.nativeSession?.isSubagent !== true,
    codelyncProjectKey: (session: any) => session.metadata.nativeSession?.projectKey ?? 'project',
    buildCodelyncBrowserRows: () => mocks.rows ?? [{ kind: 'session', key: 'known', projectId: 'project', session: mocks.session, title: 'Known session' }] }));
vi.mock('@/utils/sessionListTimestamp', () => ({ formatSessionListTimestamp: () => '' }));
vi.mock('@/hooks/useCodelyncProjectActivity', () => ({ useCodelyncProjectActivities: mocks.activities }));
vi.mock('@/sync/codelyncProjectActivity', () => ({ codelyncProjectActivityStore: { mark: () => {}, markSessions: () => {} } }));
vi.mock('./CodelyncProjectStatus', () => ({ CodelyncProjectStatus: () => null }));
vi.mock('./CodelyncSessionStatus', () => ({ CodelyncSessionStatus: () => null }));
vi.mock('./CodelyncBottomNavigation', () => ({ CodelyncBottomNavigation: () => null }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/useCodelyncConnectionState', () => ({ useCodelyncConnectionState: () => ({ state: { kind: mocks.status === 'connected' ? 'connected' : mocks.status === 'connecting' ? 'connecting' : 'failed' } }) }));
vi.mock('./CodelyncConnectionNotice', () => ({ CodelyncConnectionNotice: () => React.createElement('MacNotice', { status: mocks.status }) }));
vi.mock('./PeerChannelControl', () => ({ PeerChannelControl: (props: any) => React.createElement('PeerControl', props) }));
import { CodelyncSessions } from './CodelyncSessions';
it('known rows remain pressable during title synchronization and an obsolete connection error', () => {
    for (const state of [{ phase: 'loading', status: 'connected' }, { phase: 'error', status: 'connecting' }]) {
        Object.assign(mocks, state); mocks.navigate.mockClear();
        let screen!: ReturnType<typeof create>, row!: ReturnType<typeof create>;
        act(() => { screen = create(React.createElement(CodelyncSessions)); });
        const list = screen.root.findByType('List');
        act(() => { row = create(list.props.renderItem({ item: list.props.data[0] })); });
        const button = row.root.findByType('Button'); expect(button.props.disabled).not.toBe(true);
        act(() => button.props.onPress()); expect(mocks.navigate).toHaveBeenCalledWith(expect.anything(), 'known-session');
        expect(screen.root.findAllByType('Text').map((node: any) => node.props.children)).not.toContain('codelyncLoading.titles');
        expect(screen.root.findAllByType('Text').map((node: any) => node.props.children)).not.toContain('codelyncLoading.failed');
        act(() => { row.unmount(); screen.unmount(); });
    }
});

it('terminal connection failure does not spin or hide cached browsing behind title loading', () => {
    mocks.phase = 'loading'; mocks.status = 'error'; let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodelyncSessions)); });
    expect(screen.root.findAllByType('Spinner')).toHaveLength(0);
    expect(screen.root.findAllByType('MacNotice')).toHaveLength(0);
    expect(screen.root.findByType('PeerControl').props).toMatchObject({ presentation: 'header', directory: true });
    expect(screen.root.findByType('List').props.data).toHaveLength(1);
    expect(screen.root.findAllByType('Text').map((n: any) => n.props.children)).not.toContain('codelyncLoading.titles');
    act(() => screen.unmount()); mocks.phase = 'loading'; mocks.status = 'connected';
});

it('a visible cross-project subagent uses the parent display interest without creating its own descriptor', () => {
    const parent = { id: 'parent', metadata: { machineId: 'machine', path: '/repo', bridge: { source: { app: 'codex', id: 'native-parent', hostId: 'local' } }, nativeSession: { projectKey: 'parent-project' } } };
    const child = { id: 'child', metadata: { machineId: 'machine', path: '/worktree', bridge: { source: { app: 'codex', id: 'native-child', hostId: 'local' } }, nativeSession: { projectKey: 'child-project', isSubagent: true } } };
    mocks.sessions = [child, parent]; mocks.machines = [{ id: 'machine', active: true, metadata: { codelync: { projectActivityVersion: 1 } } }];
    mocks.rows = [{ kind: 'session', key: child.id, projectId: 'parent-project', session: child, title: 'Worker' }];
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodelyncSessions)); });
    act(() => screen.root.findByType('List').props.onViewableItemsChanged({ viewableItems: [{ item: mocks.rows[0] }] }));
    expect(mocks.activities.mock.lastCall?.[0]).toEqual([{ id: 'parent-project', machineId: 'machine', hostId: 'local', projectKey: 'parent-project', app: 'codex',
        sessions: [{ id: 'child', nativeId: 'native-child' }] }]);
    act(() => screen.unmount()); mocks.sessions = null; mocks.machines = []; mocks.rows = null;
});

it('cached directory preserves the same list, row data and header control throughout socket flapping', () => {
    const Component = (CodelyncSessions as unknown as { type: React.ComponentType }).type;
    mocks.sessions = [mocks.session]; mocks.phase = 'complete'; mocks.status = 'connected'; let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(Component)); });
    const list = screen.root.findByType('List'), data = list.props.data, header = screen.root.findByType('PeerControl');
    for (const status of ['connecting', 'error', 'connected']) {
        mocks.status = status; act(() => screen.update(React.createElement(Component)));
        expect(screen.root.findByType('List')).toBe(list); expect(list.props.data).toBe(data); expect(screen.root.findByType('PeerControl')).toBe(header);
        expect(screen.root.findAllByType('MacNotice')).toHaveLength(0); expect(screen.root.findAllByType('Spinner')).toHaveLength(0);
    }
    act(() => screen.unmount()); mocks.sessions = null;
});
