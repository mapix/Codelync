import * as React from 'react';
// @ts-expect-error The native renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, expect, it, vi } from 'vitest';
import * as nativeBridge from '@/sync/noninvasiveBridge';
import * as reading from '@/utils/nativeReadingWindow';
import { nativeWriteConnectionBlocked } from '@/utils/nativeWriteConnection';
import { nativeComposerInputReadOnly } from '@/utils/nativeComposerInputReadOnly';
import { codelyncSavedHistory } from '@/utils/nativeSavedHistory';
import { nativeSessionAvailability } from '@/utils/nativeSessionAvailability';
import { nativeSessionAvailabilityLabels } from '@/text/nativeSessionAvailabilityLabels';

const state = { connected: true, draft: 'Retained draft', send: vi.fn(), abort: vi.fn(), modes: vi.fn(), goal: vi.fn(),
    clear: vi.fn(), nativeCommand: vi.fn(), visible: vi.fn(), refresh: vi.fn(async () => {}), retryRead: vi.fn(async () => {}), replace: vi.fn(),
    landscape: false, tablet: false, loaded: true, older: false, phase: 'complete', readPhase: 'complete', selectedActivity:vi.fn(), sessions: {} as Record<string, any> };
const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
const noop = () => {};
const models = { native: true, enabled: true, models: [{ key: 'a', name: 'A' }], currentModel: { key: 'a', name: 'A' },
    efforts: [{ key: 'high', name: 'High' }], currentEffort: { key: 'high', name: 'High' }, showReadOnlyEffort: false,
    scope: null, catalogReadable: true, message: null, selectModel: noop, selectEffort: noop, refresh: async () => {} };
const AgentInput = React.forwardRef((props: any, ref) => {
    React.useImperativeHandle(ref, () => ({ getText: () => state.draft, setTextAndSelection: (value: string) => { state.draft = value; } }));
    return React.createElement('AgentInput', props);
});
const modules: Record<string, any> = {
    react: React,
    'react-native': { View: host('View'), Text: host('Text'), Pressable: host('Button'), ActivityIndicator: host('Spinner'),
        Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default } },
    'react-native-unistyles': { StyleSheet: { create: () => ({}) }, useUnistyles: () => ({ theme: { colors: { groupped: { background: 'white' }, text: 'black', textSecondary: 'gray' } } }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 47, bottom: 34 }) },
    'react-native-reanimated': { __esModule: true, default: { View: host('Animated') }, useSharedValue: (value: any) => ({ value }), useAnimatedStyle: () => ({}), withTiming: (value: any) => value, Easing: { out: noop, cubic: noop } },
    'expo-router': { useRouter: () => ({ push: noop, back: noop, replace: state.replace }) },
    '@react-navigation/native': { useIsFocused: () => true, useFocusEffect: noop },
    '@/config': { config: { noninvasiveLocal: true } },
    '@/sync/apiSocket': { apiSocket: { peerConnected: () => state.connected, peerWritable: () => state.connected } },
    '@/sync/storage': { storage: { getState: () => ({ sessions: state.sessions }) }, useSocketStatus: () => ({ status: state.connected ? 'connected' : 'error' }),
        useSession: (id: string) => state.sessions[id] ?? null, useRealtimeStatus: () => 'disconnected', useSessionMessages: () => ({ messages: [{ id: 'kept', kind: 'agent-text', text: 'Retained body' }], isLoaded: state.loaded, isLoadingOlder: state.older }),
        useSessionPendingCommunications: () => [], useLocalSetting: (key: string) => key === 'acknowledgedCliVersions' ? {} : key === 'sidebarPanelsOpen' ? [] : false,
        useIsDataReady: () => true, useSessionAvatar: () => null, useSessionGitStatus: () => null, useSideChatSessions: () => [], useSetting: () => false, useSessionUsage: () => null },
    '@/sync/sync': { sync: { sendMessage: state.send, refreshSessions: state.refresh, retryCodelyncSession: state.retryRead, onSessionVisible: state.visible } },
    '@/sync/pendingChats': { usePendingChat: () => null },
    '@/hooks/useHappyAction': { useHappyAction: () => [false, noop] },
    '@/hooks/useProjectWorktree': { useProjectWorktreeSummary: () => null },
    '@/hooks/useCodelyncSubagents': { useCodelyncSubagents: () => ({ present: false }) },
    '@/hooks/useCodelyncProjectActivity': { useCodelyncSelectedSessionActivity: state.selectedActivity },
    '@/utils/sessionGitPresentation': { resolveSessionGitPresentation: () => ({ subtitle: null, changes: null }) },
    '@/utils/nativeSessionAvailability': { nativeSessionAvailability },
    '@/text/nativeSessionAvailabilityLabels': { nativeSessionAvailabilityLabels },
    '@/sync/ops': { sessionAbort: state.abort, sessionSetAgentModes: state.modes, sessionGoalAction: state.goal, sessionCancelCommunication: noop },
    '@/sync/noninvasiveRpc': { runNoninvasiveRpc: state.nativeCommand },
    '@/sync/noninvasiveBridge': nativeBridge,
    '@/utils/nativeWriteConnection': { nativeWriteConnectionBlocked },
    '@/utils/nativeComposerInputReadOnly': { nativeComposerInputReadOnly },
    '@/utils/nativeReadingWindow': reading,
    '@/utils/nativeSavedHistory': { codelyncSavedHistory },
    '@/utils/nativeParentControl': { nativeParentControl: () => null },
    '@/utils/nativeQuery': { readNativeQuery: () => null },
    '@/utils/nativeModelControls': { readNativeModelControlScope: () => null, nativeModelControlScopesEqual: () => false },
    '@/utils/codelyncNativeCommands': { handleCodelyncSlashSubmission: () => false },
    '@/sync/rig': { isRigMetadata: () => false, isRigMetadataV1: () => false, isRigPermissionSelectionEnabled: () => true, isRigModelSelectionEnabled: () => true, isRigReasoningSelectionEnabled: () => true, rigCanAbort: () => true },
    '@/utils/responsive': { useIsLandscape: () => state.landscape, useIsTablet: () => state.tablet, useHeaderHeight: () => 44, useLayoutDimensions: () => ({ width: 402 }) },
    '@/utils/platform': { isRunningOnMac: () => false },
    '@/utils/sessionUtils': { useSessionStatus: () => ({ isConnected: true, state: 'thinking' }), getResumeCommandBlock: () => null,
        getSessionName: (session: any) => session.metadata?.nativeSession?.title || session.id, getSessionAvatarId: (session: any) => session.id },
    '@/hooks/useSessionQuickActions': { MISSING_SESSION: {}, useSessionQuickActions: () => ({ canResume: false }) },
    '@/hooks/useCodelyncModelControls': { useCodelyncModelControls: () => models },
    '@/hooks/useCodelyncConnectionState': { useCodelyncConnectionState: () => ({ state: { kind: state.connected ? 'connected' : 'failed' } }) },
    '@/hooks/useComposerModes': { useComposerModes: () => ({ availableModes: [], availableModels: [], availableEffortLevels: [], permissionMode: { key: 'default', name: 'Default' } }) },
    '@/hooks/useImagePicker': { useImagePicker: () => ({ selectedImages: [], removeImage: noop }) },
    '@/hooks/useDraft': { useDraft: () => ({ clearDraft: state.clear }) },
    '@/hooks/useSessionVisibility': { useSessionVisibility: state.visible },
    '@/sync/codelyncLoadingProgress': { useCodelyncMessageProgress: () => ({ phase: state.readPhase }), useCodelyncDiscoveryProgress: () => ({ phase: state.phase }) },
    '@/components/MobileGlass': { MobileGlassBackdrop: host('Glass') },
    '@/components/ChatHeaderView': { ChatHeaderView: (props: any) => React.createElement('Header', props, props.rightSlot) },
    '@/components/NativeSessionUnavailable': { NativeSessionUnavailable: host('Unavailable') },
    '@/components/AgentInput': { AgentInput },
    '@/components/SessionContentView': { SessionContentView: (p: any) => React.createElement('Content', p, p.content, p.input, p.placeholder) },
    '@/components/Deferred': { Deferred: (p: any) => p.children },
    '@/components/AnimatedOverlay': { AnimatedFade: (p: any) => p.children },
    '@/components/ChatList': { ChatList: host('ChatList') },
    '@/components/PeerChannelControl': { PeerChannelControl: host('PeerControl') },
    '@/components/CodelyncConnectionNotice': { CodelyncConnectionNotice: host('Notice') },
    '@/components/NativeSourceBanner': { NativeSourceBanner: host('SourceBanner') },
    '@/components/CodelyncSessionLoading': { CodelyncSessionLoading: host('MessageLoading') },
    '@/components/AgentGoalBar': { AgentGoalBar: host('Goal') },
    '@/components/agentGoalStatus': { resolveVisibleAgentGoalStatus: () => ({ text: 'Goal', capabilities: { edit: true } }) },
    '@/components/navigation/headerMetrics': { MOBILE_GLASS_HEADER_HEIGHT: 64 },
    '@/components/VoiceAssistantStatusBar': { VOICE_PILL_TOTAL_HEIGHT: 0 },
    '@/components/layout': { layout: { maxWidth: 800 } },
    '@/text': { t: (key: string) => key, getCurrentLanguage: () => 'en' },
};
// Execute the actual SessionView source with native/runtime dependencies stubbed.
// This exercises its real composer bindings and callbacks without starting an app.
const source = readFileSync(new URL('./SessionView.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports: Record<string, any> = {};
new Function('require', 'exports', code)((name: string) => modules[name] ?? new Proxy({}, { get: (_target, property) => property === '__esModule' ? false : property === 'default' ? {} : noop }), exports);
const SessionViewLoaded = exports.SessionViewLoaded;
const fixture = () => ({ id: 'native', draft: 'Retained draft', metadata: { client: { id: 'noninvasive-bridge' }, capabilities: { readOnly: false, steering: true },
    bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: 'turn', source: { app: 'codex', id: 'native-id', hostId: 'local', kind: 'session', runtimeGeneration: 'owner' } } }, agentState: {} });
beforeEach(() => { vi.clearAllMocks(); state.connected = true; state.landscape = false; state.tablet = false; state.loaded = true; state.older = false; state.phase = 'complete'; state.readPhase = 'complete'; state.draft = 'Retained draft'; state.send.mockResolvedValue(false); });
it('HTTP-good cached content survives WS failure while real native composer bindings disable writes and stale callbacks dispatch nothing', async () => {
    const session = fixture(); state.sessions = { native: session }; let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(SessionViewLoaded, { sessionId: 'native', session })); });
    const online = screen.root.findByType('AgentInput').props;
    expect(online.blockSend).toBe(false); expect(online.onAbort).toBeTypeOf('function');
    const body = screen.root.findByType('ChatList'); state.connected = false;
    act(() => screen.update(React.createElement(SessionViewLoaded, { sessionId: 'native', session })));
    const offline = screen.root.findByType('AgentInput').props;
    expect(offline.blockSend).toBe(true); expect(offline.editable).toBe(true);
    for (const key of ['onAbort', 'onPermissionModeChange', 'onModelModeChange', 'onEffortLevelChange']) expect(offline[key]).toBeUndefined();
    expect(screen.root.findByType('ChatList')).toBe(body); expect(state.draft).toBe('Retained draft'); expect(state.clear).not.toHaveBeenCalled();
    expect(screen.root.findAllByType('Notice')).toHaveLength(0); expect(screen.root.findAllByType('MessageLoading')).toHaveLength(0);
    await act(async () => { online.onSend(); online.onAbort(); online.onPermissionModeChange({ key: 'other' }); });
    expect(state.send).not.toHaveBeenCalled(); expect(state.abort).not.toHaveBeenCalled(); expect(state.modes).not.toHaveBeenCalled();
    state.connected = true; act(() => screen.update(React.createElement(SessionViewLoaded, { sessionId: 'native', session })));
    expect(screen.root.findByType('AgentInput').props.blockSend).toBe(false); expect(state.send).not.toHaveBeenCalled(); expect(state.draft).toBe('Retained draft'); act(() => screen.unmount());
});
it('retained messages keep the same body and header inset through deterministic socket flapping', () => {
    const session = fixture(); session.metadata.bridge.sourceStatus = 'owner-unavailable'; state.sessions = { native: session };
    const Component = exports.SessionView.type;
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(Component, { id: 'native' })); });
    const body = screen.root.findByType('ChatList'), initialProps = body.props;
    expect(initialProps.topContentInset).toBe(123);
    const peer = screen.root.findByType('PeerControl');
    for (const connected of [false, true, false, true]) {
        state.connected = connected; act(() => screen.update(React.createElement(Component, { id: 'native' })));
        expect(screen.root.findByType('ChatList')).toBe(body);
        expect(screen.root.findByType('ChatList').props.topContentInset).toEqual(initialProps.topContentInset);
        expect(screen.root.findByType('PeerControl')).toBe(peer);
        expect(screen.root.findAllByType('Notice')).toHaveLength(0);
        expect(screen.root.findAllByType('SourceBanner')).toHaveLength(0);
        expect(screen.root.findAllByType('MessageLoading')).toHaveLength(0);
        expect(state.draft).toBe('Retained draft');
    }
    act(() => screen.unmount());
});

it('actual SessionView gives an unavailable foreground route its header inset and a read-only Retry', async () => {
    state.sessions = {}; let screen!: ReturnType<typeof create>;
    const Component = exports.SessionView.type;
    act(() => { screen = create(React.createElement(Component, { id: 'uncached-child' })); });
    const surface = screen.root.findByType('Unavailable');
    expect(surface.props.topInset).toBe(111); expect(surface.props.loading).toBe(false);
    expect(state.visible).toHaveBeenCalledWith('uncached-child', true, false, 'disconnected');
    await act(async () => { await surface.props.onRetry(); });
    expect(state.retryRead).toHaveBeenCalledExactlyOnceWith('uncached-child'); expect(state.refresh).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled(); expect(state.nativeCommand).not.toHaveBeenCalled();
    state.phase = 'loading'; act(() => screen.update(React.createElement(Component, { id: 'uncached-child' })));
    expect(screen.root.findByType('Unavailable').props).toMatchObject({ topInset: 111, loading: true });
    state.readPhase = 'error'; act(() => screen.update(React.createElement(Component, { id: 'uncached-child' })));
    expect(screen.root.findByType('Unavailable').props).toMatchObject({ topInset: 111, loading: false });
    state.tablet = true; act(() => screen.update(React.createElement(Component, { id: 'uncached-child' })));
    expect(screen.root.findByType('Unavailable').props.topInset).toBe(0);
    act(() => screen.unmount());
});
