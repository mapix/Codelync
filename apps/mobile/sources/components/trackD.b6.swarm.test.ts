import * as React from 'react';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error react-test-renderer has no local declaration file in this workspace
import { act, create } from 'react-test-renderer';
import ts from 'typescript';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { codelyncSubagentKindLabels } from '@/text/codelyncSubagentLabels';
import type { SupportedLanguage } from '@/text/_all';

let originalLoad: ((request: string, parent: unknown, isMain: boolean) => unknown) | undefined;

beforeAll(() => {
    const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
    originalLoad = mod._load;
    mod._load = function (request: string, parent: unknown, isMain: boolean) {
        if (request.startsWith('@/assets/images/')) return 2;
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
    language: 'en' as SupportedLanguage,
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
    tablet: false,
    landscape: false,
    sessions: {} as Record<string, any>,
    gitSubtitle: null as string | null,
    pairingBusy: false,
    pairingError: null as string | null,
}));

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const themeFixture = () => ({
    dark: state.dark,
    colors: {
        text: state.dark ? '#ffffff' : '#000000',
        textSecondary: '#8E8E93',
        textLink: '#2BACCC',
        warningCritical: state.dark ? '#FF453A' : '#FF3B30',
        surface: state.dark ? '#161616' : '#ffffff',
        surfaceHigh: state.dark ? '#1E1E1E' : '#F8F8F8',
        surfacePressedOverlay: state.dark ? '#242424' : '#D1D1D6',
        divider: state.dark ? '#2A2A2A' : '#eaeaea',
        shadow: { color: '#000000', opacity: 0.1 },
        groupped: { background: state.dark ? '#000000' : '#F2F2F7' },
        header: {
            background: state.dark ? '#000000' : '#ffffff',
            tint: state.dark ? '#ffffff' : '#18171C',
        },
        glass: {
            backgroundStrong: state.dark ? 'rgba(28, 28, 28, 0.68)' : 'rgba(255, 255, 255, 0.84)',
        },
        button: {
            primary: { background: '#000000', tint: '#FFFFFF' },
        },
    },
});

vi.mock('react-native', () => ({
    Animated: {
        Value: class { constructor(public v: number) {} },
        timing: () => ({ start: () => {} }),
        View: 'AnimatedView',
    },
    Image: 'Image',
    Platform: {
        get OS() { return state.platform; },
        select: (values: Record<string, any>) => values[state.platform] ?? values.default,
    },
    Pressable: ({ children, ...rest }: any) => React.createElement(
        'Pressable',
        rest,
        typeof children === 'function' ? children({ pressed: false }) : children
    ),
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => state.insets,
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 0.5,
        create: (arg: any) =>
            typeof arg === 'function'
                ? new Proxy({}, { get: (_t, prop) => arg(themeFixture())[prop as string] })
                : arg,
    },
    useUnistyles: () => ({ theme: themeFixture() }),
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/utils/responsive', () => ({
    useHeaderHeight: () => 44,
    useIsTablet: () => state.tablet,
    useIsLandscape: () => state.landscape,
}));
vi.mock('@/components/layout', () => ({ layout: { headerMaxWidth: 800, maxWidth: 800 } }));
vi.mock('@/text', () => ({
    getCurrentLanguage: () => state.language,
    t: (key: string) => key,
}));
vi.mock('./MobileGlass', () => ({
    MobileGlassSurface: (p: any) => React.createElement('MobileGlassSurface', p, p.children),
}));
vi.mock('./BubblePressable', () => ({
    BubblePressable: (p: any) => React.createElement('BubblePressable', p, p.children),
}));
vi.mock('./GitLineChanges', () => ({ GitLineChanges: () => null }));
vi.mock('./navigation/MobileHeaderScrim', () => ({
    MobileHeaderScrim: 'MobileHeaderScrim',
    MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY: 0.1,
    MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY: 0.3,
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), prompt: vi.fn() } }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/config', () => ({ config: { noninvasiveLocal: true } }));
vi.mock('../RoundButton', () => ({ RoundButton: 'RoundButton' }));
vi.mock('./onboarding/OnboardingContent', () => ({
    WelcomeContent: () => null,
    LinkComputerContent: () => null,
}));
vi.mock('./onboarding/OnboardingHeader', () => ({
    OnboardingHeader: () => React.createElement('OnboardingHeader'),
}));
vi.mock('@/assets/images/codelync-mark.png', () => ({ default: 1 }));
vi.mock('@/assets/images/codelync-connection.png', () => ({ default: 2 }));
vi.mock('./onboarding/HappyEngineeringWordmark', () => ({
    HappyEngineeringWordmark: 'HappyEngineeringWordmark',
}));
vi.mock('@/auth/CodelyncPairingProvider', () => ({
    useCodelyncPairing: () => ({
        busy: state.pairingBusy,
        error: state.pairingError,
        scan: vi.fn(),
        connect: vi.fn(),
    }),
}));

import { ChatHeaderView } from './ChatHeaderView';
import { OnboardingScreen } from './onboarding/OnboardingScreen';
import { CodelyncScanScreen } from './onboarding/CodelyncScanScreen';

function flattenStyle(style: any): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    if (typeof style === 'object') return style;
    return {};
}

function loadSessionView() {
    const noop = () => {};
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    const modules: Record<string, any> = {
        react: React,
        'react-native': {
            ActivityIndicator: host('ActivityIndicator'),
            Platform: { get OS() { return state.platform; }, select: (v: any) => v[state.platform] ?? v.default },
            Pressable: host('Pressable'),
            Text: host('Text'),
            View: host('View'),
        },
        'react-native-reanimated': {
            __esModule: true,
            default: { View: host('AnimatedView') },
            useSharedValue: (v: any) => ({ value: v }),
            useAnimatedStyle: () => ({}),
            withTiming: (v: any) => v,
            Easing: { out: noop, cubic: noop },
        },
        'react-native-safe-area-context': { useSafeAreaInsets: () => state.insets },
        'react-native-unistyles': {
            StyleSheet: { create: () => ({}) },
            useUnistyles: () => ({ theme: themeFixture() }),
        },
        '@expo/vector-icons': { Ionicons: 'Ionicons' },
        'expo-router': { useRouter: () => ({ push: noop, back: noop, replace: noop, setParams: noop }) },
        '@react-navigation/native': { useIsFocused: () => true, useFocusEffect: noop },
        '@/config': { config: { noninvasiveLocal: true } },
        '@/components/ChatHeaderView': { ChatHeaderView: (props: any) => React.createElement('CapturedChatHeader', props) },
        '@/components/MobileGlass': { MobileGlassBackdrop: host('MobileGlassBackdrop') },
        '@/components/SessionContentView': { SessionContentView: host('SessionContentView') },
        '@/components/ChatList': { ChatList: host('ChatList') },
        '@/components/Deferred': { Deferred: (p: any) => p.children },
        '@/components/EmptyMessages': { EmptyMessages: host('EmptyMessages') },
        '@/components/Avatar': { Avatar: host('Avatar') },
        '@/components/PeerChannelControl': { PeerChannelControl: host('PeerChannelControl') },
        '@/components/AgentInput': { AgentInput: React.forwardRef((p: any, _ref: any) => React.createElement('AgentInput', p)) },
        '@/components/WorktreeTabStrip': { WorktreeTabStrip: host('WorktreeTabStrip'), WORKTREE_TAB_STRIP_HEIGHT: 40 },
        '@/components/CodelyncSubagents': { CodelyncSubagents: host('CodelyncSubagents') },
        '@/components/NativeSessionUnavailable': { NativeSessionUnavailable: host('NativeSessionUnavailable') },
        '@/components/VoiceAssistantStatusBar': { VoiceAssistantStatusBar: host('VoiceAssistantStatusBar'), VOICE_PILL_TOTAL_HEIGHT: 0 },
        '@/components/layout': { layout: { maxWidth: 800 } },
        '@/components/navigation/headerMetrics': { MOBILE_GLASS_HEADER_HEIGHT: 52 },
        '@/sync/apiSocket': { apiSocket: { peerConnected: () => true, peerWritable: () => true } },
        '@/sync/storage': {
            storage: { getState: () => ({ sessions: state.sessions, localSettings: { sidebarPanelsOpen: [], sidebarPanelActive: null } }) },
            useSession: (id: string) => state.sessions[id] ?? null,
            useIsDataReady: () => true,
            useSessionAvatar: () => null,
            useSessionGitStatus: () => null,
            useLocalSetting: (key: string) => key === 'acknowledgedCliVersions' ? {} : key === 'sidebarPanelsOpen' ? [] : false,
            useSetting: () => false,
            useRealtimeStatus: () => 'disconnected',
            useSessionMessages: () => ({ messages: [], isLoaded: true, isLoadingOlder: false }),
            useSessionPendingCommunications: () => [],
            useSideChatSessions: () => [],
            useSocketStatus: () => ({ status: 'connected' }),
            useSessionUsage: () => null,
        },
        '@/sync/sync': { sync: { onSessionVisible: noop, retryCodelyncSession: noop, refreshSessions: noop } },
        '@/sync/pendingChats': { usePendingChat: () => null, dismissPendingChat: noop },
        '@/sync/codelyncLoadingProgress': {
            useCodelyncDiscoveryProgress: () => ({ phase: 'complete' }),
            useCodelyncMessageProgress: () => ({ phase: 'complete' }),
        },
        '@/sync/noninvasiveBridge': {
            isNoninvasiveBridge: (m: any) => m?.client?.id === 'noninvasive-bridge',
            canReadFromNoninvasiveSource: () => true,
            canSendToNoninvasiveSource: () => true,
        },
        '@/hooks/useProjectWorktree': { useProjectWorktreeSummary: () => null },
        '@/hooks/useCodelyncSubagents': { useCodelyncSubagents: () => ({ present: false }) },
        '@/hooks/useSessionVisibility': { useSessionVisibility: noop },
        '@/hooks/useHappyAction': { useHappyAction: () => [false, noop] },
        '@/hooks/useSessionQuickActions': { MISSING_SESSION: {}, useSessionQuickActions: () => ({ canResume: false, resumeSession: noop, resumingSession: false }) },
        '@/hooks/useCodelyncModelControls': { useCodelyncModelControls: () => ({ native: false, enabled: false, models: [], currentModel: null, efforts: [], currentEffort: null, showReadOnlyEffort: false, scope: null, catalogReadable: false, message: null, selectModel: noop, selectEffort: noop, refresh: async () => {} }) },
        '@/hooks/useCodelyncConnectionState': { useCodelyncConnectionState: () => ({ snapshot: { writable: true }, state: { kind: 'connected' } }) },
        '@/hooks/useComposerModes': { useComposerModes: () => ({ availableModes: [], availableModels: [], availableEffortLevels: [], permissionMode: { key: 'default', name: 'Default' } }) },
        '@/hooks/useImagePicker': { useImagePicker: () => ({ selectedImages: [], attachImages: noop, removeImage: noop, clearImages: noop, addImages: noop }) },
        '@/hooks/useDraft': { useDraft: () => ({ clearDraft: noop }) },
        '@/components/agentGoalStatus': { resolveVisibleAgentGoalStatus: () => null },
        '@/hooks/useCodelyncSelectedSessionActivity': { useCodelyncSelectedSessionActivity: noop },
        '@/utils/sessionGitPresentation': { resolveSessionGitPresentation: () => ({ subtitle: state.gitSubtitle, changes: null }) },
        '@/utils/nativeSessionAvailability': { nativeSessionAvailability: () => 'available' },
        '@/text/nativeSessionAvailabilityLabels': { nativeSessionAvailabilityLabels: { en: { title: 'Unavailable' } } },
        '@/text/codelyncSubagentLabels': { codelyncSubagentKindLabels },
        '@/utils/codelyncSourceScope': {
            codelyncSourceAppName: (app: string) => app === 'claude-desktop' ? 'Claude Desktop' : app === 'antigravity' ? 'Antigravity' : 'Codex',
            codelyncSourceLabel: (s: any) => s?.app === 'claude-desktop' ? 'Claude Desktop · Code' : 'Codex',
        },
        '@/text': { getCurrentLanguage: () => state.language, t: (key: string) => key },
        '@/utils/platform': { isRunningOnMac: () => false },
        '@/utils/responsive': {
            useHeaderHeight: () => 44,
            useIsLandscape: () => state.landscape,
            useIsTablet: () => state.tablet,
            useLayoutDimensions: () => ({ width: 402 }),
        },
        '@/utils/sessionUtils': {
            getSessionName: (s: any) => s?.metadata?.nativeSession?.title || s?.id || 'Session',
            getSessionAvatarId: (s: any) => s?.id || 'id',
            getResumeCommandBlock: () => null,
            useSessionStatus: () => ({ isConnected: true, state: 'thinking' }),
        },
        '@/-session/sessionOverlayNav': { useOverlayNav: { getState: () => ({ publish: noop, back: null, reset: noop }) } },
        '@/sync/rig': {
            isRigMetadata: () => false,
            isRigMetadataV1: () => false,
            isRigModelSelectionEnabled: () => false,
            isRigPermissionSelectionEnabled: () => false,
            isRigReasoningSelectionEnabled: () => false,
            rigCanAbort: () => false,
            rigCanBrowseFiles: () => false,
            rigCanReadFiles: () => false,
            rigCanUseAttachments: () => false,
            rigCanUseShell: () => false,
        },
    };
    const sourcePath = resolve(__dirname, '../-session/SessionView.tsx');
    const code = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: Record<string, any> = {};
    new Function('require', 'exports', code)((name: string) => modules[name] ?? new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? false : prop === 'default' ? {} : noop) }), exports);
    return exports.SessionView;
}

describe('Track D Batch 6 — R054 & R059 polish', () => {
    beforeEach(() => {
        state.dark = false;
        state.platform = 'ios';
        state.language = 'en';
        state.insets = { top: 47, bottom: 34, left: 0, right: 0 };
        state.tablet = false;
        state.landscape = false;
        state.sessions = {};
        state.gitSubtitle = null;
        state.pairingBusy = false;
        state.pairingError = null;
    });

    it('R054: ChatHeaderView clears side glass controls by 14pt gap, honors landscape insets, compacts multiline title, and avoids pill overflow', () => {
        state.insets = { top: 0, bottom: 21, left: 59, right: 59 };
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(ChatHeaderView, {
                title: 'Storage consistency verification',
                subtitle: 'Claude Desktop · サブエージェント',
                onTitlePress: vi.fn(),
                onBackPress: vi.fn(),
                rightSlot: React.createElement('View'),
            }));
        });

        const views = renderer.root.findAllByType('View');
        const contentWrapper = views.find((v: any) => flattenStyle(v.props.style).paddingLeft === 59);
        expect(contentWrapper).toBeDefined();
        expect(flattenStyle(contentWrapper.props.style).paddingRight).toBe(59);

        // Glass title overlay offsets by titlePillInset (44 + 14 = 58) + horizontal content padding (16) = 74
        // Back button ends at 16 + 44 = 60 -> exact 14pt gap instead of overlapping by 2pt.
        const overlay = views.find((v: any) => v.props.pointerEvents === 'box-none' && flattenStyle(v.props.style).position === 'absolute');
        expect(overlay).toBeDefined();
        const overlayStyle = flattenStyle(overlay.props.style);
        expect(overlayStyle.left).toBe(74);
        expect(overlayStyle.right).toBe(74);

        const pill = renderer.root.findByType('BubblePressable');
        expect(pill.props.accessibilityLabel).toBe('Storage consistency verification, Claude Desktop · サブエージェント');
        expect(flattenStyle(pill.props.style).minWidth).toBe(0);

        const [titleNode, subtitleNode] = renderer.root.findAllByType('Text');
        expect(titleNode.props.numberOfLines).toBe(1);
        expect(titleNode.props.ellipsizeMode).toBe('tail');
        expect(flattenStyle(titleNode.props.style).lineHeight).toBe(18);
        expect(flattenStyle(titleNode.props.style).minWidth).toBe(0);

        expect(subtitleNode.props.numberOfLines).toBe(1);
        expect(subtitleNode.props.ellipsizeMode).toBe('tail');
        expect(flattenStyle(subtitleNode.props.style).minWidth).toBe(0);

        act(() => renderer.unmount());
    });

    it.each(['en', 'zh-Hans', 'ja'] as const)('R054: SessionView keeps %s native subagent name as primary header title and places app + subagent kind in subtitle', (lang) => {
        const SessionView = loadSessionView();
        state.language = lang;
        state.gitSubtitle = 'main';
        state.sessions['sub-1'] = {
            id: 'sub-1',
            presence: 'online',
            metadata: {
                client: { id: 'noninvasive-bridge' },
                bridge: {
                    controlMode: 'session',
                    sourceStatus: 'connected',
                    source: { app: 'claude-desktop', kind: 'session', id: 'native-sub', hostId: 'local' },
                },
                nativeSession: {
                    isSubagent: true,
                    parentId: 'native-parent',
                    agentName: 'Subagent Worker',
                    title: 'Fallback Title',
                },
            },
        };

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(SessionView, { id: 'sub-1' }));
        });
        const header = renderer.root.findByType('CapturedChatHeader');
        expect(header.props.title).toBe('Subagent Worker');
        expect(header.props.subtitle).toBe(`Claude Desktop · ${codelyncSubagentKindLabels[lang]} · main`);
        act(() => renderer.unmount());
    });

    it('R059: OnboardingScreen gives GetHelpButton >=44pt hit target, short-viewport scrollability, and landscape safe-area insets', () => {
        state.insets = { top: 0, bottom: 21, left: 59, right: 59 };
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(OnboardingScreen, {
                header: React.createElement('OnboardingHeader'),
                content: React.createElement('View'),
                reserveContent: false,
                primary: React.createElement('RoundButton', { title: 'Scan QR Code' }),
                secondary: { title: 'Paste Pair Link', onPress: vi.fn() },
            }));
        });

        const scroll = renderer.root.findByType('ScrollView');
        const scrollStyle = flattenStyle(scroll.props.style);
        const scrollContent = flattenStyle(scroll.props.contentContainerStyle);
        expect(scrollStyle.flex).toBe(1);
        expect(scrollStyle.minHeight).toBe(0);
        expect(scrollContent.flexGrow).toBe(1);
        expect(scrollContent.paddingVertical).toBe(16);
        expect(scrollContent.paddingLeft).toBe(59);
        expect(scrollContent.paddingRight).toBe(59);

        const helpBtn = renderer.root.findByProps({ accessibilityLabel: 'onboarding.getHelp' });
        const helpStyle = flattenStyle(helpBtn.props.style({ pressed: false }));
        expect(helpBtn.props.accessibilityState).toEqual({ disabled: false });
        expect(helpStyle.minHeight).toBe(44);
        expect(helpStyle.minWidth).toBe(44);
        expect(helpStyle.justifyContent).toBe('center');

        const footerStyle = flattenStyle(helpBtn.parent.parent.props.style);
        expect(footerStyle.paddingBottom).toBe(33);
        expect(footerStyle.paddingLeft).toBe(59);
        expect(footerStyle.paddingRight).toBe(59);

        act(() => renderer.unmount());
    });

    it('R059: CodelyncScanScreen keeps narrow/short-viewport content width bounded and header/image accessibility clean', () => {
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncScanScreen));
        });
        const image = renderer.root.findAllByType('Image')[0];
        expect(image.props.accessible).toBe(false);
        expect(flattenStyle(image.props.style)).toMatchObject({
            width: 260,
            height: 98,
            maxWidth: '100%',
            borderRadius: 16,
            overflow: 'hidden',
        });
        const headerText = renderer.root.findAll((n: any) => n.type === 'Text' && n.props?.accessibilityRole === 'header')[0];
        expect(headerText.props.children).toBe('onboarding.linkTitle');
        expect(flattenStyle(headerText.parent.props.style)).toMatchObject({
            width: '100%',
            minWidth: 0,
        });
        act(() => renderer.unmount());
    });
});
