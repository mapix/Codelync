import * as React from 'react';
import Module from 'node:module';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { darkTheme, lightTheme } from '@/theme';

let originalLoad: ((request: string, parent: unknown, isMain: boolean) => unknown) | undefined;

beforeAll(() => {
    const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
    originalLoad = mod._load;
    mod._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request.startsWith('@/assets/images/')) return 1;
        return originalLoad!.call(this, request, parent, isMain);
    };
});

afterAll(() => {
    if (originalLoad) {
        (Module as unknown as { _load: typeof originalLoad })._load = originalLoad;
    }
});

const state = vi.hoisted(() => ({
    dark: false,
    platform: 'ios' as 'ios' | 'android' | 'web',
    connected: true,
    socketStatus: 'connected' as 'connected' | 'connecting' | 'error',
    phase: 'loading' as 'idle' | 'loading' | 'complete' | 'error',
    found: 0,
    sessions: [] as any[],
    machines: [] as any[],
    rows: [] as any[],
    activities: vi.fn(),
    answer: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    scan: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    navigate: vi.fn(),
}));

vi.hoisted(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('__DEV__', false);
});

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        Platform: {
            get OS() { return state.platform; },
            select: (values: any) => values[state.platform] ?? values.default,
        },
        ActivityIndicator: host('ActivityIndicator'),
        FlatList: (props: any) => ReactModule.createElement(
            'FlatList',
            props,
            props.data.length === 0 ? props.ListEmptyComponent : props.data.map((item: any) => (
                ReactModule.createElement(ReactModule.Fragment, { key: item.key }, props.renderItem({ item }))
            )),
        ),
        Image: 'Image',
        KeyboardAvoidingView: 'KeyboardAvoidingView',
        Modal: host('Modal'),
        Pressable: host('Pressable'),
        ScrollView: host('ScrollView'),
        Text: host('Text'),
        TextInput: host('TextInput'),
        View: host('View'),
    };
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('react-native-unistyles', () => {
    const getTheme = () => (state.dark ? darkTheme : lightTheme);
    return {
        useUnistyles: () => ({ theme: getTheme() }),
        StyleSheet: {
            create: (factory: any) => typeof factory === 'function' ? factory(getTheme(), { insets: { top: 47, bottom: 34 } }) : factory,
            hairlineWidth: 1,
        },
    };
});

vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});

vi.mock('expo-router', () => ({ useRouter: () => ({ navigate: state.navigate, push: vi.fn() }) }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('@/components/StyledText', async () => {
    const ReactModule = await import('react');
    return { Text: (props: any) => ReactModule.createElement('Text', props, props.children) };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}), logo: () => ({}) } }));
vi.mock('@/text', () => ({
    getCurrentLanguage: () => 'en',
    t: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock('@/text/codelyncSubagentLabels', () => ({
    codelyncSubagentLabels: { en: { title: 'Subagents' } },
    codelyncSubagentKindLabels: { en: 'Subagent' },
}));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerConnected: () => state.connected } }));
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ sessions: {} }) },
    useSocketStatus: () => ({ status: state.socketStatus }),
    useSession: () => ({ id: 's1', metadata: { client: { id: 'noninvasive-bridge' } } }),
    useAllSessions: () => state.sessions,
    useAllMachines: () => state.machines,
}));
vi.mock('@/sync/ops', () => ({
    sessionAnswerQuestion: state.answer,
    sessionCancelCommunication: state.cancel,
}));
vi.mock('@/sync/codelyncLoadingProgress', () => ({
    useCodelyncDiscoveryProgress: () => ({ phase: state.phase, found: state.found }),
}));
vi.mock('@/sync/codelyncProjectActivity', () => ({
    codelyncProjectActivityStore: { mark: () => {}, markSessions: () => {} },
}));
vi.mock('@/hooks/useCodelyncProjectActivity', () => ({ useCodelyncProjectActivities: state.activities }));
vi.mock('@/hooks/useNavigateToSession', () => ({ navigateToSession: state.navigate }));
vi.mock('@/utils/codelyncSessionBrowser', () => ({
    isCodelyncNativeSession: () => true,
    isCodelyncConversation: (s: any) => s.metadata?.nativeSession?.isSubagent !== true,
    codelyncProjectKey: (s: any) => s.metadata?.nativeSession?.projectKey ?? 'project-1',
    buildCodelyncBrowserRows: () => state.rows,
}));
vi.mock('@/utils/sessionListTimestamp', () => ({ formatSessionListTimestamp: () => '12:00' }));
vi.mock('@/utils/codelyncSourceScope', () => ({ codelyncSourceLabel: () => 'Codex' }));
vi.mock('@/auth/CodelyncPairingProvider', () => ({
    useCodelyncPairing: () => ({ scan: state.scan, connect: state.connect, busy: false, error: null }),
}));
vi.mock('@/modal', () => ({ Modal: { prompt: vi.fn() } }));
vi.mock('./CodelyncProjectStatus', () => ({ CodelyncProjectStatus: () => null }));
vi.mock('./CodelyncSessionStatus', () => ({ CodelyncSessionStatus: () => null }));
vi.mock('./CodelyncBottomNavigation', () => ({ CodelyncBottomNavigation: () => null }));
vi.mock('./PeerChannelControl', () => ({ PeerChannelControl: () => null }));
vi.mock('@/assets/images/codelync-mark.png', () => ({ default: 1 }));
vi.mock('@/assets/images/codelync-connection.png', () => ({ default: 2 }));
vi.mock('./RoundButton', async () => {
    const ReactModule = await import('react');
    return { RoundButton: (props: any) => ReactModule.createElement('RoundButton', props) };
});
vi.mock('./onboarding/OnboardingScreen', async () => {
    const ReactModule = await import('react');
    return { OnboardingScreen: (props: any) => ReactModule.createElement('OnboardingScreen', props, props.content) };
});
vi.mock('./onboarding/OnboardingHeader', () => ({ OnboardingHeader: () => null }));

import { AgentQuestionBannerView } from './AgentQuestionBanner';
import { AgentQuestionModal } from './AgentQuestionModal';
import { CodelyncSessions } from './CodelyncSessions';
import { HappyEngineeringWordmark } from './onboarding/HappyEngineeringWordmark';
import { CodelyncScanScreen } from './onboarding/CodelyncScanScreen';

const pendingForm = {
    id: 'q-1',
    createdAt: 1,
    kind: 'form' as const,
    questions: [
        { id: 'pick', header: 'Choice', question: 'Select one option', options: [{ label: 'One' }, { label: 'Two' }], required: true, allowCustom: true },
    ],
};

beforeEach(() => {
    vi.clearAllMocks();
    state.dark = false;
    state.platform = 'ios';
    state.connected = true;
    state.socketStatus = 'connected';
    state.phase = 'loading';
    state.found = 0;
    state.sessions = [];
    state.machines = [];
    state.rows = [];
});

describe('Track D Batch 2 — R014 AgentQuestionModal & AgentQuestionBanner', () => {
    it('wraps modal content in iOS KeyboardAvoidingView, balances Cancel header target, and reflects disabled/error contrast', async () => {
        state.dark = true;
        state.connected = false;
        state.socketStatus = 'error';
        state.answer.mockRejectedValueOnce(new Error('Network write rejected'));

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(AgentQuestionModal, {
                pending: pendingForm,
                sessionId: 's1',
                visible: true,
                onClose: vi.fn(),
            }));
        });

        const kav = renderer.root.findByProps({ testID: 'codelync-question-keyboard-avoiding' });
        expect(kav.type).toBe('KeyboardAvoidingView');
        expect(kav.props.behavior).toBe('padding');

        const close = renderer.root.findByProps({ testID: 'codelync-question-close' });
        expect(close.props.accessibilityRole).toBe('button');
        expect(close.props.accessibilityLabel).toBe('common.cancel');
        expect(close.props.style).toMatchObject({ minWidth: 80, minHeight: 44 });

        // Select an option (must not auto-submit) and check writesBlocked dims Submit too
        act(() => renderer.root.findByProps({ testID: 'codelync-question-option-pick-0' }).props.onPress());
        expect(state.answer).not.toHaveBeenCalled();

        const submitBlocked = renderer.root.findByProps({ testID: 'codelync-question-submit' });
        expect(submitBlocked.props.disabled).toBe(true);
        expect(submitBlocked.props.accessibilityState.disabled).toBe(true);
        expect(submitBlocked.props.style.flat().some((s: any) => s?.opacity === 0.4)).toBe(true);

        // Reconnect and fail submit to inspect error text contrast and accessibilityLiveRegion
        state.connected = true;
        state.socketStatus = 'connected';
        act(() => {
            renderer.update(React.createElement(AgentQuestionModal, {
                pending: pendingForm,
                sessionId: 's1',
                visible: true,
                onClose: vi.fn(),
            }));
        });
        await act(async () => {
            await renderer.root.findByProps({ testID: 'codelync-question-submit' }).props.onPress();
        });
        const errorText = renderer.root.findByProps({ testID: 'codelync-question-error' });
        expect(errorText.props.accessibilityLiveRegion).toBe('polite');
        expect(errorText.props.style.flat()).toEqual(
            expect.arrayContaining([expect.objectContaining({ color: darkTheme.colors.warningCritical })]),
        );

        act(() => renderer.unmount());
    });

    it('unsupported dismiss exposes >=44pt hit target, accessibility labels, and disabled dimming', () => {
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(AgentQuestionBannerView, {
                pending: { id: 'u1', createdAt: 1, kind: 'unsupported', rawKind: 'approval', title: null },
                dismissDisabled: true,
                onDismiss: vi.fn(),
            }));
        });
        const dismiss = renderer.root.findByProps({ testID: 'codelync-question-dismiss' });
        expect(dismiss.props.accessibilityRole).toBe('button');
        expect(dismiss.props.accessibilityLabel).toBe('agentQuestion.dismiss');
        expect(dismiss.props.accessibilityState).toEqual({ disabled: true });
        expect(dismiss.props.style.flat()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ minHeight: 44 }),
                expect.objectContaining({ opacity: 0.45 }),
            ]),
        );

        act(() => {
            renderer.update(React.createElement(AgentQuestionBannerView, {
                pending: pendingForm,
                onPress: vi.fn(),
            }));
        });
        const open = renderer.root.findByProps({ testID: 'codelync-question-open' });
        expect(open.props.accessibilityRole).toBe('button');
        expect(open.props.accessibilityLabel).toContain('Choice');
        expect(open.props.accessibilityLabel).toContain('Select one option');
        act(() => renderer.unmount());
    });
});

describe('Track D Batch 2 — R019 CodelyncSessions & Onboarding asset polish', () => {
    it('shows initial loading spinner only during active non-error empty discovery, never on terminal error', () => {
        state.phase = 'loading';
        state.socketStatus = 'connected';
        state.found = 3;
        state.rows = [];

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncSessions));
        });
        const loadingBox = renderer.root.findByProps({ testID: 'codelync-sessions-loading' });
        expect(loadingBox.findAllByType('ActivityIndicator')).toHaveLength(1);
        expect(loadingBox.findByType('Text').props.children).toContain('codelyncLoading.discovered');

        state.socketStatus = 'error';
        act(() => renderer.unmount());
        act(() => {
            renderer = create(React.createElement(CodelyncSessions));
        });
        expect(renderer.root.findAllByProps({ testID: 'codelync-sessions-loading' })).toHaveLength(0);
        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it('exposes search accessibility, >=44pt subagent branch toggle with expanded state, project truncation, and deduplicates identical viewability ticks', () => {
        const projectSession = {
            id: 's-parent',
            metadata: { machineId: 'm1', path: '/repo', bridge: { source: { app: 'codex', id: 'nat-1', hostId: 'local' } }, nativeSession: { projectKey: 'proj-1' } },
        };
        state.phase = 'complete';
        state.sessions = [projectSession];
        state.machines = [{ id: 'm1', active: true, metadata: { codelync: { projectActivityVersion: 1 } } }];
        state.rows = [
            { kind: 'project', key: 'proj-1', sourceLabel: 'Codex', label: 'A Very Long Project Name That Should Truncate Cleanly', path: '/very/long/path', count: 2 },
            { kind: 'session', key: 's-parent', projectId: 'proj-1', session: projectSession, title: 'Main turn', children: 3, at: 1000 },
        ];

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncSessions));
        });

        const search = renderer.root.findByProps({ testID: 'codelync-session-search' });
        expect(search.props.accessibilityLabel).toBe('tools.names.search');
        expect(search.props.returnKeyType).toBe('search');

        const branch = renderer.root.findByProps({ testID: 'codelync-branch:s-parent' });
        expect(branch.props.accessibilityRole).toBe('button');
        expect(branch.props.accessibilityLabel).toBe('Subagents');
        expect(branch.props.accessibilityState).toEqual({ expanded: false });
        expect(branch.props.style).toMatchObject({ minWidth: 44, minHeight: 44 });
        act(() => branch.props.onPress());
        expect(renderer.root.findByProps({ testID: 'codelync-branch:s-parent' }).props.accessibilityState).toEqual({ expanded: true });

        const projectRow = renderer.root.findByProps({ testID: 'codelync-project:proj-1' });
        const titleNode = projectRow.findAllByType('Text').find((t: any) => t.props.numberOfLines === 2);
        expect(titleNode).toBeDefined();

        // Viewability callback populates project descriptor once and avoids re-allocating visibleSessions on identical items
        const stringifySpy = vi.spyOn(JSON, 'stringify');
        const list = renderer.root.findByType('FlatList');
        const viewableItems = [{ item: state.rows[0] }, { item: state.rows[1] }];
        act(() => list.props.onViewableItemsChanged({ viewableItems }));
        act(() => list.props.onViewableItemsChanged({ viewableItems }));
        expect(stringifySpy).not.toHaveBeenCalled();
        expect(state.activities).toHaveBeenCalled();
        expect(state.activities.mock.lastCall?.[0]).toEqual([
            {
                id: 'proj-1',
                machineId: 'm1',
                hostId: 'local',
                projectKey: 'proj-1',
                app: 'codex',
                sessions: [{ id: 's-parent', nativeId: 'nat-1' }],
            },
        ]);
        stringifySpy.mockRestore();
        act(() => renderer.unmount());
    });

    it('onboarding wordmark matches CodelyncMark squircle corner radius and scan artwork fits native 618:232 ratio cleanly', () => {
        let wordmark!: ReturnType<typeof create>;
        act(() => {
            wordmark = create(React.createElement(HappyEngineeringWordmark, { height: 84 }));
        });
        const markImage = wordmark.root.findByType('Image');
        expect(markImage.props.style).toMatchObject({
            width: 54,
            height: 54,
            borderRadius: 54 * 0.22,
        });
        act(() => wordmark.unmount());

        let scan!: ReturnType<typeof create>;
        act(() => {
            scan = create(React.createElement(CodelyncScanScreen));
        });
        const connImage = scan.root.findAllByType('Image')[1];
        expect(connImage.props.style).toMatchObject({
            width: 260,
            height: 98,
            borderRadius: 16,
            overflow: 'hidden',
        });
        act(() => scan.unmount());
    });
});
