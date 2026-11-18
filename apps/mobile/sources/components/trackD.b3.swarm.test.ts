import * as React from 'react';
import Module from 'node:module';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { darkTheme, lightTheme } from '@/theme';
import { SUPPORTED_LANGUAGE_CODES } from '@/text/_all';

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
    language: 'en' as 'en' | 'zh-Hans' | 'zh-Hant' | 'ja',
    platform: 'ios' as 'ios' | 'android' | 'web',
    window: { width: 844, height: 390 },
    insets: { top: 0, bottom: 21, left: 59, right: 59 },
    desktopConnected: true,
    desktopBusy: false,
    desktopReady: true,
    desktopInputAllowed: true,
    desktopError: null as string | null,
    desktopDisplays: [
        { id: 'disp-1', name: 'Built-in Retina Display', width: 2560, height: 1600 },
        { id: 'disp-2', name: 'Studio Display', width: 5120, height: 2880 },
    ],
    keyboardFocus: vi.fn(),
    keyboardBlur: vi.fn(),
    disconnect: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    input: vi.fn(async () => true),
}));

vi.hoisted(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('__DEV__', false);
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { cb(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        Platform: {
            get OS() { return state.platform; },
            select: (values: any) => values[state.platform] ?? values.default,
        },
        NativeModules: {},
        ActivityIndicator: host('ActivityIndicator'),
        Dimensions: { get: () => ({ width: state.window.width, height: state.window.height }) },
        Image: host('Image'),
        Keyboard: {
            dismiss: vi.fn(),
            isVisible: () => false,
            addListener: () => ({ remove: vi.fn() }),
        },
        PanResponder: {
            create: () => ({ panHandlers: {} }),
        },
        Pressable: host('Pressable'),
        ScrollView: host('ScrollView'),
        StyleSheet: {
            hairlineWidth: 0.5,
            absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
            absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
            create: (styles: unknown) => typeof styles === 'function' ? styles(state.dark ? darkTheme : lightTheme, {}) : styles,
        },
        Text: host('Text'),
        TextInput: host('TextInput'),
        TouchableWithoutFeedback: host('TouchableWithoutFeedback'),
        View: host('View'),
        useWindowDimensions: () => state.window,
    };
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => state.insets,
}));

vi.mock('react-native-unistyles', () => {
    const getTheme = () => (state.dark ? darkTheme : lightTheme);
    return {
        useUnistyles: () => ({ theme: getTheme() }),
        StyleSheet: {
            hairlineWidth: 0.5,
            absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
            absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
            create: (factory: unknown) => {
                if (typeof factory !== 'function') return factory;
                return new Proxy({}, {
                    get(_target, prop) {
                        const resolved = (factory as (theme: typeof lightTheme, runtime: unknown) => Record<string, unknown>)(getTheme(), {});
                        return resolved[prop as string];
                    },
                });
            },
        },
    };
});

vi.mock('expo-blur', () => ({ BlurView: (props: any) => React.createElement('BlurView', props, props.children) }));
vi.mock('expo-modules-core', () => ({
    EventEmitter: class {},
    NativeModule: class {},
    SharedObject: class {},
    requireNativeModule: () => ({}),
    requireOptionalNativeModule: () => null,
}));
vi.mock('expo-crypto', () => ({
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
    getRandomValues: (arr: Uint8Array) => arr,
}));
vi.mock('expo-localization', () => ({
    getLocales: () => [{ languageTag: 'en-US', languageCode: 'en' }],
}));
vi.mock('expo-constants', () => ({
    default: { expoConfig: { extra: {} } },
}));
vi.mock('expo-application', () => ({
    applicationId: 'engineering.happy.codelync',
    nativeApplicationVersion: '1.0.0',
    nativeBuildVersion: '1',
}));
vi.mock('@/sync/persistence', () => ({
    loadSettings: () => ({ settings: { preferredLanguage: null } }),
}));
vi.mock('@/sync/remoteDesktop', () => ({
    desktopPoint: () => ({ x: 10, y: 10 }),
}));
vi.mock('@/sync/rig', () => ({
    isRigMetadata: () => false,
}));
vi.mock('@/utils/thumbhash', () => ({
    generateThumbhash: vi.fn(async () => 'thumb'),
}));
vi.mock('expo-image', () => ({ Image: (props: any) => React.createElement('ExpoImage', props) }));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
    Octicons: (props: any) => React.createElement('Octicons', props),
}));
vi.mock('react-native-svg', () => ({
    default: (props: any) => React.createElement('Svg', props, props.children),
    Circle: (props: any) => React.createElement('Circle', props),
}));
vi.mock('expo-router', () => ({
    useRouter: () => ({ canGoBack: () => true, back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@livekit/react-native', () => ({
    RoomContext: React.createContext(null),
    VideoTrack: (props: any) => React.createElement('VideoTrack', props),
    useTracks: () => [],
    isTrackReference: () => false,
}));
vi.mock('livekit-client', () => ({
    Track: { Source: { ScreenShare: 'screen_share' } },
    RemoteVideoTrack: class {},
}));

vi.mock('@/hooks/useRemoteDesktop', () => ({
    useRemoteDesktop: () => ({
        grant: state.desktopConnected ? {
            hostIdentity: 'mac-host',
            trackSid: 'track-1',
            display: { id: 'disp-1', name: 'Built-in Retina Display', width: 2560, height: 1600, geometry: '2560x1600' },
        } : null,
        room: state.desktopConnected ? {} : null,
        displays: state.desktopDisplays,
        status: {
            enabled: true,
            permissions: { screenRecording: true, accessibility: true, locked: false },
        },
        quality: { width: 1920, fps: 60 },
        ready: state.desktopReady,
        inputAllowed: state.desktopInputAllowed,
        busy: state.desktopBusy,
        closing: false,
        error: state.desktopError,
        notice: null,
        connect: state.connect,
        disconnect: state.disconnect,
        refresh: state.refresh,
        switchDisplay: vi.fn(async () => {}),
        changeQuality: vi.fn(async () => {}),
        navigateSpace: vi.fn(async () => {}),
        videoReady: vi.fn(async () => true),
        input: state.input,
    }),
}));

vi.mock('@/text', () => ({
    getCurrentLanguage: () => state.language,
    t: (key: string) => key,
}));

vi.mock('@/utils/responsive', () => ({
    getDeviceType: () => state.window.width > 700 ? 'tablet' : 'phone',
    useLayoutDimensions: () => ({ width: state.window.width, height: state.window.height }),
}));
vi.mock('@/utils/platform', () => ({
    isRunningOnMac: () => false,
}));
vi.mock('@/sync/storage', () => ({
    useSetting: (key: string) => key === 'agentInputEnterToSend' ? false : false,
}));
vi.mock('./MobileGlass', () => ({
    MobileGlassSurface: (props: any) => React.createElement('MobileGlassSurface', props, props.children),
}));
vi.mock('./AnimatedOverlay', () => ({
    AnimatedFade: (props: any) => React.createElement('AnimatedFade', props, props.children),
}));
vi.mock('./BubblePressable', () => ({
    BubblePressable: (props: any) => React.createElement('BubblePressable', props, props.children),
}));
vi.mock('./FloatingOverlay', () => ({
    FloatingOverlay: (props: any) => React.createElement('FloatingOverlay', props, props.children),
}));
vi.mock('./PickerSheet', () => ({
    PickerSheet: (props: any) => React.createElement('PickerSheet', props, props.children),
    PickerSheetOption: (props: any) => React.createElement('PickerSheetOption', props),
    PickerSheetSection: (props: any) => React.createElement('PickerSheetSection', props),
}));
vi.mock('./NativeSettingsMenu', () => ({
    NativeSettingsMenu: (props: any) => React.createElement('NativeSettingsMenu', props, props.children),
}));
vi.mock('./glassInteractionPolicy', () => ({
    shouldUseExpoNativeSettingsMenu: () => false,
}));
vi.mock('./MultiTextInput', () => ({
    MultiTextInput: React.forwardRef((props: any, ref: any) => {
        React.useImperativeHandle(ref, () => ({
            getText: () => props.defaultValue ?? '',
            setTextAndSelection: vi.fn(),
            blur: vi.fn(),
        }));
        return React.createElement('MultiTextInput', props);
    }),
}));
vi.mock('./Shaker', () => ({
    Shaker: React.forwardRef((props: any, _ref: any) => React.createElement('Shaker', props, props.children)),
}));
vi.mock('./StatusDot', () => ({
    StatusDot: (props: any) => React.createElement('StatusDot', props),
}));
vi.mock('./ProviderIcon', () => ({
    ProviderIcon: (props: any) => React.createElement('ProviderIcon', props),
}));
vi.mock('./AgentInputAttachmentStrip', () => ({
    AgentInputAttachmentStrip: (props: any) => React.createElement('AgentInputAttachmentStrip', props),
}));
vi.mock('./AgentInputAutocomplete', () => ({
    AgentInputAutocomplete: (props: any) => React.createElement('AgentInputAutocomplete', props),
}));
vi.mock('./autocomplete/useActiveWord', () => ({
    useActiveWord: () => null,
}));
vi.mock('./autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], -1, vi.fn(), vi.fn()],
}));
vi.mock('./haptics', () => ({
    hapticsLight: vi.fn(),
    hapticsError: vi.fn(),
}));

import { RemoteDesktopView } from './RemoteDesktopView';
import { RemoteDesktopKeyboard } from './RemoteDesktopKeyboard';
import { AgentInput } from './AgentInput';
import { remoteDesktopLabelsFor } from '@/text/remoteDesktopLabels';
import { agentInputLabelsFor, codelyncAgentInputLabels } from '@/text/codelyncAgentInputLabels';

function flattenStyle(style: unknown): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, any>>((acc, item) => ({ ...acc, ...flattenStyle(item) }), {});
    }
    return typeof style === 'object' ? (style as Record<string, any>) : {};
}

function resolveStyle(styleProp: unknown, stateArg = { pressed: false }): Record<string, any> {
    if (typeof styleProp === 'function') return flattenStyle(styleProp(stateArg));
    return flattenStyle(styleProp);
}

beforeEach(() => {
    state.dark = false;
    state.language = 'en';
    state.platform = 'ios';
    state.window = { width: 844, height: 390 };
    state.insets = { top: 0, bottom: 21, left: 59, right: 59 };
    state.desktopConnected = true;
    state.desktopBusy = false;
    state.desktopReady = true;
    state.desktopInputAllowed = true;
    state.desktopError = null;
    vi.clearAllMocks();
});

describe('Track D Batch 3 — R024 RemoteDesktopView & RemoteDesktopKeyboard', () => {
    it('sizes popover inside safe areas on compact 390pt landscape without clipping or <44pt targets', () => {
        state.language = 'ja';
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(RemoteDesktopView));
        });

        const byId = (id: string) => renderer.root.findAll((node: any) => node.props?.testID === id)[0];
        act(() => {
            byId('desktop-more').props.onPress();
        });

        const popover = byId('desktop-controls-panel');
        const popoverStyle = flattenStyle(popover.props.style);
        expect(popoverStyle.right).toBe(59 + 12);
        expect(popoverStyle.top).toBe(12);
        expect(popoverStyle.width).toBe(360);
        // 390 - 0 - 21 - 92 = 277pt, clearing bottom dock (bottom 33 + height 54 = 87pt)
        expect(popoverStyle.maxHeight).toBe(277);

        // Compact landscape tightens header & content padding while preserving >=44pt targets
        const scroll = popover.findByType('ScrollView');
        const contentStyle = flattenStyle(scroll.props.contentContainerStyle);
        expect(contentStyle.padding).toBe(10);
        expect(contentStyle.gap).toBe(6);

        const displayRow = byId('desktop-display-menu');
        expect(displayRow.props.accessibilityRole).toBe('button');
        expect(displayRow.props.accessibilityLabel).toContain('ディスプレイ');
        const rowStyle = resolveStyle(displayRow.props.style);
        expect(rowStyle.minHeight).toBeGreaterThanOrEqual(44);
        const rowTexts = displayRow.findAllByType('Text');
        expect(rowTexts[0].props.numberOfLines).toBe(1);
        expect(flattenStyle(rowTexts[0].props.style).flexShrink).toBe(1);

        // Secondary panel back button & fullscreen restore control are >=44pt
        act(() => {
            displayRow.props.onPress();
        });
        const backBtn = byId('desktop-panel-back');
        const backStyle = resolveStyle(backBtn.props.style);
        expect(backStyle.width).toBeGreaterThanOrEqual(44);
        expect(backStyle.height).toBeGreaterThanOrEqual(44);

        act(() => {
            byId('desktop-panel-back').props.onPress();
        });
        act(() => {
            byId('desktop-fullscreen').props.onPress();
        });
        expect(byId('desktop-restore-controls')).toBeDefined();
        const restoreBtn = byId('desktop-exit-fullscreen');
        const restoreStyle = resolveStyle(restoreBtn.props.style);
        expect(restoreStyle.width).toBeGreaterThanOrEqual(44);
        expect(restoreStyle.height).toBeGreaterThanOrEqual(44);

        act(() => renderer.unmount());
    });

    it('renders disconnected empty stage in a bottom-dock-safe ScrollView on landscape', () => {
        state.desktopConnected = false;
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(RemoteDesktopView));
        });

        const emptyScroll = renderer.root.findAll((node: any) => node.type === 'ScrollView' && node.props?.testID === 'desktop-empty-stage')[0];
        expect(emptyScroll.type).toBe('ScrollView');
        const emptyContentStyle = flattenStyle(emptyScroll.props.contentContainerStyle);
        expect(emptyContentStyle.paddingBottom).toBeGreaterThanOrEqual(state.insets.bottom + 76);

        act(() => renderer.unmount());
    });

    it('localizes remote desktop special-key screen-reader labels across EN/ZH/JA and collapses empty hint row', () => {
        for (const lang of ['en', 'zh-Hans', 'zh-Hant', 'ja'] as const) {
            const labels = remoteDesktopLabelsFor(lang);
            expect(labels.keyEscape.length).toBeGreaterThan(0);
            expect(labels.keyEnter.length).toBeGreaterThan(0);
            expect(labels.keyLeft.length).toBeGreaterThan(0);
            expect(labels.keyCommand.length).toBeGreaterThan(0);
            expect(labels.keyShift.length).toBeGreaterThan(0);
        }
        expect(remoteDesktopLabelsFor('ja').keyEnter).toBe('改行');
        expect(remoteDesktopLabelsFor('zh-Hans').keyEnter).toBe('回车');

        state.language = 'ja';
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(RemoteDesktopKeyboard, {
                visible: true,
                enabled: true,
                onInput: vi.fn(async () => true),
                onClose: vi.fn(),
            }));
        });

        // Empty hint collapses so canvas height is preserved
        expect(renderer.root.findAllByType('Text')).toHaveLength(0);

        const byId = (id: string) => renderer.root.findAll((node: any) => node.props?.testID === id)[0];
        act(() => {
            byId('desktop-keyboard-shortcuts').props.onPress();
        });

        expect(byId('desktop-key-escape-plain').props.accessibilityLabel).toBe('エスケープ');
        expect(byId('desktop-key-enter-plain').props.accessibilityLabel).toBe('改行');
        expect(byId('desktop-key-left-plain').props.accessibilityLabel).toBe('左矢印');
        expect(byId('desktop-key-c-command').props.accessibilityLabel).toBe('コマンド C');
        expect(byId('desktop-key-z-shift-command').props.accessibilityLabel).toBe('シフト コマンド Z');

        act(() => {
            renderer.update(React.createElement(RemoteDesktopKeyboard, {
                visible: true,
                enabled: false,
                hint: 'Not ready',
                onInput: vi.fn(async () => true),
                onClose: vi.fn(),
            }));
        });
        const hintTexts = renderer.root.findAllByType('Text').filter((n: any) => n.props.children === 'Not ready');
        expect(hintTexts).toHaveLength(1);
        expect(hintTexts[0].props.accessibilityLiveRegion).toBe('polite');

        act(() => renderer.unmount());
    });
});

describe('Track D Batch 3 — R029 AgentInput localization, accessibility & light/dark contrast', () => {
    it('provides complete AgentInput labels across all supported languages including EN/ZH-Hans/ZH-Hant/JA', () => {
        for (const lang of SUPPORTED_LANGUAGE_CODES) {
            const labels = codelyncAgentInputLabels[lang];
            expect(labels.addPhoto.trim().length).toBeGreaterThan(0);
            expect(labels.send.trim().length).toBeGreaterThan(0);
            expect(labels.stop.trim().length).toBeGreaterThan(0);
            expect(labels.voice.trim().length).toBeGreaterThan(0);
            expect(labels.sandboxed('YOLO')).toContain('YOLO');
            if (lang !== 'en') {
                expect(labels.sandboxed('YOLO')).not.toContain('(sandboxed)');
            }
        }
        expect(agentInputLabelsFor('zh-Hans').sandboxed('YOLO')).toBe('YOLO（沙盒）');
        expect(agentInputLabelsFor('zh-Hant').sandboxed('YOLO')).toBe('YOLO（沙盒）');
        expect(agentInputLabelsFor('ja').sandboxed('YOLO')).toBe('YOLO（サンドボックス）');
    });

    it('localizes sandboxed suffix, exposes mobile control accessibility, and keeps light/dark contrast distinct', () => {
        state.window = { width: 390, height: 844 };
        state.language = 'ja';
        state.dark = false;

        const baseProps = {
            initialValue: '',
            placeholder: 'Message',
            onSend: vi.fn(),
            onPickImages: vi.fn(),
            onPermissionModeChange: vi.fn(),
            onModelModeChange: vi.fn(),
            onEffortLevelChange: vi.fn(),
            onMachineClick: vi.fn(),
            onPathClick: vi.fn(),
            machineName: 'Mac Studio',
            currentPath: '/Users/mac/repo',
            permissionMode: { key: 'yolo', name: 'YOLO', description: 'full access' },
            availableModes: [
                { key: 'default', name: 'Default', description: 'Ask' },
                { key: 'yolo', name: 'YOLO', description: 'full access' },
            ],
            modelMode: { key: 'gpt-5', name: 'GPT-5' },
            availableModels: [{ key: 'gpt-5', name: 'GPT-5' }],
            effortLevel: { key: 'medium', name: 'Medium' },
            availableEffortLevels: [{ key: 'medium', name: 'Medium' }],
            metadata: { sandbox: { enabled: true } } as any,
            autocompletePrefixes: ['@'],
            autocompleteSuggestions: async () => [],
            usageData: { inputTokens: 100, outputTokens: 50, cacheCreation: 0, cacheRead: 0, contextSize: 95000, contextWindow: 100000 },
            alwaysShowContextSize: true,
        };

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(AgentInput, baseProps));
        });

        const buttons = renderer.root.findAll((node: any) => node.props?.accessibilityRole === 'button');
        const labels = buttons.map((b: any) => b.props.accessibilityLabel);
        expect(labels).toContain('写真を追加');
        expect(labels).toContain('agentInput.permissionMode.title');
        expect(labels).toContain('agentInput.model.title');
        expect(labels).toContain('agentInput.effort.title');
        expect(labels).toContain('送信');
        expect(labels.some((l: string) => l?.startsWith('Mac を切り替え'))).toBe(true);
        expect(labels.some((l: string) => l?.startsWith('ディレクトリを変更'))).toBe(true);
        expect(labels).toContain('コンテキスト使用量の詳細を切り替え');

        // Inactive mobile send arrow uses higher-contrast muted tint instead of #8E8E93
        const arrowIcons = renderer.root.findAll((node: any) => node.type === 'Octicons' && node.props.name === 'arrow-up');
        expect(flattenStyle(arrowIcons[0].props.style).color).toBe('#5C5C60');

        // Light mode mobileUnifiedPanel uses glass.divider instead of bright white glass.border
        const glassSurface = renderer.root.findByType('MobileGlassSurface');
        expect(flattenStyle(glassSurface.props.style).borderColor).toBe(lightTheme.colors.glass.divider);

        // Open permission PickerSheet -> localized sandbox suffix without '(sandboxed)'
        const permBtn = buttons.find((b: any) => b.props.accessibilityLabel === 'agentInput.permissionMode.title')!;
        act(() => {
            permBtn.props.onPress();
        });
        const pickerOptions = renderer.root.findAllByType('PickerSheetOption');
        expect(pickerOptions.map((o: any) => o.props.label)).toContain('YOLO（サンドボックス）');
        expect(pickerOptions.some((o: any) => String(o.props.label).includes('(sandboxed)'))).toBe(false);

        act(() => renderer.unmount());

        // Dark + blocked send renders high-contrast locked state instead of blending into #1E1E1E
        state.dark = true;
        state.language = 'zh-Hans';
        act(() => {
            renderer = create(React.createElement(AgentInput, {
                ...baseProps,
                initialValue: 'draft',
                blockSend: true,
            }));
        });
        const darkGlass = renderer.root.findByType('MobileGlassSurface');
        expect(flattenStyle(darkGlass.props.style).borderColor).toBe(darkTheme.colors.glass.border);
        const lockIcons = renderer.root.findAll((node: any) => node.type === 'Ionicons' && node.props.name === 'lock-closed');
        expect(lockIcons[0].props.color).toBe('#AEAEB2');
        const blockedBtn = renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props?.accessibilityRole === 'button' && node.props?.accessibilityLabel === 'codelyncLoading.unavailable');
        expect(blockedBtn).toHaveLength(1);

        act(() => renderer.unmount());
    });

    it('adds accessibility roles/states and unified divider styles to desktop composer & picker overlay', () => {
        state.platform = 'web';
        state.window = { width: 1024, height: 800 };
        state.language = 'zh-Hant';

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(AgentInput, {
                initialValue: 'hello',
                placeholder: 'Message',
                onSend: vi.fn(),
                onAbort: vi.fn(async () => {}),
                onPickImages: vi.fn(),
                onPermissionModeChange: vi.fn(),
                onModelModeChange: vi.fn(),
                onEffortLevelChange: vi.fn(),
                agentType: 'claude',
                onAgentClick: vi.fn(),
                permissionMode: { key: 'bypassPermissions', name: 'YOLO', description: 'full' },
                availableModes: [{ key: 'bypassPermissions', name: 'YOLO', description: 'full' }],
                modelMode: { key: 'opus', name: 'Opus' },
                availableModels: [{ key: 'opus', name: 'Opus' }],
                effortLevel: { key: 'high', name: 'High' },
                availableEffortLevels: [{ key: 'high', name: 'High' }],
                metadata: { sandbox: { enabled: true } } as any,
                autocompletePrefixes: ['@'],
                autocompleteSuggestions: async () => [],
            }));
        });

        const buttons = renderer.root.findAll((node: any) => node.props?.accessibilityRole === 'button');
        const labels = buttons.map((b: any) => b.props.accessibilityLabel);
        expect(labels).toContain('settings.title');
        expect(labels).toContain('停止回覆');
        expect(labels).toContain('新增圖片');
        expect(labels).toContain('傳送');
        expect(labels.some((l: string) => l?.startsWith('切換代理'))).toBe(true);

        // Open desktop settings overlay and verify radio roles + sandboxed zh-Hant label
        const settingsBtn = buttons.find((b: any) => b.props.accessibilityLabel === 'settings.title')!;
        act(() => {
            settingsBtn.props.onPress();
        });
        const radios = renderer.root.findAll((node: any) => node.props?.accessibilityRole === 'radio');
        expect(radios.length).toBeGreaterThanOrEqual(3);
        expect(radios[0].props.accessibilityState).toEqual({ selected: true });
        const overlayTexts = renderer.root.findAllByType('Text').map((n: any) => n.props.children);
        expect(overlayTexts).toContain('YOLO（沙盒）');

        act(() => renderer.unmount());
    });
});
