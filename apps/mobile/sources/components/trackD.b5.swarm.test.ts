import * as React from 'react';
// @ts-expect-error react-test-renderer has no local declaration file in this workspace
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';

const lightThemeFixture = {
    dark: false,
    colors: {
        text: '#000000',
        textSecondary: '#8E8E93',
        textDestructive: '#FF3B30',
        textLink: '#2BACCC',
        surface: '#ffffff',
        divider: '#eaeaea',
        groupped: { background: '#F2F2F7' },
    },
};

const darkThemeFixture = {
    dark: true,
    colors: {
        text: '#ffffff',
        textSecondary: '#8E8E93',
        textDestructive: '#FF453A',
        textLink: '#2BACCC',
        surface: '#161616',
        divider: '#2A2A2A',
        groupped: { background: '#000000' },
    },
};

const state = vi.hoisted(() => ({
    theme: {
        dark: false,
        colors: {
            text: '#000000',
            textSecondary: '#8E8E93',
            textDestructive: '#FF3B30',
            textLink: '#2BACCC',
            surface: '#ffffff',
            divider: '#eaeaea',
            groupped: { background: '#F2F2F7' },
        },
    } as any,
    progress: { phase: 'error', revalidating: false, revalidationFailed: false } as any,
    selectionState: 'selected' as string,
    connected: true,
    active: true,
    sessions: {} as Record<string, any>,
    retrySession: vi.fn(),
    visibleSession: vi.fn(),
    nativeTasksData: { native: null as any, loading: false, failed: false, retry: vi.fn() },
    logs: vi.fn(),
    output: vi.fn(),
}));

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
    Modal: (p: any) => (p.visible ? React.createElement('Modal', p, p.children) : null),
    AppState: { addEventListener: () => ({ remove: () => {} }) },
    FlatList: (p: any) => React.createElement(
        'FlatList',
        p,
        (p.data ?? []).map((item: any, idx: number) =>
            React.createElement(React.Fragment, { key: p.keyExtractor ? p.keyExtractor(item, idx) : idx }, p.renderItem({ item, index: idx })),
        ),
        !(p.data?.length) ? p.ListEmptyComponent : null,
        p.ListFooterComponent,
    ),
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 0.5,
        create: (arg: any) =>
            typeof arg === 'function'
                ? new Proxy({}, { get: (_t, prop) => arg(state.theme)[prop as string] })
                : arg,
    },
    useUnistyles: () => ({ theme: state.theme }),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ navigate: vi.fn(), push: vi.fn() }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({
    getCurrentLanguage: () => 'en',
    t: (key: string) => (key === 'common.retry' ? 'Retry' : key),
}));
vi.mock('@/sync/codelyncLoadingProgress', () => ({
    useCodelyncMessageProgress: () => state.progress,
}));
vi.mock('@/sync/codelyncSessionSelection', () => ({
    useCodelyncSelectionState: () => state.selectionState,
}));
vi.mock('@/sync/storage', () => ({
    useSession: (id: string) => state.sessions[id] ?? null,
    useSessionMessages: () => ({ messages: [{ id: 'm1', kind: 'user-text', text: 'Saved message' }] }),
    useAllSessions: () => Object.values(state.sessions),
    useSocketStatus: () => ({ status: state.connected ? 'connected' : 'error' }),
    storage: { getState: () => ({ sessions: state.sessions }) },
}));
vi.mock('@/sync/persistence', () => ({ loadSessionDrafts: () => ({}) }));
vi.mock('@/sync/sync', () => ({
    sync: {
        onSessionVisible: state.visibleSession,
        retryCodelyncSession: state.retrySession,
    },
}));
vi.mock('@/utils/nativeParentControl', () => ({ nativeParentControl: () => false, nativeSubagentInputReadOnly: () => false }));
vi.mock('@/utils/nativeSavedHistory', () => ({ codelyncSavedHistory: () => false }));
vi.mock('./NativeParentControl', () => ({ NativeParentControl: 'NativeParentControl' }));
vi.mock('./NativeSavedHistoryBanner', () => ({ NativeSavedHistoryBanner: 'NativeSavedHistoryBanner' }));
vi.mock('@/hooks/useNavigateToSession', () => ({ navigateToSession: vi.fn(), navigateToObservedSession: vi.fn() }));
vi.mock('./CodelyncSubagentActivity', () => ({ CodelyncSubagentActivity: 'CodelyncSubagentActivity' }));
vi.mock('@/hooks/useCodelyncNativeTaskData', () => ({
    useCodelyncNativeTaskData: () => state.nativeTasksData,
}));
vi.mock('@/sync/nativeTaskStore', () => ({
    currentNativeTasksSnapshot: (s: Session | null) => s?.agentState?.nativeTasks ?? null,
}));
vi.mock('@/sync/nativeTasksRpc', () => ({
    nativeTaskReader: { logs: state.logs, output: state.output },
}));
vi.mock('@/sync/apiSocket', () => ({
    apiSocket: { peerConnected: () => state.connected, peerIdentity: () => 'peer:A' },
    getCurrentAppState: () => (state.active ? 'active' : 'background'),
}));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://fixture.invalid' }));
vi.mock('@/sync/noninvasiveRpc', () => ({ runNoninvasiveRpc: vi.fn(), recoverNoninvasiveRpcDetailed: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn().mockResolvedValue(false) } }));

import { CodelyncSessionLoading } from './CodelyncSessionLoading';
import { NativeSessionUnavailable } from './NativeSessionUnavailable';
import { NativeSourceBanner } from './NativeSourceBanner';
import { CodelyncSubagentRowsView } from './CodelyncSubagents';
import { CodelyncNativeTasks } from './CodelyncNativeTasks';
import { CodelyncNativeTaskActions } from './CodelyncNativeTaskActions';

function flattenStyle(style: any): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    if (typeof style === 'object') return style;
    return {};
}

function claudeScope() {
    return {
        app: 'claude-desktop' as const,
        nativeCollection: 'claude-code-sessions' as const,
        hostId: 'local:claude-desktop:' + 'a'.repeat(64),
        parentConversationId: 'desktop-parent',
        ownerGeneration: 'owner',
        runtimeGeneration: 'runtime',
        queryToken: 'query',
        cliSessionId: 'cli',
    };
}

function taskSession(): Session {
    const scope = claudeScope();
    const task = {
        nativeTaskId: 'task-1',
        name: 'Build bundle',
        taskType: 'local_bash',
        kind: 'shell' as const,
        status: 'running' as const,
        isBackgrounded: true,
        statusSource: 'native-task-lifecycle',
    };
    const native = {
        version: 1 as const,
        scope,
        tasks: [task],
        tasksAvailable: true,
        tasksComplete: true,
        tasksTruncated: false,
        backgroundTasksComplete: true,
        partial: false,
        dispatchChildren: [],
        dispatchChildrenAvailable: true,
        dispatchChildrenComplete: true,
        dispatchChildrenTruncated: false,
    };
    return {
        id: 'parent',
        metadata: {
            machineId: 'mac',
            client: { id: 'noninvasive-bridge' },
            capabilities: {
                readOnly: false,
                nativeTaskControls: { version: 1, outputTaskTypes: ['local_bash'], stopTaskTypes: ['local_bash'] },
                rpcMethods: ['native-task-read', 'native-task-log-read', 'native-task-output-read', 'native-task-stop'],
            },
            bridge: {
                controlMode: 'session',
                sourceStatus: 'connected',
                currentTurnId: null,
                source: {
                    app: scope.app,
                    kind: 'session',
                    protocol: 'claude-desktop-native',
                    appMode: 'code',
                    nativeCollection: scope.nativeCollection,
                    hostId: scope.hostId,
                    id: scope.parentConversationId,
                    runtimeGeneration: scope.ownerGeneration,
                },
            },
        },
        agentState: {
            nativeQuery: {
                version: 1,
                app: scope.app,
                nativeConversationId: scope.parentConversationId,
                hostId: scope.hostId,
                ownerGeneration: scope.ownerGeneration,
                queryToken: scope.queryToken,
                status: 'running',
                canSend: true,
                activeSendMode: 'queue',
                canCancel: true,
            },
            nativeTasks: native,
        },
    } as unknown as Session;
}

describe('Track D Batch 5 — R044 & R049 polish', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.theme = lightThemeFixture;
        state.progress = { phase: 'error', revalidating: false, revalidationFailed: false };
        state.selectionState = 'selected';
        state.connected = true;
        state.active = true;
        state.sessions = {};
        state.nativeTasksData = { native: null, loading: false, failed: false, retry: vi.fn() };
    });

    it('R044: CodelyncSessionLoading, NativeSessionUnavailable, and NativeSourceBanner enforce 44pt targets, divider contrast, and busy dimming', async () => {
        state.theme = darkThemeFixture;
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncSessionLoading, { sessionId: 's1', initial: false, older: true, topInset: 40 }));
        });
        const loadingBar = renderer.root.findByProps({ testID: 'codelync-session-loading' });
        expect(loadingBar.props.style.backgroundColor).toBe('#161616');
        expect(loadingBar.props.style.borderWidth).toBe(1);
        expect(loadingBar.props.style.borderColor).toBe('#2A2A2A');
        const loadingRetry = renderer.root.findByType('Pressable');
        expect(loadingRetry.props.accessibilityLabel).toBe('Retry');
        expect(loadingRetry.props.style.minHeight).toBeGreaterThanOrEqual(44);
        expect(loadingRetry.props.style.minWidth).toBeGreaterThanOrEqual(44);
        act(() => renderer.unmount());

        // NativeSessionUnavailable: busy dimming + 44pt Retry/Back + bottom list padding
        let resolveRetry!: () => void;
        const onRetry = vi.fn(() => new Promise<void>(r => { resolveRetry = r; }));
        act(() => {
            renderer = create(React.createElement(NativeSessionUnavailable, {
                sessionId: 's1',
                known: null,
                loading: false,
                topInset: 50,
                onRetry,
                onBack: vi.fn(),
            }));
        });
        const unavailableRetry = renderer.root.findByProps({ testID: 'codelync-unavailable-retry' });
        const unavailableBack = renderer.root.findByProps({ testID: 'codelync-unavailable-back' });
        expect(unavailableRetry.props.style.minHeight).toBeGreaterThanOrEqual(44);
        expect(unavailableRetry.props.style.minWidth).toBeGreaterThanOrEqual(44);
        expect(unavailableRetry.props.style.opacity).toBe(1);
        expect(unavailableBack.props.style.minWidth).toBeGreaterThanOrEqual(44);
        expect(renderer.root.findByType('FlatList').props.contentContainerStyle.paddingBottom).toBeGreaterThanOrEqual(24);

        await act(async () => {
            unavailableRetry.props.onPress();
        });
        const dimmedRetry = renderer.root.findByProps({ testID: 'codelync-unavailable-retry' });
        expect(dimmedRetry.props.disabled).toBe(true);
        expect(dimmedRetry.props.accessibilityState).toEqual({ disabled: true, busy: true });
        expect(dimmedRetry.props.style.opacity).toBe(0.45);
        await act(async () => {
            resolveRetry();
        });
        act(() => renderer.unmount());

        // NativeSourceBanner: theme surface/divider border, plain object styles, and busy dimming during revalidation retry
        const sess = taskSession();
        sess.metadata!.bridge!.sourceStatus = 'owner-unavailable';
        state.sessions[sess.id] = sess;
        state.progress = { phase: 'complete', revalidating: false, revalidationFailed: true };
        let resolveBannerRetry!: () => void;
        state.retrySession.mockImplementationOnce(() => new Promise<void>(r => { resolveBannerRetry = r; }));
        act(() => {
            renderer = create(React.createElement(NativeSourceBanner, { sessionId: sess.id, topInset: 60 }));
        });
        const banner = renderer.root.findByProps({ testID: 'codelync-cached-session-check' });
        expect(banner.props.style.paddingTop).toBe(74);
        expect(banner.props.style.backgroundColor).toBe('#161616');
        expect(banner.props.style.borderBottomWidth).toBe(1);
        const bannerRetry = renderer.root.findByProps({ testID: 'codelync-retry-session-sync' });
        expect(bannerRetry.props.style.minHeight).toBe(44);
        expect(bannerRetry.props.style.minWidth).toBeGreaterThanOrEqual(44);
        await act(async () => {
            bannerRetry.props.onPress();
        });
        const busyBannerRetry = renderer.root.findByProps({ testID: 'codelync-retry-session-sync' });
        expect(busyBannerRetry.props.disabled).toBe(true);
        expect(busyBannerRetry.props.accessibilityState).toEqual({ disabled: true, busy: true });
        expect(busyBannerRetry.props.style.opacity).toBe(0.45);
        await act(async () => {
            resolveBannerRetry();
        });
        act(() => renderer.unmount());
    });

    it('R049: CodelyncSubagentRowsView dims disabled log icons and pads list bottom', () => {
        const view = {
            present: true,
            available: true,
            complete: true,
            truncated: false,
            rows: [{
                id: 'child-unlinked',
                name: 'Worker',
                app: 'codex' as const,
                nativeConversationId: 'child-1',
                parentConversationId: 'parent-1',
                hostId: 'local',
                ownerGeneration: 'owner',
                relationship: 'native-subagent' as const,
                status: 'idle' as const,
                targetSessionId: null,
            }],
        };
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncSubagentRowsView, { view, onSelect: vi.fn() }));
        });
        const logBtn = renderer.root.findByProps({ testID: 'codelync-subagent-log:child-unlinked' });
        expect(logBtn.props.disabled).toBe(true);
        expect(flattenStyle(logBtn.props.style).opacity).toBe(0.45);
        const list = renderer.root.findByProps({ testID: 'codelync-subagents-list' });
        expect(flattenStyle(list.props.contentContainerStyle).paddingBottom).toBeGreaterThanOrEqual(8);
        act(() => renderer.unmount());
    });

    it('R049: CodelyncNativeTasks adapts modal backdrop/border for light & dark, pads safe edges, and dims busy/disabled buttons', async () => {
        const sess = taskSession();
        state.sessions[sess.id] = sess;
        state.nativeTasksData = { native: sess.agentState!.nativeTasks, loading: false, failed: false, retry: vi.fn() };
        state.logs.mockResolvedValue({
            scope: sess.agentState!.nativeTasks!.scope,
            status: 'ok',
            available: true,
            hasMore: true,
            nextCursor: 'next-1',
            logs: [{
                id: 'l1',
                identity: 'log',
                sequence: 1,
                nativeTaskId: 'task-1',
                subtype: 'task_progress',
                taskType: 'local_bash',
                kind: 'shell',
                status: 'running',
                nativeStatus: 'running',
                nativeEventId: null,
                isBackgrounded: true,
                timestamp: null,
            }],
        });

        state.theme = darkThemeFixture;
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncNativeTasks, { session: sess, active: true }));
        });
        await act(async () => {
            renderer.root.findByProps({ testID: 'codelync-native-tasks-toggle' }).props.onPress();
        });
        await act(async () => {
            renderer.root.findByProps({ testID: 'codelync-native-task-log:task-1' }).props.onPress();
        });

        const sheet = renderer.root.findByProps({ testID: 'codelync-native-task-log-panel' });
        const overlayStyle = flattenStyle(sheet.parent.props.style);
        expect(overlayStyle.paddingTop).toBeGreaterThanOrEqual(48);
        expect(overlayStyle.paddingBottom).toBeGreaterThanOrEqual(36);
        const backdropNode = sheet.parent.findAll((n: any) => n.type === 'Pressable' && n.props?.accessibilityLabel === 'Close')[0];
        expect(flattenStyle(backdropNode.props.style).backgroundColor).toBe('rgba(0,0,0,0.56)');
        expect(flattenStyle(sheet.props.style).borderColor).toBe('#2A2A2A');

        const logList = renderer.root.findByProps({ testID: 'codelync-native-task-log-list' });
        expect(flattenStyle(logList.props.contentContainerStyle).paddingBottom).toBeGreaterThanOrEqual(14);

        // Switching to light theme updates backdrop opacity for light surfaces
        state.theme = lightThemeFixture;
        act(() => {
            renderer.update(React.createElement(CodelyncNativeTasks, { session: { ...sess }, active: true }));
        });
        const lightSheet = renderer.root.findByProps({ testID: 'codelync-native-task-log-panel' });
        const lightBackdrop = lightSheet.parent.findAll((n: any) => n.type === 'Pressable' && n.props?.accessibilityLabel === 'Close')[0];
        expect(flattenStyle(lightBackdrop.props.style).backgroundColor).toBe('rgba(0,0,0,0.28)');

        // Busy "More" button dims to 0.45
        let resolveMore!: (v: any) => void;
        state.logs.mockImplementationOnce(() => new Promise(r => { resolveMore = r; }));
        await act(async () => {
            renderer.root.findByProps({ testID: 'codelync-native-task-log-more' }).props.onPress();
        });
        const busyMore = renderer.root.findByProps({ testID: 'codelync-native-task-log-more' });
        expect(busyMore.props.disabled).toBe(true);
        expect(flattenStyle(busyMore.props.style).opacity).toBe(0.45);
        await act(async () => {
            resolveMore({ scope: sess.agentState!.nativeTasks!.scope, status: 'ok', available: true, hasMore: false, nextCursor: null, logs: [] });
        });
        act(() => renderer.unmount());
    });

    it('R049: CodelyncNativeTaskActions dims disabled Stop & loading Output buttons and strengthens dark output modal', async () => {
        const sess = taskSession();
        state.sessions[sess.id] = sess;
        state.connected = false; // blocks Stop
        state.theme = darkThemeFixture;
        let resolveOut!: (v: any) => void;
        state.output.mockImplementationOnce(() => new Promise(r => { resolveOut = r; }));

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncNativeTaskActions, {
                sessionId: sess.id,
                native: sess.agentState!.nativeTasks!,
                scope: sess.agentState!.nativeTasks!.scope,
                task: sess.agentState!.nativeTasks!.tasks[0],
                active: true,
            }));
        });
        const stopBtn = renderer.root.findByProps({ testID: 'codelync-native-task-stop:task-1' });
        expect(stopBtn.props.disabled).toBe(true);
        expect(flattenStyle(stopBtn.props.style).opacity).toBe(0.45);

        await act(async () => {
            renderer.root.findByProps({ testID: 'codelync-native-task-output:task-1' }).props.onPress();
        });
        const loadingOutputBtn = renderer.root.findByProps({ testID: 'codelync-native-task-output:task-1' });
        expect(loadingOutputBtn.props.disabled).toBe(true);
        expect(loadingOutputBtn.props.accessibilityState).toEqual({ disabled: true, busy: true });
        expect(flattenStyle(loadingOutputBtn.props.style).opacity).toBe(0.45);

        const outSheet = renderer.root.findByProps({ testID: 'codelync-native-task-output-panel' });
        expect(flattenStyle(outSheet.parent.props.style).paddingBottom).toBeGreaterThanOrEqual(36);
        const backdrop = outSheet.parent.findAll((n: any) => n.type === 'Pressable')[0];
        expect(flattenStyle(backdrop.props.style).backgroundColor).toBe('rgba(0,0,0,0.56)');

        await act(async () => {
            resolveOut({ scope: sess.agentState!.nativeTasks!.scope, taskId: 'task-1', output: 'done', truncated: false });
        });
        const scroll = outSheet.findByType('ScrollView');
        expect(flattenStyle(scroll.props.contentContainerStyle).paddingBottom).toBeGreaterThanOrEqual(16);
        act(() => renderer.unmount());
    });
});
