import * as React from 'react';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_LANGUAGE_CODES, type SupportedLanguage } from '@/text/_all';
import { codelyncChannelLabels } from '@/text/codelyncChannelLabels';
import { lightTheme, darkTheme } from '@/theme';

const state = vi.hoisted(() => ({
    language: 'en' as SupportedLanguage,
    platform: 'ios' as 'ios' | 'android' | 'web',
    dark: false,
    landscape: false,
    tablet: false,
    routerBack: vi.fn(),
    routerPush: vi.fn(),
    routerNavigate: vi.fn(),
    scan: vi.fn(),
    select: vi.fn(async () => {}),
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
        Animated: {
            Value: class { constructor(public value: number) {} },
            timing: () => ({ start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }) }),
            View: host('AnimatedView'),
        },
        Pressable: host('Pressable'),
        ScrollView: host('ScrollView'),
        Switch: host('Switch'),
        Text: host('Text'),
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
            absoluteFillObject: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
        },
    };
});

vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}), logo: () => ({}) },
}));

vi.mock('@/text', () => ({
    getCurrentLanguage: () => state.language,
    t: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/utils/responsive', () => ({
    useHeaderHeight: () => 52,
    useIsTablet: () => state.tablet,
    useIsLandscape: () => state.landscape,
    useLayoutDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800, headerMaxWidth: 800 } }));
vi.mock('./MobileGlass', async () => {
    const ReactModule = await import('react');
    return {
        MobileGlassSurface: (props: any) => ReactModule.createElement('MobileGlassSurface', props, props.children),
        MobileGlassBackdrop: () => null,
    };
});
vi.mock('./navigation/MobileHeaderScrim', () => ({
    MobileHeaderScrim: () => null,
    MOBILE_HOME_SCRIM_OVERLAY_OPACITY: 1,
    MOBILE_STRONG_HEADER_SCRIM_RESTING_OPACITY: 0,
    MOBILE_STRONG_HEADER_SCRIM_UNDERLAP_OPACITY: 1,
}));
vi.mock('./BubblePressable', async () => {
    const ReactModule = await import('react');
    return { BubblePressable: (props: any) => ReactModule.createElement('BubblePressable', props, props.children) };
});
vi.mock('./GitLineChanges', () => ({ GitLineChanges: () => null }));
vi.mock('./StyledText', async () => {
    const ReactModule = await import('react');
    return { Text: (props: any) => ReactModule.createElement('Text', props, props.children) };
});
vi.mock('./ShortcutHints', () => ({ ShortcutHintBadge: () => null, useShortcutHints: () => ({ visible: false }) }));
vi.mock('./CodelyncMark', () => ({ CodelyncMark: () => null }));
vi.mock('./HomeHeaderTitle', () => ({ HomeHeaderTitle: () => null }));
vi.mock('./onboarding/OnboardingHeader', () => ({ OnboardingHeader: () => null }));
vi.mock('./PickerSheet', async () => {
    const ReactModule = await import('react');
    return {
        PickerSheet: ({ children, ...props }: any) => ReactModule.createElement('PickerSheet', props, children),
        PickerSheetOption: (props: any) => ReactModule.createElement('Option', props),
    };
});
vi.mock('./Item', async () => {
    const ReactModule = await import('react');
    return { Item: (props: any) => ReactModule.createElement('Item', props, props.rightElement) };
});
vi.mock('./ItemGroup', async () => {
    const ReactModule = await import('react');
    return { ItemGroup: (props: any) => ReactModule.createElement('ItemGroup', props, props.children) };
});
vi.mock('./CodelyncBottomNavigation', () => ({ CodelyncBottomNavigationView: () => null }));
vi.mock('expo-router', () => ({
    useRouter: () => ({ navigate: state.routerNavigate, push: state.routerPush, back: state.routerBack }),
    useSegments: () => [],
}));
vi.mock('@/sync/serverConfig', () => ({
    getServerInfo: () => ({ isCustom: false, hostname: '', port: undefined }),
}));

import { ChatHeaderView } from './ChatHeaderView';
import { createHeader } from './navigation/Header';
import { HomeHeader } from './HomeHeader';
import { PeerChannelControlView, type PeerChannelSnapshot } from './PeerChannelControlView';
import { CodelyncSettingsView } from './CodelyncSettingsView';

const baseSnapshot: PeerChannelSnapshot = {
    peerId: 'mac-peer',
    selectedId: 'local-1',
    activeId: 'cloud-1',
    desiredKind: 'local',
    automatic: false,
    connecting: false,
    failureCode: 'connection-failed',
    channels: [
        { id: 'local-1', kind: 'local', url: 'http://192.0.2.5:4567', state: 'failed', latencyMs: 12 },
        { id: 'cloud-1', kind: 'cloudflare', url: 'https://tunnel.example', state: 'connected', latencyMs: 55 },
    ],
};

function renderSessionViewLoaded() {
    const noop = () => {};
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    const getTheme = () => (state.dark ? darkTheme : lightTheme);
    const modules: Record<string, any> = {
        react: React,
        'react-native': {
            View: host('View'),
            Text: host('Text'),
            Pressable: host('Pressable'),
            ActivityIndicator: host('ActivityIndicator'),
            Platform: { get OS() { return state.platform; }, select: (v: any) => v[state.platform] ?? v.default },
        },
        'react-native-unistyles': {
            StyleSheet: { create: () => ({}) },
            useUnistyles: () => ({ theme: getTheme() }),
        },
        'react-native-safe-area-context': {
            useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
        },
        'react-native-reanimated': {
            __esModule: true,
            default: { View: host('Animated') },
            useSharedValue: (value: any) => ({ value }),
            useAnimatedStyle: () => ({}),
            withTiming: (value: any) => value,
            Easing: { out: noop, cubic: noop },
        },
        'expo-router': { useRouter: () => ({ push: state.routerPush, back: state.routerBack, replace: noop }) },
        '@react-navigation/native': { useIsFocused: () => true, useFocusEffect: noop },
        '@expo/vector-icons': { Ionicons: host('Ionicons') },
        '@/config': { config: { noninvasiveLocal: false } },
        '@/sync/apiSocket': { apiSocket: { peerConnected: () => true, peerWritable: () => true } },
        '@/sync/storage': {
            storage: { getState: () => ({ sessions: {} }) },
            useSocketStatus: () => ({ status: 'connected' }),
            useSession: () => null,
            useRealtimeStatus: () => 'disconnected',
            useSessionMessages: () => ({ messages: [], isLoaded: true, isLoadingOlder: false }),
            useSessionPendingCommunications: () => [],
            useLocalSetting: (key: string) => key === 'acknowledgedCliVersions' ? {} : key === 'sidebarPanelsOpen' ? [] : false,
            useIsDataReady: () => true,
            useSessionAvatar: () => null,
            useSessionGitStatus: () => null,
            useSideChatSessions: () => [],
            useSetting: () => false,
            useSessionUsage: () => null,
        },
        '@/sync/sync': { sync: { sendMessage: noop, refreshSessions: noop, retryCodelyncSession: noop, onSessionVisible: noop } },
        '@/sync/pendingChats': { usePendingChat: () => null },
        '@/hooks/useHappyAction': { useHappyAction: () => [false, noop] },
        '@/hooks/useProjectWorktree': { useProjectWorktreeSummary: () => null },
        '@/hooks/useCodelyncSubagents': { useCodelyncSubagents: () => ({ present: false }) },
        '@/hooks/useCodelyncProjectActivity': { useCodelyncSelectedSessionActivity: noop },
        '@/hooks/useSessionQuickActions': { MISSING_SESSION: {}, useSessionQuickActions: () => ({ canResume: false }) },
        '@/hooks/useCodelyncModelControls': { useCodelyncModelControls: () => ({ native: false, enabled: false, models: [], efforts: [] }) },
        '@/hooks/useCodelyncConnectionState': { useCodelyncConnectionState: () => ({ snapshot: { writable: true }, state: { kind: 'connected' } }) },
        '@/hooks/useComposerModes': { useComposerModes: () => ({ availableModes: [], availableModels: [], availableEffortLevels: [] }) },
        '@/hooks/useImagePicker': { useImagePicker: () => ({ selectedImages: [], removeImage: noop }) },
        '@/hooks/useDraft': { useDraft: () => ({ clearDraft: noop }) },
        '@/hooks/useSessionVisibility': { useSessionVisibility: noop },
        '@/sync/codelyncLoadingProgress': { useCodelyncMessageProgress: () => ({ phase: 'complete' }) },
        '@/utils/versionUtils': { isVersionSupported: () => false, MINIMUM_CLI_VERSION: '99.0.0' },
        '@/utils/responsive': { useIsLandscape: () => state.landscape, useIsTablet: () => state.tablet, useHeaderHeight: () => 44, useLayoutDimensions: () => ({ width: 390 }) },
        '@/utils/platform': { isRunningOnMac: () => false },
        '@/utils/sessionUtils': { useSessionStatus: () => ({ isConnected: true, state: 'idle' }), getResumeCommandBlock: () => null, getSessionName: () => 'Test Session', getSessionAvatarId: () => 'id' },
        '@/components/MobileGlass': { MobileGlassBackdrop: host('Glass') },
        '@/components/ChatHeaderView': { ChatHeaderView: (p: any) => React.createElement('ChatHeader', p, p.rightSlot) },
        '@/components/SessionContentView': { SessionContentView: (p: any) => React.createElement('Content', p, p.content, p.input, p.placeholder) },
        '@/components/AgentInput': { AgentInput: React.forwardRef((p: any, ref) => { React.useImperativeHandle(ref, () => ({ getText: () => '', setTextAndSelection: noop })); return React.createElement('AgentInput', p); }) },
        '@/components/Deferred': { Deferred: (p: any) => p.children },
        '@/components/AnimatedOverlay': { AnimatedFade: (p: any) => p.children },
        '@/components/navigation/headerMetrics': { MOBILE_GLASS_HEADER_HEIGHT: 64 },
        '@/components/VoiceAssistantStatusBar': { VOICE_PILL_TOTAL_HEIGHT: 0 },
        '@/components/layout': { layout: { maxWidth: 800 } },
        '@/text': { t: (key: string) => key, getCurrentLanguage: () => state.language },
    };
    const source = readFileSync(new URL('../-session/SessionView.tsx', import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports: Record<string, any> = {};
    new Function('require', 'exports', code)((name: string) => modules[name] ?? new Proxy({}, { get: (_t, prop) => prop === '__esModule' ? false : prop === 'default' ? {} : noop }), exports);

    const session = {
        id: 'session-1',
        metadata: { version: '0.1.0', machineId: 'machine-1' },
        agentState: {},
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
        renderer = create(React.createElement(exports.SessionViewLoaded, { sessionId: 'session-1', session }));
    });
    return renderer;
}

beforeEach(() => {
    vi.clearAllMocks();
    state.language = 'en';
    state.platform = 'ios';
    state.dark = false;
    state.landscape = false;
    state.tablet = false;
});

describe('Track D Batch 1 — R004 Header contrast, insets & accessibility', () => {
    it('landscape phone back button uses light tint in dark mode, contrast border, and accessible back label', () => {
        state.dark = true;
        state.landscape = true;
        state.platform = 'ios';
        const renderer = renderSessionViewLoaded();

        const backButton = renderer.root.findByProps({ testID: 'codelync-landscape-back' });
        expect(backButton.props.accessibilityRole).toBe('button');
        expect(backButton.props.accessibilityLabel).toBe('common.back');
        expect(backButton.props.style.borderWidth).toBe(1);
        expect(backButton.props.style.borderColor).toBe('rgba(255, 255, 255, 0.18)');

        const icon = backButton.findByType('Ionicons');
        expect(icon.props.color).toBe(darkTheme.colors.header.tint);
        expect(icon.props.color).not.toBe('#000');

        act(() => backButton.props.onPress());
        expect(state.routerBack).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });

    it('portrait outdated CLI warning pill anchors below floating glass header and adapts dark contrast', () => {
        state.dark = true;
        state.landscape = false;
        state.platform = 'ios';
        const renderer = renderSessionViewLoaded();

        const warning = renderer.root.findByProps({ testID: 'codelync-cli-warning' });
        expect(warning.props.accessibilityRole).toBe('button');
        expect(warning.props.accessibilityLabel).toBe('sessionInfo.cliVersionOutdated');
        // safeArea.top (47) + MOBILE_GLASS_HEADER_HEIGHT (64) + 12 = 123 (must not sit at top: 8 behind notch/header)
        expect(warning.props.style.top).toBe(123);
        expect(warning.props.style.backgroundColor).toBe('#2E2308');

        act(() => renderer.unmount());
    });

    it('ChatHeaderView, DefaultBackButton, and HomeHeader expose accessibilityRole and labels + dark fallback tint', () => {
        state.dark = true;
        state.platform = 'ios';
        let chatRenderer!: ReturnType<typeof create>;
        act(() => {
            chatRenderer = create(React.createElement(ChatHeaderView, {
                title: 'Session Title',
                onBackPress: state.routerBack,
                onTitlePress: () => {},
            }));
        });
        const backPressables = chatRenderer.root.findAll((n: any) => n.type === 'Pressable' && n.props.accessibilityLabel === 'common.back');
        expect(backPressables).toHaveLength(1);
        expect(backPressables[0].props.accessibilityRole).toBe('button');
        const titleBubble = chatRenderer.root.findByType('BubblePressable');
        expect(titleBubble.props.accessibilityRole).toBe('button');
        act(() => chatRenderer.unmount());

        // createHeader without explicit headerTintColor in dark mode must resolve theme.colors.header.tint
        let navRenderer!: ReturnType<typeof create>;
        act(() => {
            navRenderer = create(createHeader({
                navigation: { goBack: state.routerBack } as any,
                route: { name: 'settings/index', key: 'k' } as any,
                back: { title: 'Home', href: '/' },
                options: { headerTitle: 'Settings' },
            }) as React.ReactElement);
        });
        const navBack = navRenderer.root.findAll((n: any) => n.type === 'Pressable' && n.props.accessibilityLabel === 'common.back')[0];
        expect(navBack.props.accessibilityRole).toBe('button');
        const navIcon = navBack.findByType('Ionicons');
        expect(navIcon.props.color).toBe(darkTheme.colors.header.tint);
        act(() => navRenderer.unmount());

        // HomeHeader right new-session button rendered through real Header
        let homeRenderer!: ReturnType<typeof create>;
        act(() => {
            homeRenderer = create(React.createElement(HomeHeader));
        });
        const rightButton = homeRenderer.root.findAll(
            (n: any) => n.type === 'Pressable' && n.props.accessibilityLabel === 'newSession.title',
        )[0];
        expect(rightButton).toBeDefined();
        expect(rightButton.props.accessibilityRole).toBe('button');
        act(() => {
            homeRenderer.unmount();
        });
    });
});

describe('Track D Batch 1 — R009 PeerChannel EN/ZH-Hans/ZH-Hant/JA parity, error contrast & Settings scan', () => {
    it('codelyncChannelLabels defines distinct non-empty copy across all supported languages including zh-Hans, zh-Hant, and ja', () => {
        for (const lang of SUPPORTED_LANGUAGE_CODES) {
            const copy = codelyncChannelLabels[lang];
            expect(copy.desired.trim().length).toBeGreaterThan(0);
            expect(copy.current.trim().length).toBeGreaterThan(0);
            expect(copy.failed.trim().length).toBeGreaterThan(0);
            expect(copy.unsaved.trim().length).toBeGreaterThan(0);
            expect(copy.locate.trim().length).toBeGreaterThan(0);
            if (lang !== 'en') {
                expect(copy.failed).not.toBe(codelyncChannelLabels.en.failed);
                expect(copy.desired).not.toBe(codelyncChannelLabels.en.desired);
            }
        }
        expect(codelyncChannelLabels['zh-Hant'].current).not.toBe(codelyncChannelLabels['zh-Hans'].current);
        expect(codelyncChannelLabels.ja.failed).not.toBe(codelyncChannelLabels.en.failed);
        expect(codelyncChannelLabels.ja.failed).not.toBe(codelyncChannelLabels['zh-Hans'].failed);
    });

    it('renders ja and zh-Hant connection strings and uses destructive error color instead of muted textSecondary', () => {
        for (const lang of ['ja', 'zh-Hant'] as const) {
            state.language = lang;
            let renderer!: ReturnType<typeof create>;
            act(() => {
                renderer = create(React.createElement(PeerChannelControlView, {
                    snapshot: baseSnapshot,
                    onSelect: state.select,
                    onScan: state.scan,
                    presentation: 'settings',
                }));
            });
            const trigger = renderer.root.findByProps({ testID: 'codelync-channel-open' });
            expect(trigger.props.accessibilityLabel).toContain(codelyncChannelLabels[lang].desired);
            expect(trigger.props.accessibilityLabel).toContain(codelyncChannelLabels[lang].current);

            act(() => trigger.props.onPress());
            const errorText = renderer.root.findByProps({ testID: 'codelync-channel-error' });
            expect(errorText.props.children).toBe(codelyncChannelLabels[lang].failed);
            expect(errorText.props.style.color).toBe(lightTheme.colors.textDestructive);

            const scanOption = renderer.root.findByProps({ testID: 'codelync-channel-location-scan' });
            act(() => scanOption.props.onPress());
            expect(renderer.root.findByType('PickerSheet').props.visible).toBe(false);
            expect(state.scan).toHaveBeenCalledTimes(1);
            state.scan.mockClear();
            act(() => renderer.unmount());
        }
    });

    it('CodelyncSettingsView wires onScan into PeerChannelControlView so settings picker exposes QR scan recovery', () => {
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncSettingsView, {
                snapshot: baseSnapshot,
                themePreference: 'adaptive',
                languageLabel: 'English',
                version: '1.0.0',
                remoteDesktopEnabled: false,
                onRemoteDesktopChange: vi.fn(),
                onSelectConnection: state.select,
                onThemeChange: vi.fn(),
                onLanguage: vi.fn(),
                onScan: state.scan,
                onNavigate: vi.fn(),
            }));
        });

        const trigger = renderer.root.findByProps({ testID: 'codelync-channel-open' });
        act(() => trigger.props.onPress());
        const scanOption = renderer.root.findByProps({ testID: 'codelync-channel-location-scan' });
        act(() => scanOption.props.onPress());
        expect(state.scan).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
    });
});
