import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopDisplay, DesktopInput, DesktopViewport, DesktopWindowItem } from '@/sync/remoteDesktop';

type KeyboardEventName = 'keyboardWillChangeFrame' | 'keyboardDidShow' | 'keyboardDidHide';

const env = vi.hoisted(() => {
    const keyboardListeners = new Map<KeyboardEventName, Set<(event: any) => void>>();
    const backListeners = new Set<() => boolean>();
    return {
        enabled: true,
        focused: true,
        paired: true,
        language: 'en' as 'en' | 'zh-Hans' | 'zh-Hant' | 'ja',
        platform: 'ios' as 'ios' | 'android',
        isPad: false,
        window: { width: 852, height: 393 },
        insets: { top: 0, bottom: 21, left: 59, right: 59 },
        initialMetrics: null as { frame: { width: number; height: number }; insets: { top: number; right: number; bottom: number; left: number } } | null,
        displays: [] as DesktopDisplay[],
        selectedDisplayId: '',
        virtualDisplaySupported: true,
        grant: null as null | {
            hostIdentity: string;
            trackSid: string;
            display: DesktopDisplay;
        },
        room: null as Record<string, unknown> | null,
        ready: true,
        inputAllowed: true,
        busy: false,
        closing: false,
        error: null as string | null,
        notice: null as string | null,
        windows: [] as DesktopWindowItem[],
        activeWindowId: null as string | null,
        windowsLoading: false,
        canGoBack: true,
        routerBack: vi.fn(),
        routerReplace: vi.fn(),
        connect: vi.fn(async (_displayId: string, _viewport?: DesktopViewport) => {}),
        disconnect: vi.fn(async () => {}),
        refresh: vi.fn(async () => {}),
        switchDisplay: vi.fn(async (_displayId: string, _viewport?: DesktopViewport) => {}),
        changeQuality: vi.fn(async () => {}),
        navigateSpace: vi.fn(async () => {}),
        refreshWindows: vi.fn(async () => {}),
        fillWindow: vi.fn(async (_windowId: string) => true),
        restoreWindow: vi.fn(async () => true),
        videoReady: vi.fn(async () => true),
        input: vi.fn(async (_payload: DesktopInput) => true),
        keyboardDismiss: vi.fn(),
        keyboardListeners,
        backListeners,
        emitKeyboard(name: KeyboardEventName, event: any) {
            for (const cb of keyboardListeners.get(name) ?? []) cb(event);
        },
        triggerHardwareBack(): boolean {
            const handlers = Array.from(backListeners).reverse();
            for (const fn of handlers) {
                if (fn()) return true;
            }
            return false;
        },
    };
});

vi.hoisted(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { cb(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

vi.mock('react-native', async () => {
    const ReactMod = await import('react');
    const host = (name: string) => (props: any) => ReactMod.createElement(name, props, props.children);
    const TextInputHost = ReactMod.forwardRef((props: any, ref: any) => {
        ReactMod.useImperativeHandle(ref, () => ({ focus: vi.fn(), blur: vi.fn() }));
        return ReactMod.createElement('TextInput', props, props.children);
    });
    return {
        Platform: {
            get OS() { return env.platform; },
            get isPad() { return env.isPad; },
            select: (values: Record<string, unknown>) => values[env.platform] ?? values.default,
        },
        ActivityIndicator: host('ActivityIndicator'),
        Dimensions: {
            get: () => ({ width: env.window.width, height: env.window.height }),
        },
        BackHandler: {
            addEventListener: (_eventName: string, handler: () => boolean) => {
                env.backListeners.add(handler);
                return { remove: () => { env.backListeners.delete(handler); } };
            },
        },
        Keyboard: {
            dismiss: env.keyboardDismiss,
            addListener: (name: KeyboardEventName, cb: (event: any) => void) => {
                if (!env.keyboardListeners.has(name)) env.keyboardListeners.set(name, new Set());
                env.keyboardListeners.get(name)!.add(cb);
                return { remove: () => { env.keyboardListeners.get(name)?.delete(cb); } };
            },
        },
        PanResponder: {
            create: (config: Record<string, unknown>) => ({ panHandlers: config }),
        },
        Pressable: host('Pressable'),
        ScrollView: host('ScrollView'),
        StyleSheet: {
            hairlineWidth: 0.5,
            absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
            absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
            create: (styles: unknown) => (typeof styles === 'function' ? (styles as () => unknown)() : styles),
        },
        Text: host('Text'),
        TextInput: TextInputHost,
        View: host('View'),
        useWindowDimensions: () => env.window,
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 0.5,
        absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
        absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
        create: (factory: unknown) => (typeof factory === 'function' ? (factory as () => unknown)() : factory),
    },
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => env.insets,
    get initialWindowMetrics() { return env.initialMetrics; },
}));

vi.mock('expo-blur', () => ({ BlurView: (props: any) => React.createElement('BlurView', props, props.children) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: (props: any) => React.createElement('Ionicons', props) }));
vi.mock('expo-router', () => ({
    Stack: { Screen: 'Screen' },
    Redirect: 'Redirect',
    useRouter: () => ({
        canGoBack: () => env.canGoBack,
        back: env.routerBack,
        replace: env.routerReplace,
    }),
}));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => env.focused }));
vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: env.paired,
        credentials: env.paired ? { peer: { id: 'fixture-peer' } } : null,
    }),
}));
vi.mock('@/sync/storage', () => ({ useLocalSetting: () => env.enabled }));
vi.mock('@/components/onboarding/CodelyncScanScreen', () => ({
    CodelyncScanScreen: () => React.createElement('CodelyncScanScreen'),
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
vi.mock('expo-crypto', () => ({ getRandomBytes: () => new Uint8Array(24) }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: vi.fn() } }));
vi.mock('@/sync/peerNetwork', () => ({ peerAuthorization: vi.fn(), decodePeerResponse: vi.fn() }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://paired.example' }));
vi.mock('@/text', () => ({
    getCurrentLanguage: () => env.language,
    t: (key: string) => key,
}));

vi.mock('@/hooks/useRemoteDesktop', () => ({
    useRemoteDesktop: () => {
        const selectedDisplay = env.grant?.display
            ?? env.displays.find(item => item.id === env.selectedDisplayId)
            ?? env.displays[0]
            ?? null;
        const isVirtualDisplay = !!selectedDisplay && (selectedDisplay.kind === 'virtual' || selectedDisplay.id === 'virtual');
        return {
            status: {
                version: 1 as const,
                enabled: true,
                mode: 'local' as const,
                connected: !!env.grant,
                permissions: { screenRecording: true, accessibility: true, locked: false },
                quality: { width: 1920 as const, fps: 30 as const },
            },
            displays: env.displays,
            selectedDisplayId: selectedDisplay?.id ?? '',
            selectedDisplay,
            selectDisplay: (id: string) => { env.selectedDisplayId = id; },
            isVirtualDisplay,
            virtualDisplaySupported: env.virtualDisplaySupported,
            grant: env.grant,
            room: env.room,
            busy: env.busy,
            closing: env.closing,
            ready: env.ready,
            inputAllowed: env.inputAllowed,
            error: env.error,
            notice: env.notice,
            quality: { width: 1920 as const, fps: 30 as const },
            windows: env.windows,
            activeWindowId: env.activeWindowId,
            windowsLoading: env.windowsLoading,
            connect: env.connect,
            disconnect: env.disconnect,
            refresh: env.refresh,
            input: env.input,
            changeQuality: env.changeQuality,
            switchDisplay: env.switchDisplay,
            navigateSpace: env.navigateSpace,
            refreshWindows: env.refreshWindows,
            fillWindow: env.fillWindow,
            restoreWindow: env.restoreWindow,
            videoReady: env.videoReady,
        };
    },
}));

import DesktopScreen from '../app/(app)/desktop';
import { RemoteDesktopView } from './RemoteDesktopView';
import { remoteDesktopLabelsFor } from '@/text/remoteDesktopLabels';

const physicalDisplay: DesktopDisplay = {
    id: '1',
    name: 'Studio Display',
    kind: 'physical',
    width: 2560,
    height: 1440,
    geometry: 'phys-1',
};

const virtualDisplay: DesktopDisplay = {
    id: 'virtual',
    name: 'Phone Screen',
    kind: 'virtual',
    width: 1080,
    height: 2160,
    logicalWidth: 540,
    logicalHeight: 1080,
    geometry: 'virt-1',
};

function flattenStyle(style: unknown): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, any>>((acc, item) => ({ ...acc, ...flattenStyle(item) }), {});
    }
    return typeof style === 'object' ? (style as Record<string, any>) : {};
}

function resolveStyle(styleProp: unknown): Record<string, any> {
    if (typeof styleProp === 'function') return flattenStyle(styleProp({ pressed: false }));
    return flattenStyle(styleProp);
}

function hostViewsByTestID(root: ReturnType<typeof create>['root'], testID: string) {
    return root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === testID);
}

describe('RemoteDesktopPortraitVirtual (M5 UI-01..UI-08)', () => {
    let renderer: ReturnType<typeof create> | undefined;

    beforeEach(() => {
        env.enabled = true;
        env.focused = true;
        env.paired = true;
        env.language = 'en';
        env.platform = 'ios';
        env.isPad = false;
        env.window = { width: 852, height: 393 };
        env.insets = { top: 0, bottom: 21, left: 59, right: 59 };
        env.initialMetrics = null;
        env.displays = [physicalDisplay, virtualDisplay];
        env.selectedDisplayId = '';
        env.virtualDisplaySupported = true;
        env.grant = null;
        env.room = null;
        env.ready = true;
        env.inputAllowed = true;
        env.busy = false;
        env.closing = false;
        env.error = null;
        env.notice = null;
        env.windows = [];
        env.activeWindowId = null;
        env.windowsLoading = false;
        env.canGoBack = true;
        env.keyboardListeners.clear();
        env.backListeners.clear();
        vi.clearAllMocks();
    });

    afterEach(() => {
        if (renderer) {
            act(() => { renderer!.unmount(); });
            renderer = undefined;
        }
        vi.restoreAllMocks();
    });

    it('UI-01: dynamically switches Stack.Screen between landscape and portrait without unmounting DesktopCanvas, and restores portrait on exit/blur', () => {
        const roomInstance = { id: 'room-1' };
        env.room = roomInstance;
        env.grant = { hostIdentity: 'mac-host', trackSid: 'track-p1', display: physicalDisplay };

        act(() => { renderer = create(React.createElement(DesktopScreen)); });
        expect(renderer!.root.findByType('Screen').props.options).toEqual({
            headerShown: false,
            statusBarHidden: true,
            orientation: 'landscape',
            gestureEnabled: false,
            fullScreenGestureEnabled: false,
        });
        const firstCanvas = renderer!.root.findByProps({ testID: 'remote-desktop-canvas' });

        env.grant = { hostIdentity: 'mac-host', trackSid: 'track-v1', display: virtualDisplay };
        env.window = { width: 393, height: 852 };
        env.insets = { top: 59, bottom: 34, left: 0, right: 0 };
        act(() => { renderer!.update(React.createElement(DesktopScreen)); });
        expect(renderer!.root.findByType('Screen').props.options).toMatchObject({
            orientation: 'portrait',
            statusBarHidden: false,
        });
        const secondCanvas = renderer!.root.findByProps({ testID: 'remote-desktop-canvas' });
        expect(secondCanvas).toBe(firstCanvas);

        env.grant = { hostIdentity: 'mac-host', trackSid: 'track-p2', display: physicalDisplay };
        act(() => { renderer!.update(React.createElement(DesktopScreen)); });
        expect(renderer!.root.findByType('Screen').props.options).toMatchObject({
            orientation: 'landscape',
            statusBarHidden: true,
        });
        expect(renderer!.root.findByProps({ testID: 'remote-desktop-canvas' })).toBe(firstCanvas);

        act(() => { renderer!.root.findByProps({ testID: 'desktop-exit' }).props.onPress(); });
        expect(env.disconnect).toHaveBeenCalledTimes(1);
        expect(env.routerBack).toHaveBeenCalledTimes(1);
        expect(renderer!.root.findByType('Screen').props.options).toMatchObject({
            orientation: 'portrait',
            statusBarHidden: false,
        });
    });

    it('UI-02: renders localized Phone Screen when supported (including Headless Mac), hides when unsupported, and submits portrait viewport from landscape', () => {
        env.language = 'zh-Hans';
        const zhLabels = remoteDesktopLabelsFor('zh-Hans');
        act(() => { renderer = create(React.createElement(DesktopScreen)); });

        act(() => { renderer!.root.findByProps({ testID: 'desktop-choose-display' }).props.onPress(); });
        const virtualChoice = renderer!.root.findByProps({ testID: 'desktop-display-virtual' });
        const choiceText = virtualChoice.findByType('Text').props.children;
        expect(choiceText).toBe(zhLabels.phoneScreen);

        act(() => { virtualChoice.props.onPress(); });
        expect(renderer!.root.findByType('Screen').props.options).toMatchObject({
            orientation: 'portrait',
            statusBarHidden: false,
        });

        act(() => { renderer!.root.findByProps({ testID: 'desktop-connect' }).props.onPress(); });
        expect(env.connect).toHaveBeenCalledWith('virtual', { width: 393, height: 759 });

        act(() => { renderer!.unmount(); renderer = undefined; });

        // Unsupported macOS host omits "virtual"
        env.displays = [physicalDisplay];
        env.virtualDisplaySupported = false;
        env.room = { id: 'room-phys' };
        env.grant = { hostIdentity: 'mac-host', trackSid: 'track-p1', display: physicalDisplay };
        act(() => { renderer = create(React.createElement(DesktopScreen)); });
        expect(renderer!.root.findAllByProps({ testID: 'desktop-windows' })).toHaveLength(0);
        act(() => { renderer!.root.findByProps({ testID: 'desktop-more' }).props.onPress(); });
        expect(renderer!.root.findAllByProps({ testID: 'desktop-windows-menu' })).toHaveLength(0);
        act(() => { renderer!.root.findByProps({ testID: 'desktop-display-menu' }).props.onPress(); });
        expect(renderer!.root.findAllByProps({ testID: 'desktop-display-virtual' })).toHaveLength(0);

        act(() => { renderer!.unmount(); renderer = undefined; });

        // Headless Mac with [virtualDisplay] only
        env.displays = [virtualDisplay];
        env.virtualDisplaySupported = true;
        env.grant = null;
        env.room = null;
        act(() => { renderer = create(React.createElement(DesktopScreen)); });
        expect(renderer!.root.findByType('Screen').props.options).toMatchObject({
            orientation: 'portrait',
            statusBarHidden: false,
        });
        expect(renderer!.root.findByProps({ testID: 'desktop-single-display-label' }).props.children).toBe(zhLabels.phoneScreen);
        act(() => { renderer!.root.findByProps({ testID: 'desktop-connect' }).props.onPress(); });
        expect(env.connect).toHaveBeenCalledWith('virtual', { width: 393, height: 759 });
    });

    it('UI-03: applies portrait safe-area stage insets and keeps 5-icon >=44pt dock unclipped on a 375pt narrow screen', () => {
        env.window = { width: 375, height: 812 };
        env.insets = { top: 59, bottom: 34, left: 0, right: 0 };
        env.room = { id: 'room-v' };
        env.grant = { hostIdentity: 'mac-host', trackSid: 'track-v1', display: virtualDisplay };

        act(() => { renderer = create(React.createElement(RemoteDesktopView)); });
        const stageStyle = resolveStyle(renderer!.root.findByProps({ testID: 'desktop-video-stage' }).props.style);
        expect(stageStyle.paddingTop).toBe(59);
        expect(stageStyle.paddingBottom).toBe(34);

        const dock = renderer!.root.findByProps({ testID: 'desktop-control-dock' });
        const dockStyle = resolveStyle(dock.props.style);
        expect(dockStyle.bottom).toBe(46);
        expect(dockStyle.maxWidth).toBe(351);

        const dockButtonIds = ['desktop-exit', 'desktop-connection-indicator', 'desktop-windows', 'desktop-keyboard', 'desktop-more'];
        for (const id of dockButtonIds) {
            const btn = renderer!.root.findByProps({ testID: id });
            const btnStyle = resolveStyle(btn.props.style);
            expect(btnStyle.width).toBeGreaterThanOrEqual(44);
            expect(btnStyle.height).toBeGreaterThanOrEqual(44);
        }
        const totalDockWidth = dockButtonIds.length * 44 + (dockButtonIds.length - 1) * (dockStyle.gap ?? 4) + 2 * (dockStyle.padding ?? 5) + 2;
        expect(totalDockWidth).toBeLessThanOrEqual(dockStyle.maxWidth);
    });

    it('UI-04: lifts root above iOS & Android IME, collapses portrait stage bottom padding, focuses tapped target, and retains mounted IME drafts', () => {
        env.window = { width: 393, height: 852 };
        env.insets = { top: 59, bottom: 34, left: 0, right: 0 };
        env.room = { id: 'room-v' };
        env.grant = { hostIdentity: 'mac-host', trackSid: 'track-v1', display: virtualDisplay };

        const nowSpy = vi.spyOn(Date, 'now');
        nowSpy.mockReturnValue(1_000);

        for (const os of ['ios', 'android'] as const) {
            env.platform = os;
            act(() => { renderer = create(React.createElement(RemoteDesktopView)); });

            const canvas = renderer!.root.findByProps({ testID: 'remote-desktop-canvas' });
            act(() => { canvas.props.onLayout({ nativeEvent: { layout: { width: 393, height: 759 } } }); });

            const touchOverlay = canvas.findAllByType('View').find((node: any) => typeof node.props.onPanResponderGrant === 'function')!;
            act(() => {
                touchOverlay.props.onPanResponderGrant({ nativeEvent: { locationX: 200, locationY: 600, touches: [{ pageX: 200, pageY: 600 }] } });
                touchOverlay.props.onPanResponderRelease();
            });

            act(() => { renderer!.root.findByProps({ testID: 'desktop-windows' }).props.onPress(); });
            expect(hostViewsByTestID(renderer!.root, 'desktop-windows-panel')).toHaveLength(1);

            act(() => { renderer!.root.findByProps({ testID: 'desktop-keyboard' }).props.onPress(); });
            expect(hostViewsByTestID(renderer!.root, 'desktop-windows-panel')).toHaveLength(0);
            expect(hostViewsByTestID(renderer!.root, 'desktop-control-dock')).toHaveLength(0);

            // Hardware keyboard (keyboardHeight === 0) uses insets.bottom + 8 = 42
            const pageNode = hostViewsByTestID(renderer!.root, 'remote-desktop-page')[0]!;
            const kbContainer = pageNode.children[1] as any;
            expect(resolveStyle(kbContainer.props.style).paddingBottom).toBe(42);

            const textInput = hostViewsByTestID(renderer!.root, 'desktop-text-input')[0]!;
            act(() => { textInput.props.onChangeText('中文草稿 draft'); });

            act(() => { env.emitKeyboard('keyboardDidShow', { endCoordinates: { screenY: 532, height: 320 } }); });
            const pageStyle = resolveStyle(pageNode.props.style);
            expect(pageStyle.paddingBottom).toBe(320);
            expect(resolveStyle(kbContainer.props.style).paddingBottom).toBe(8);

            const stageStyle = resolveStyle(hostViewsByTestID(renderer!.root, 'desktop-video-stage')[0]!.props.style);
            expect(stageStyle.paddingTop).toBe(59);
            expect(stageStyle.paddingBottom).toBe(0);

            // Shrinking canvas layout triggers desktopViewportFocus locally without network input calls
            const inputCallsBeforeFocus = env.input.mock.calls.length;
            act(() => { canvas.props.onLayout({ nativeEvent: { layout: { width: 393, height: 420 } } }); });
            expect(env.input.mock.calls.length).toBe(inputCallsBeforeFocus);

            // Closing keyboard keeps draft text mounted and restores dock
            act(() => { hostViewsByTestID(renderer!.root, 'desktop-keyboard-close')[0]!.props.onPress(); });
            expect(hostViewsByTestID(renderer!.root, 'desktop-control-dock')).toHaveLength(1);

            act(() => { renderer!.root.findByProps({ testID: 'desktop-keyboard' }).props.onPress(); });
            expect(hostViewsByTestID(renderer!.root, 'desktop-text-input')[0]!.props.value).toBe('中文草稿 draft');

            act(() => { renderer!.unmount(); renderer = undefined; });
        }
    });

    it('UI-05: dispatches anchored 1-finger scroll on Phone Screen pointer mode (>6pt at zoom=1) while preserving tap, physical move, drag, right-click, scroll and zoom/pan', () => {
        env.window = { width: 393, height: 852 };
        env.insets = { top: 59, bottom: 34, left: 0, right: 0 };
        env.room = { id: 'room-v' };
        env.grant = {
            hostIdentity: 'mac-host',
            trackSid: 'track-v1',
            display: { ...virtualDisplay, width: 786, height: 1518 },
        };

        let clock = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => clock);

        act(() => { renderer = create(React.createElement(RemoteDesktopView)); });
        const canvas = renderer!.root.findByProps({ testID: 'remote-desktop-canvas' });
        act(() => { canvas.props.onLayout({ nativeEvent: { layout: { width: 393, height: 759 } } }); });

        const getResponder = () => renderer!.root
            .findByProps({ testID: 'remote-desktop-canvas' })
            .findAllByType('View')
            .find((node: any) => typeof node.props.onPanResponderGrant === 'function')!;

        // (a1) Stationary tap <= 6pt (dx=3, dy=4 -> hypot=5) -> left click, zero scroll
        act(() => {
            const r = getResponder();
            r.props.onPanResponderGrant({ nativeEvent: { locationX: 196.5, locationY: 379.5, touches: [{ pageX: 196.5, pageY: 379.5 }] } });
            clock += 80;
            r.props.onPanResponderMove({ nativeEvent: { locationX: 199.5, locationY: 383.5, touches: [{ pageX: 199.5, pageY: 383.5 }] } });
            r.props.onPanResponderRelease();
        });
        expect(env.input).toHaveBeenCalledTimes(1);
        expect(env.input.mock.calls[0]?.[0]).toMatchObject({ action: 'pointer', phase: 'click', button: 'left' });
        const startNormX = (env.input.mock.calls[0]?.[0] as any).x;
        const startNormY = (env.input.mock.calls[0]?.[0] as any).y;
        expect(startNormX).toBeCloseTo(0.5, 4);
        expect(startNormY).toBeCloseTo(0.5, 4);

        // (a2) Single-finger drag > 6pt on Virtual Phone Screen -> anchored scroll packets, NO click on release
        env.input.mockClear();
        act(() => {
            const r = getResponder();
            r.props.onPanResponderGrant({ nativeEvent: { locationX: 196.5, locationY: 379.5, touches: [{ pageX: 196.5, pageY: 379.5 }] } });
            clock += 80;
            r.props.onPanResponderMove({ nativeEvent: { locationX: 196.5, locationY: 419.5, touches: [{ pageX: 196.5, pageY: 419.5 }] } });
            clock += 80;
            r.props.onPanResponderMove({ nativeEvent: { locationX: 196.5, locationY: 394.5, touches: [{ pageX: 196.5, pageY: 394.5 }] } });
            r.props.onPanResponderRelease();
        });
        expect(env.input.mock.calls.map(([arg]) => arg)).toEqual([
            { action: 'scroll', deltaY: 40, x: startNormX, y: startNormY },
            { action: 'scroll', deltaY: -25, x: startNormX, y: startNormY },
        ]);

        // (c) Explicit 'drag' mode on Virtual Phone Screen -> pointer down, move, up
        env.input.mockClear();
        act(() => { renderer!.root.findByProps({ testID: 'desktop-more' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-drag' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-panel-close' }).props.onPress(); });
        act(() => {
            const r = getResponder();
            r.props.onPanResponderGrant({ nativeEvent: { locationX: 100, locationY: 200, touches: [{ pageX: 100, pageY: 200 }] } });
            clock += 80;
            r.props.onPanResponderMove({ nativeEvent: { locationX: 140, locationY: 250, touches: [{ pageX: 140, pageY: 250 }] } });
            r.props.onPanResponderRelease();
        });
        expect(env.input.mock.calls.map(([arg]) => (arg as any).phase)).toEqual(['down', 'move', 'up']);

        // (d) Explicit 'right' mode tap <= 6pt -> button: 'right'
        env.input.mockClear();
        act(() => { renderer!.root.findByProps({ testID: 'desktop-more' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-right-click' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-panel-close' }).props.onPress(); });
        act(() => {
            const r = getResponder();
            r.props.onPanResponderGrant({ nativeEvent: { locationX: 196.5, locationY: 379.5, touches: [{ pageX: 196.5, pageY: 379.5 }] } });
            r.props.onPanResponderRelease();
        });
        expect(env.input).toHaveBeenCalledWith(expect.objectContaining({ action: 'pointer', phase: 'click', button: 'right' }));

        // (e & f) Zoom > 1 in 'pointer' mode pans locally without network scroll/move; 2-finger pinch releases active drag
        env.input.mockClear();
        act(() => { renderer!.root.findByProps({ testID: 'desktop-more' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-pointer' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-zoom-in' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-panel-close' }).props.onPress(); });
        act(() => {
            const r = getResponder();
            r.props.onPanResponderGrant({ nativeEvent: { locationX: 196.5, locationY: 379.5, touches: [{ pageX: 196.5, pageY: 379.5 }] } });
            clock += 80;
            r.props.onPanResponderMove({ nativeEvent: { locationX: 220, locationY: 420, touches: [{ pageX: 220, pageY: 420 }] } });
            r.props.onPanResponderRelease();
        });
        expect(env.input).not.toHaveBeenCalled();

        // 2-finger pinch releases active drag
        act(() => { renderer!.root.findByProps({ testID: 'desktop-more' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-fit' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-drag' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-panel-close' }).props.onPress(); });
        env.input.mockClear();
        act(() => {
            const r = getResponder();
            r.props.onPanResponderGrant({ nativeEvent: { locationX: 150, locationY: 300, touches: [{ pageX: 150, pageY: 300 }] } });
            clock += 80;
            r.props.onPanResponderMove({
                nativeEvent: {
                    locationX: 160,
                    locationY: 310,
                    touches: [{ pageX: 100, pageY: 300 }, { pageX: 260, pageY: 300 }],
                },
            });
        });
        expect(env.input.mock.calls.map(([arg]) => (arg as any).phase)).toEqual(['down', 'up']);

        // (b) Physical display + 'pointer' + zoom=1 -> pointer 'move' (NOT scroll)
        env.grant = { hostIdentity: 'mac-host', trackSid: 'track-p1', display: { ...physicalDisplay, width: 786, height: 1518 } };
        act(() => { renderer!.update(React.createElement(RemoteDesktopView)); });
        env.input.mockClear();
        act(() => {
            const r = getResponder();
            r.props.onPanResponderGrant({ nativeEvent: { locationX: 196.5, locationY: 379.5, touches: [{ pageX: 196.5, pageY: 379.5 }] } });
            clock += 80;
            r.props.onPanResponderMove({ nativeEvent: { locationX: 196.5, locationY: 430, touches: [{ pageX: 196.5, pageY: 430 }] } });
            r.props.onPanResponderRelease();
        });
        expect(env.input).toHaveBeenCalledTimes(1);
        expect(env.input.mock.calls[0]?.[0]).toMatchObject({ action: 'pointer', phase: 'move' });
    });

    it('UI-06: exposes desktop-windows-panel via dock and Controls menu, renders loading/empty/list states >=44pt, and fences actions during geometry gate', () => {
        env.window = { width: 393, height: 852 };
        env.insets = { top: 59, bottom: 34, left: 0, right: 0 };
        env.room = { id: 'room-v' };
        env.grant = { hostIdentity: 'mac-host', trackSid: 'track-v1', display: virtualDisplay };
        env.windowsLoading = true;
        env.windows = [];

        act(() => { renderer = create(React.createElement(RemoteDesktopView)); });
        const canvasInstance = renderer!.root.findByProps({ testID: 'remote-desktop-canvas' });

        // Open via dock button -> single panel open, auto-calls refreshWindows(), shows loading
        act(() => { renderer!.root.findByProps({ testID: 'desktop-windows' }).props.onPress(); });
        expect(env.refreshWindows).toHaveBeenCalledTimes(1);
        expect(hostViewsByTestID(renderer!.root, 'desktop-windows-panel')).toHaveLength(1);
        expect(hostViewsByTestID(renderer!.root, 'desktop-windows-loading')).toHaveLength(1);
        expect(renderer!.root.findByProps({ testID: 'remote-desktop-canvas' })).toBe(canvasInstance);

        // Empty state
        env.windowsLoading = false;
        act(() => { renderer!.update(React.createElement(RemoteDesktopView)); });
        expect(hostViewsByTestID(renderer!.root, 'desktop-windows-empty')).toHaveLength(1);

        // Switch to Controls panel -> obeys single-open-panel rule -> open via desktop-windows-menu
        act(() => { renderer!.root.findByProps({ testID: 'desktop-more' }).props.onPress(); });
        expect(hostViewsByTestID(renderer!.root, 'desktop-windows-panel')).toHaveLength(0);
        expect(hostViewsByTestID(renderer!.root, 'desktop-controls-panel')).toHaveLength(1);

        env.windows = [
            { id: '123:456', pid: 123, windowId: 456, appName: 'Xcode', bundleId: 'com.apple.dt.Xcode', title: 'CodelyncWorkspace', bounds: { x: 0, y: 0, width: 1200, height: 800 }, minimized: false, onVirtualDisplay: true },
            { id: '234:567', pid: 234, windowId: 567, appName: 'Terminal', bundleId: 'com.apple.Terminal', title: 'build', bounds: { x: 40, y: 40, width: 800, height: 600 }, minimized: true, onVirtualDisplay: false },
        ];
        env.activeWindowId = '123:456';
        act(() => { renderer!.update(React.createElement(RemoteDesktopView)); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-windows-menu' }).props.onPress(); });
        expect(hostViewsByTestID(renderer!.root, 'desktop-controls-panel')).toHaveLength(0);
        expect(hostViewsByTestID(renderer!.root, 'desktop-windows-panel')).toHaveLength(1);

        const row1 = renderer!.root.findByProps({ testID: 'desktop-window-123:456' });
        const row2 = renderer!.root.findByProps({ testID: 'desktop-window-234:567' });
        expect(resolveStyle(row1.props.style).minHeight).toBeGreaterThanOrEqual(44);
        expect(row1.props.accessibilityLabel).toContain('Xcode');
        expect(row1.props.accessibilityLabel).toContain('Filled');
        expect(row2.props.accessibilityLabel).toContain('Minimized');

        act(() => { row2.props.onPress(); });
        expect(env.fillWindow).toHaveBeenCalledWith('234:567');

        act(() => { renderer!.root.findByProps({ testID: 'desktop-windows-restore' }).props.onPress(); });
        expect(env.restoreWindow).toHaveBeenCalledTimes(1);

        act(() => { renderer!.root.findByProps({ testID: 'desktop-windows-refresh' }).props.onPress(); });
        expect(env.refreshWindows).toHaveBeenCalledTimes(3);

        // Geometry gate (!ready / busy) disables fill and restore buttons
        env.ready = false;
        env.busy = true;
        act(() => { renderer!.update(React.createElement(RemoteDesktopView)); });
        expect(renderer!.root.findByProps({ testID: 'desktop-window-123:456' }).props.disabled).toBe(true);
        expect(renderer!.root.findByProps({ testID: 'desktop-windows-restore' }).props.disabled).toBe(true);
        expect(renderer!.root.findByProps({ testID: 'desktop-windows-refresh' }).props.disabled).toBe(true);
    });

    it('UI-07: handles Android BackHandler in strict 4-step priority (keyboardOpen -> panel === windows -> immersive -> exit)', () => {
        env.platform = 'android';
        env.window = { width: 412, height: 915 };
        env.insets = { top: 28, bottom: 24, left: 0, right: 0 };
        env.room = { id: 'room-android' };
        env.grant = { hostIdentity: 'mac-host', trackSid: 'track-v1', display: virtualDisplay };

        act(() => { renderer = create(React.createElement(DesktopScreen)); });

        // Step 1: open keyboard -> Back closes keyboard without disconnecting
        act(() => { renderer!.root.findByProps({ testID: 'desktop-keyboard' }).props.onPress(); });
        expect(hostViewsByTestID(renderer!.root, 'desktop-control-dock')).toHaveLength(0);
        act(() => { expect(env.triggerHardwareBack()).toBe(true); });
        expect(hostViewsByTestID(renderer!.root, 'desktop-control-dock')).toHaveLength(1);
        expect(env.disconnect).not.toHaveBeenCalled();

        // Step 2: open panel === 'windows' -> Back closes panel without disconnecting
        act(() => { renderer!.root.findByProps({ testID: 'desktop-windows' }).props.onPress(); });
        expect(hostViewsByTestID(renderer!.root, 'desktop-windows-panel')).toHaveLength(1);
        act(() => { expect(env.triggerHardwareBack()).toBe(true); });
        expect(hostViewsByTestID(renderer!.root, 'desktop-windows-panel')).toHaveLength(0);
        expect(env.disconnect).not.toHaveBeenCalled();

        // Step 3: enter immersive fullscreen -> Back exits immersive without disconnecting
        act(() => { renderer!.root.findByProps({ testID: 'desktop-more' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-fullscreen' }).props.onPress(); });
        expect(hostViewsByTestID(renderer!.root, 'desktop-restore-controls')).toHaveLength(1);
        act(() => { expect(env.triggerHardwareBack()).toBe(true); });
        expect(hostViewsByTestID(renderer!.root, 'desktop-restore-controls')).toHaveLength(0);
        expect(hostViewsByTestID(renderer!.root, 'desktop-control-dock')).toHaveLength(1);
        expect(env.disconnect).not.toHaveBeenCalled();

        // Step 4: base view -> Back invokes exit(), detaches session, and restores portrait
        act(() => { expect(env.triggerHardwareBack()).toBe(true); });
        expect(env.disconnect).toHaveBeenCalledTimes(1);
        expect(env.routerBack).toHaveBeenCalledTimes(1);
        expect(renderer!.root.findByType('Screen').props.options).toMatchObject({
            orientation: 'portrait',
            statusBarHidden: false,
        });
    });

    it('UI-08: never synthesizes command-zoom keystrokes on connect, display switch, or fillWindow', () => {
        env.window = { width: 393, height: 852 };
        env.insets = { top: 59, bottom: 34, left: 0, right: 0 };
        env.windows = [
            { id: '123:456', pid: 123, windowId: 456, appName: 'Antigravity', bundleId: 'app.antigravity', title: 'Editor', bounds: { x: 0, y: 0, width: 1200, height: 800 }, minimized: false, onVirtualDisplay: false },
        ];

        act(() => { renderer = create(React.createElement(RemoteDesktopView)); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-choose-display' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-display-virtual' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-connect' }).props.onPress(); });

        env.room = { id: 'room-v' };
        env.grant = { hostIdentity: 'mac-host', trackSid: 'track-v1', display: virtualDisplay };
        act(() => { renderer!.update(React.createElement(RemoteDesktopView)); });

        act(() => { renderer!.root.findByProps({ testID: 'desktop-windows' }).props.onPress(); });
        act(() => { renderer!.root.findByProps({ testID: 'desktop-window-123:456' }).props.onPress(); });

        const zoomKeySent = env.input.mock.calls.some(([payload]) =>
            payload.action === 'key'
            && payload.modifiers.includes('command')
            && ['+', '=', '-'].includes(payload.key),
        );
        expect(zoomKeySent).toBe(false);
        expect(env.input).not.toHaveBeenCalled();
    });
});
