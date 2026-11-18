import * as React from 'react';
// @ts-expect-error react-test-renderer has no local declaration file in this workspace
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, NativeModelControlScope } from '@/sync/storageTypes';
import type { AgentTextMessage } from '@/sync/typesMessage';

const state = vi.hoisted(() => ({
    dark: false,
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
    sessions: {} as Record<string, any>,
    machines: {} as Record<string, any>,
    rpcReject: false,
    refresh: vi.fn<() => Promise<void>>(async () => {}),
    updateDraft: vi.fn(),
    navigate: vi.fn(),
}));

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const themeFixture = () => ({
    dark: state.dark,
    colors: {
        text: state.dark ? '#ffffff' : '#000000',
        textDestructive: state.dark ? '#FF453A' : '#FF3B30',
        textSecondary: '#8E8E93',
        textLink: '#2BACCC',
        warningCritical: state.dark ? '#FF453A' : '#FF3B30',
        surface: state.dark ? '#161616' : '#ffffff',
        divider: state.dark ? '#2A2A2A' : '#eaeaea',
        shadow: { color: '#000000', opacity: 0.1 },
        groupped: { background: state.dark ? '#000000' : '#F2F2F7' },
    },
});

vi.mock('react-native', () => {
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        ActivityIndicator: host('ActivityIndicator'),
        Alert: { alert: vi.fn() },
        AppState: { addEventListener: () => ({ remove() {} }) },
        FlatList: (props: any) => React.createElement(
            'FlatList',
            props,
            props.data.length === 0
                ? props.ListEmptyComponent
                : props.data.map((item: any) => React.createElement(React.Fragment, { key: item.id }, props.renderItem({ item }))),
        ),
        Modal: (props: any) => props.visible ? React.createElement('Modal', props, props.children) : null,
        Pressable: ({ children, ...rest }: any) => React.createElement(
            'Pressable',
            rest,
            typeof children === 'function' ? children({ pressed: false }) : children,
        ),
        ScrollView: host('ScrollView'),
        Text: host('Text'),
        TextInput: host('TextInput'),
        View: host('View'),
    };
});

vi.mock('expo-image', () => ({ Image: 'ExpoImage' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => state.insets,
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 0.5,
        absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
        create: (arg: any) =>
            typeof arg === 'function'
                ? new Proxy({}, { get: (_t, prop) => arg(themeFixture())[prop as string] })
                : arg,
    },
    useUnistyles: () => ({ theme: themeFixture() }),
}));
vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@/text', () => ({
    getCurrentLanguage: () => 'en',
    t: (key: string) => key,
}));
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            sessions: state.sessions,
            machines: state.machines,
            updateSessionDraft: state.updateDraft,
        }),
        subscribe: () => () => {},
    },
    useSession: (id: string) => state.sessions[id] ?? null,
    useAllSessions: () => Object.values(state.sessions),
    useAllMachines: () => Object.values(state.machines),
}));
vi.mock('@/sync/sync', () => ({ sync: { refreshSessions: state.refresh } }));
vi.mock('@/sync/apiSocket', () => ({ getCurrentAppState: () => 'active' }));
vi.mock('@/sync/noninvasiveRpc', () => ({
    runNoninvasiveRpc: async () => {
        if (state.rpcReject) throw new Error('rpc-failed');
    },
}));
vi.mock('@/hooks/useDraft', () => ({ useDraft: () => {}, flushNativeDraft: () => {} }));
vi.mock('@/hooks/useAttachmentImage', () => ({
    useAttachmentImage: () => ({ uri: null, loading: false, error: false }),
}));
vi.mock('@/hooks/useNavigateToSession', () => ({ navigateToSession: state.navigate }));
vi.mock('@/modal', () => ({ Modal: { show: vi.fn(), alert: vi.fn(), prompt: vi.fn() } }));
vi.mock('./NativeWindowViewer', () => ({ NativeWindowViewer: () => null }));
vi.mock('./NativeSourceBanner', () => ({ NativeSourceBanner: 'NativeSourceBanner' }));

import { NativeWindowPanel } from './NativeWindowPanel';
import { NativeReadonlyModelCatalog } from './NativeReadonlyModelCatalog';
import { CodelyncHandoff } from './CodelyncHandoff';
import { NativeParentControl } from './NativeParentControl';

function flattenStyle(style: any): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    if (typeof style === 'function') return flattenStyle(style({ pressed: false }));
    if (typeof style === 'object') return style;
    return {};
}

function modelCatalogFixture() {
    const scope: NativeModelControlScope = {
        app: 'claude-desktop',
        appMode: 'code',
        nativeCollection: 'claude-code-sessions',
        nativeConversationId: 'native',
        hostId: 'local:claude-desktop:' + 'a'.repeat(64),
        ownerGeneration: 'owner',
        runtimeGeneration: 'main',
        queryToken: 'query',
        cliSessionId: 'cli',
        settingsToken: 'b'.repeat(64),
    };
    const session = {
        id: 'relay',
        metadata: {
            client: { id: 'noninvasive-bridge' },
            nativeDesktopRuntimeGeneration: 'main',
            capabilities: { readOnly: true },
            bridge: {
                currentTurnId: null,
                controlMode: 'session',
                sourceStatus: 'connected',
                source: {
                    app: scope.app,
                    appMode: scope.appMode,
                    nativeCollection: scope.nativeCollection,
                    id: scope.nativeConversationId,
                    hostId: scope.hostId,
                    kind: 'session',
                    protocol: 'claude-desktop-native',
                    runtimeGeneration: scope.ownerGeneration,
                },
            },
            nativeControls: {
                scope,
                model: {
                    available: false,
                    catalogAvailable: true,
                    currentConfirmed: true,
                    current: { model: 'native-effective', reasoningEffort: 'max' },
                    models: [{ id: 'default', label: 'Original default', nativeResolvedModel: 'native-effective', reasoningEfforts: ['max'], canUnsetReasoningEffort: false }],
                },
            },
        },
        agentState: {
            nativeQuery: {
                version: 1,
                app: scope.app,
                nativeConversationId: scope.nativeConversationId,
                hostId: scope.hostId,
                ownerGeneration: scope.ownerGeneration,
                queryToken: scope.queryToken,
                status: 'idle',
                canSend: false,
                canCancel: false,
                activeSendMode: 'unverified',
            },
        },
    } as unknown as Session;
    return { scope, session };
}

describe('Track D Batch 7 — R064 & R069 polish', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.dark = false;
        state.insets = { top: 47, bottom: 34, left: 0, right: 0 };
        state.sessions = {};
        state.machines = {};
        state.rpcReject = false;
        state.refresh.mockResolvedValue(undefined);
    });

    it('R064: NativeWindowPanel honors bottom/landscape scroll cushions, dims disabled fill-input, gives 44pt targets, and uses warningCritical error tint', async () => {
        state.dark = true;
        state.insets = { top: 0, bottom: 34, left: 59, right: 59 };
        state.sessions.win = {
            id: 'win',
            draft: '',
            metadata: {
                bridge: { sourceStatus: 'connected' },
                capabilities: { rpcMethods: ['window-control'] },
            },
            agentState: {
                windowObservation: {
                    captureStamp: { runtimeGeneration: 'r1', windowGeneration: 'w1' },
                    textInputAvailable: true,
                    controls: [
                        { nodeId: 'field-1', role: 'AXTextField', title: 'Prompt', editable: true, emptyEditable: true, enabled: true },
                        { nodeId: 'btn-disabled', role: 'AXButton', title: 'Disabled Action', enabled: false },
                    ],
                },
            },
        };

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(NativeWindowPanel, { sessionId: 'win', topInset: 64 }));
        });

        const scroll = renderer.root.findByType('ScrollView');
        expect(scroll.props.contentContainerStyle).toMatchObject({
            paddingTop: 80,
            paddingBottom: 50,
            paddingLeft: 59,
            paddingRight: 59,
        });

        const fillBtn = renderer.root.findByProps({ testID: 'codelync-fill-input' });
        expect(fillBtn.props.disabled).toBe(true);
        expect(fillBtn.props.accessibilityState).toEqual({ disabled: true, busy: false });
        expect(flattenStyle(fillBtn.props.style)).toMatchObject({ minHeight: 44, opacity: 0.45 });

        const pressables = renderer.root.findAllByType('Pressable');
        const disabledControl = pressables.find((p: any) => p.props.disabled === true && p.props.testID !== 'codelync-fill-input');
        expect(disabledControl).toBeDefined();
        expect(flattenStyle(disabledControl.props.style)).toMatchObject({ minHeight: 44, opacity: 0.45 });

        // Select field, enter draft, trigger error and confirm critical alert color + active fill opacity
        const fieldBtn = pressables.find((p: any) => p.props.accessibilityState?.selected === false);
        act(() => fieldBtn.props.onPress());
        const input = renderer.root.findByProps({ testID: 'codelync-window-draft' });
        act(() => input.props.onChangeText('Hello window'));

        const activeFillBtn = renderer.root.findByProps({ testID: 'codelync-fill-input' });
        expect(activeFillBtn.props.disabled).toBe(false);
        expect(flattenStyle(activeFillBtn.props.style).opacity).toBe(1);

        state.rpcReject = true;
        await act(async () => {
            await activeFillBtn.props.onPress();
        });
        const alertText = renderer.root.findByProps({ accessibilityRole: 'alert' });
        expect(flattenStyle(alertText.props.style).color).toBe('#FF453A');

        act(() => renderer.unmount());
    });

    it('R064: NativeReadonlyModelCatalog elevates dark-mode backdrop opacity, adds sheet hairline border, readonly divider, and vertical overlay padding', () => {
        const { scope, session } = modelCatalogFixture();
        state.dark = true;

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(NativeReadonlyModelCatalog, { session, captured: scope, active: true, onClose: vi.fn() }));
        });

        const views = renderer.root.findAllByType('View');
        expect(flattenStyle(views[0].props.style)).toMatchObject({ paddingHorizontal: 20, paddingVertical: 24 });

        const sheet = renderer.root.findByProps({ testID: 'codelync-native-model-catalog' });
        expect(flattenStyle(sheet.props.style)).toMatchObject({
            borderWidth: 0.5,
            borderColor: '#2A2A2A',
        });

        const backdrop = renderer.root.findAllByType('Pressable')[0];
        expect(flattenStyle(backdrop.props.style)).toMatchObject({
            backgroundColor: '#000000',
            opacity: 0.56,
        });

        const readonlyText = renderer.root.findByProps({ children: 'agentInput.codexPermissionMode.readOnly' });
        expect(flattenStyle(readonlyText.props.style)).toMatchObject({
            borderTopWidth: 0.5,
            borderColor: '#2A2A2A',
        });

        const title = renderer.root.findByProps({ children: 'agentInput.model.title' });
        expect(title.props.numberOfLines).toBe(1);
        expect(flattenStyle(title.props.style).minWidth).toBe(0);

        act(() => renderer.unmount());
    });

    it('R069: CodelyncHandoff provides >=44pt trigger and cancel hit targets, dark-mode sheet contrast, overlay padding, and single-line ellipsized heading', () => {
        state.dark = true;
        const source: Session = {
            id: 'source',
            updatedAt: 10,
            draft: '',
            metadata: {
                machineId: 'mac-a',
                client: { id: 'noninvasive-bridge' },
                nativeSession: { title: 'Codex', catalogueAvailable: true },
                bridge: {
                    controlMode: 'session',
                    sourceStatus: 'connected',
                    source: { app: 'codex', id: 'orig-codex', kind: 'session', hostId: 'local', runtimeGeneration: 'owner-1' },
                },
            },
        } as Session;
        state.sessions = { source };
        state.machines = { 'mac-a': { id: 'mac-a', active: true } };
        const message: AgentTextMessage = {
            kind: 'agent-text',
            id: 'msg-1',
            localId: null,
            createdAt: 1,
            text: 'Reply text',
            meta: { nativeRow: { id: 'row-1', offset: 0, revision: 0 } },
        };

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncHandoff, { sessionId: 'source', metadata: source.metadata, message }));
        });

        const trigger = renderer.root.findByProps({ testID: 'codelync-handoff' });
        expect(flattenStyle(trigger.props.style)).toMatchObject({
            minHeight: 44,
            minWidth: 44,
            justifyContent: 'center',
        });

        act(() => trigger.props.onPress());

        const modal = renderer.root.findByType('Modal');
        const overlay = modal.findAllByType('View')[0];
        expect(flattenStyle(overlay.props.style)).toMatchObject({
            paddingHorizontal: 24,
            paddingVertical: 24,
        });

        const modalPressables = modal.findAllByType('Pressable');
        expect(flattenStyle(modalPressables[0].props.style)).toMatchObject({
            backgroundColor: '#000000',
            opacity: 0.56,
        });

        const sheet = modal.findAllByType('View')[1];
        expect(flattenStyle(sheet.props.style)).toMatchObject({
            borderWidth: 0.5,
            borderColor: '#2A2A2A',
        });

        const heading = modal.findAllByType('Text').find((n: any) => n.props.children === 'codelyncHandoff.action');
        expect(heading.props.numberOfLines).toBe(1);
        expect(flattenStyle(heading.props.style).minWidth).toBe(0);

        const cancelBtn = modalPressables[1];
        expect(flattenStyle(cancelBtn.props.style)).toMatchObject({
            minHeight: 44,
            minWidth: 44,
            flexShrink: 0,
            justifyContent: 'center',
        });

        act(() => renderer.unmount());
    });

    it('R069: NativeParentControl exposes busy/disabled dimming on retry and highlights failed parent refresh with warningCritical', async () => {
        state.dark = true;
        let rejectRefresh!: (err: Error) => void;
        state.refresh.mockImplementationOnce(() => new Promise<void>((_res, rej) => { rejectRefresh = rej; }));
        state.sessions.child = {
            id: 'child',
            metadata: {
                client: { id: 'noninvasive-bridge' },
                nativeSession: { isSubagent: true, parentId: 'native-parent' },
                bridge: {
                    controlMode: 'session',
                    sourceStatus: 'connected',
                    source: { app: 'codex', id: 'native-child', hostId: 'local', kind: 'session', runtimeGeneration: 'owner' },
                },
            },
            agentState: {
                nativeInput: {
                    available: false,
                    reason: 'parent-owned-subagent',
                    parentConversationId: 'native-parent',
                    agentPath: '/root/qa',
                    app: 'codex',
                    nativeConversationId: 'native-child',
                    hostId: 'local',
                    ownerGeneration: 'owner',
                },
            },
        };

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(NativeParentControl, { sessionId: 'child', topInset: 64 }));
        });

        const retryBtn = renderer.root.findByProps({ testID: 'codelync-parent-read-retry' });
        act(() => {
            retryBtn.props.onPress();
        });

        const busyRetry = renderer.root.findByProps({ testID: 'codelync-parent-read-retry' });
        expect(busyRetry.props.accessibilityState).toEqual({ disabled: true, busy: true });
        expect(flattenStyle(busyRetry.props.style).opacity).toBe(0.45);

        await act(async () => {
            rejectRefresh(new Error('network-fail'));
        });

        const failedText = renderer.root.findByProps({ accessibilityLiveRegion: 'polite' });
        expect(flattenStyle(failedText.props.style).color).toBe('#FF453A');

        act(() => renderer.unmount());
    });
});
