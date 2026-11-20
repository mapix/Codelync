import * as React from 'react';
import * as RN from 'react-native';
import { ActivityIndicator, Keyboard, PanResponder, Platform, Pressable, ScrollView, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as SafeAreaContext from 'react-native-safe-area-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { RoomContext, VideoTrack, useTracks, isTrackReference } from '@livekit/react-native';
import { Track, RemoteVideoTrack } from 'livekit-client';
import { BlurView } from 'expo-blur';
import { RemoteDesktopKeyboard } from './RemoteDesktopKeyboard';
import { useRouter } from 'expo-router';
import { useRemoteDesktop } from '@/hooks/useRemoteDesktop';
import * as RemoteDesktopSync from '@/sync/remoteDesktop';
import { desktopPoint, type DesktopDisplay, type DesktopInput } from '@/sync/remoteDesktop';
import { desktopViewportFocus, type DesktopViewport, type DesktopViewportCamera, type DesktopViewportTarget } from '@/sync/desktopViewportFocus';
import { remoteDesktopLabels, remoteDesktopError } from '@/text/remoteDesktopLabels';

type Controller = ReturnType<typeof useRemoteDesktop>;
type KeyboardCamera = { viewport: DesktopViewport; camera: DesktopViewportCamera; target: DesktopViewportTarget | null;
    display: DesktopViewport; displayId: string; geometry: string };

const backHandler = 'BackHandler' in RN ? RN.BackHandler : undefined;
const initialMetrics = 'initialWindowMetrics' in SafeAreaContext ? SafeAreaContext.initialWindowMetrics : null;
const resolveSafeViewport = 'resolvePortraitSafeViewport' in RemoteDesktopSync ? RemoteDesktopSync.resolvePortraitSafeViewport : undefined;

function isDisplayVirtual(display?: { id?: string; kind?: string } | null): boolean {
    return !!display && (display.kind === 'virtual' || display.id === 'virtual');
}

function DesktopCanvas({ controller, zoom, offset, setZoom, setOffset, mode, onViewport, onTarget }: {
    controller: Controller; zoom: number; offset: { x: number; y: number };
    setZoom: (zoom: number) => void; setOffset: (offset: { x: number; y: number }) => void;
    mode: 'pointer' | 'drag' | 'right' | 'scroll';
    onViewport: (viewport: DesktopViewport) => void; onTarget: (target: DesktopViewportTarget) => void;
}) {
    const tracks = useTracks([Track.Source.ScreenShare]), labels = remoteDesktopLabels();
    const reference = tracks.find(track => isTrackReference(track) && track.participant.identity === controller.grant?.hostIdentity);
    const track = reference && isTrackReference(reference) ? reference.publication.track : null;
    const [viewport, setViewport] = React.useState({ width: 1, height: 1 });
    const gesture = React.useRef({ zoom: 1, offset: { x: 0, y: 0 }, startX: 0, startY: 0, distance: 0, moved: false, dragged: false, validPoint: false, lastY: 0, point: { x: 0, y: 0 }, lastMove: 0 });
    React.useEffect(() => {
        if (!(track instanceof RemoteVideoTrack) || controller.ready) return;
        let cancelled = false, ready = false, pending = false;
        const check = async () => {
            if (pending || ready) return; pending = true;
            try {
                const stats = await track.getReceiverStats();
                if (!cancelled && (stats?.framesDecoded ?? 0) > 0 && reference && isTrackReference(reference)) ready = await controller.videoReady(reference.publication.trackSid);
            } catch { /* Detached receivers cannot confirm a fresh decoded picture. */
            } finally { pending = false; }
        };
        const timer = setInterval(() => { void check(); }, 500); void check();
        return () => { cancelled = true; clearInterval(timer); };
    }, [track, reference && isTrackReference(reference) ? reference.publication.trackSid : null, controller.videoReady, controller.grant?.trackSid, controller.ready]);
    const controlsEnabled = controller.ready && controller.inputAllowed && controller.status?.permissions?.accessibility === true && !controller.busy;
    const isVirtualDisplay = isDisplayVirtual(controller.grant?.display);
    const point = (x: number, y: number) => controller.grant ? desktopPoint(x, y, viewport, controller.grant.display, zoom, offset) : null;
    const send = (input: DesktopInput) => { if (controlsEnabled) void controller.input(input); };
    const responder = PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: event => {
            const { locationX: x, locationY: y, touches } = event.nativeEvent;
            const initial = gesture.current;
            initial.startX = x; initial.startY = y; initial.lastY = y; initial.zoom = zoom; initial.offset = offset; initial.moved = false; initial.dragged = false;
            initial.distance = touches.length >= 2 ? Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY) : 0;
            const target = point(x, y); initial.validPoint = !!target; if (target) initial.point = target;
            if (touches.length === 1 && mode === 'drag' && target && controlsEnabled) {
                initial.dragged = true; onTarget(target); send({ action: 'pointer', phase: 'down', ...target });
            }
        },
        onPanResponderMove: event => {
            const { locationX: x, locationY: y, touches } = event.nativeEvent, initial = gesture.current;
            if (Math.hypot(x - initial.startX, y - initial.startY) > 6) initial.moved = true;
            if (touches.length >= 2) {
                initial.moved = true;
                if (initial.dragged) { send({ action: 'pointer', phase: 'up', ...initial.point }); initial.dragged = false; }
                const distance = Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
                if (initial.distance === 0) { initial.distance = distance; initial.zoom = zoom; }
                setZoom(Math.min(4, Math.max(1, initial.zoom * distance / Math.max(1, initial.distance))));
                setOffset({ x: initial.offset.x + x - initial.startX, y: initial.offset.y + y - initial.startY }); return;
            }
            if (mode === 'pointer' && zoom > 1) { setOffset({ x: initial.offset.x + x - initial.startX, y: initial.offset.y + y - initial.startY }); return; }
            if (isVirtualDisplay && mode === 'pointer' && zoom === 1) {
                if (!initial.moved || !initial.validPoint) return;
                if (Date.now() - initial.lastMove < 60) return;
                const deltaY = Math.max(-1200, Math.min(1200, Math.round(y - initial.lastY)));
                if (deltaY === 0) return;
                initial.lastMove = Date.now(); initial.lastY = y;
                send({ action: 'scroll', deltaY, x: initial.point.x, y: initial.point.y }); return;
            }
            if (Date.now() - initial.lastMove < 60) return;
            if (mode === 'scroll') {
                const deltaY = Math.max(-1200, Math.min(1200, Math.round(y - initial.lastY)));
                if (deltaY === 0) return;
                initial.lastMove = Date.now(); initial.lastY = y;
                send(initial.validPoint ? { action: 'scroll', deltaY, x: initial.point.x, y: initial.point.y } : { action: 'scroll', deltaY });
                return;
            }
            initial.lastMove = Date.now();
            const target = point(x, y); if (target) { initial.point = target; send({ action: 'pointer', phase: 'move', ...target }); }
        },
        onPanResponderRelease: () => {
            const initial = gesture.current;
            if (initial.dragged) send({ action: 'pointer', phase: 'up', ...initial.point });
            else if (initial.validPoint && !initial.moved && mode !== 'scroll' && controlsEnabled) {
                onTarget(initial.point); send({ action: 'pointer', phase: 'click', ...initial.point, button: mode === 'right' ? 'right' : 'left' });
            }
        },
        onPanResponderTerminate: () => { if (gesture.current.dragged) send({ action: 'pointer', phase: 'up', ...gesture.current.point }); },
    });
    return <View testID="remote-desktop-canvas" style={styles.canvas} onLayout={event => {
        const next = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height };
        setViewport(next); onViewport(next);
    }}>
        {reference && isTrackReference(reference) ? <View style={[styles.video, { transform: [{ translateX: offset.x }, { translateY: offset.y }, { scale: zoom }] }]}>
            <VideoTrack trackRef={reference} objectFit="contain" style={{ width: viewport.width, height: viewport.height, backgroundColor: 'black' }} />
        </View> : <View style={styles.waiting}><ActivityIndicator /><Text style={styles.secondary}>{labels.waiting}</Text></View>}
        <View style={StyleSheet.absoluteFillObject} {...responder.panHandlers} accessibilityLabel={labels.title} />
    </View>;
}

type Panel = 'controls' | 'display' | 'quality' | 'spaces' | 'windows' | 'status' | null;
type IconName = React.ComponentProps<typeof Ionicons>['name'];
const COLORS = { canvas: '#020406', glass: 'rgba(16,25,34,0.76)', foreground: '#E8EEF4', quiet: '#80929C', action: '#88C9E5', warning: '#F2B765' };

function Glass({ children, style, testID }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
    return <View testID={testID} style={[styles.glass, style]}>
        <BlurView intensity={32} tint="dark" pointerEvents="none" style={StyleSheet.absoluteFillObject} />
        <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: COLORS.glass }]} />
        {children}
    </View>;
}

export type RemoteDesktopViewProps = {
    focused?: boolean;
    onOrientationModeChange?: (mode: 'portrait' | 'landscape') => void;
};

export function RemoteDesktopView({ focused = true, onOrientationModeChange }: RemoteDesktopViewProps = {}) {
    const controller = useRemoteDesktop(), labels = remoteDesktopLabels(), insets = useSafeAreaInsets(), window = useWindowDimensions(), router = useRouter();
    const [selected, setSelected] = React.useState(''), [zoom, setZoom] = React.useState(1), [offset, setOffset] = React.useState({ x: 0, y: 0 });
    const [mode, setMode] = React.useState<'pointer' | 'drag' | 'right' | 'scroll'>('pointer');
    const [panel, setPanel] = React.useState<Panel>(null), [keyboardOpen, setKeyboardOpen] = React.useState(false), [immersive, setImmersive] = React.useState(false);
    const [keyboardHeight, setKeyboardHeight] = React.useState(0), [exiting, setExiting] = React.useState(false);
    const exitFlight = React.useRef(false);
    const viewport = React.useRef<DesktopViewport | null>(null), target = React.useRef<DesktopViewportTarget | null>(null);
    const keyboardCamera = React.useRef<KeyboardCamera | null>(null), keyboardVisible = React.useRef(false);
    const cachedPortrait = React.useRef<DesktopViewport | null>(null);
    const connected = !!controller.grant && !!controller.room;
    const displayId = controller.grant?.display.id
        ?? (controller.displays.some(display => display.id === selected) ? selected
            : controller.selectedDisplayId && controller.displays.some(display => display.id === controller.selectedDisplayId) ? controller.selectedDisplayId
                : controller.displays[0]?.id);
    const currentDisplay = controller.grant?.display ?? controller.displays.find(display => display.id === displayId) ?? null;
    const isVirtualDisplay = controller.grant ? isDisplayVirtual(controller.grant.display) : (isDisplayVirtual(currentDisplay) || Boolean(controller.isVirtualDisplay && !currentDisplay));
    const connectedVirtual = connected && isDisplayVirtual(controller.grant?.display);
    const inputEnabled = connected && controller.ready && controller.inputAllowed && controller.status?.permissions?.accessibility === true && !controller.busy && !exiting;
    const windows = controller.windows ?? [];
    const windowsLoading = controller.windowsLoading ?? false;
    const activeWindowId = controller.activeWindowId ?? null;
    const displayName = (display?: Pick<DesktopDisplay, 'id' | 'name' | 'kind'> | null) => !display ? labels.display : isDisplayVirtual(display) ? labels.phoneScreen : display.name;

    React.useEffect(() => {
        if (!keyboardOpen && keyboardHeight <= 0 && window.height > window.width) {
            const rawW = Math.max(1, window.width - Math.max(0, insets.left) - Math.max(0, insets.right));
            const rawH = Math.max(1, window.height - Math.max(0, insets.top) - Math.max(0, insets.bottom));
            const width = Math.min(10_000, Math.max(100, Math.round(rawW)));
            const height = Math.min(10_000, Math.max(width, Math.round(rawH)));
            cachedPortrait.current = { width, height };
        }
    }, [window.width, window.height, insets.top, insets.bottom, insets.left, insets.right, keyboardOpen, keyboardHeight]);

    React.useEffect(() => {
        if (!exiting) onOrientationModeChange?.(isVirtualDisplay ? 'portrait' : 'landscape');
    }, [isVirtualDisplay, exiting, onOrientationModeChange]);

    const refreshWindows = controller.refreshWindows;
    React.useEffect(() => {
        if (panel === 'windows' && !connectedVirtual) { setPanel(null); return; }
        if (panel === 'windows' && connectedVirtual) void refreshWindows?.();
    }, [panel, connectedVirtual, refreshWindows]);

    React.useEffect(() => {
        target.current = null; keyboardCamera.current = null;
        setZoom(1); setOffset({ x: 0, y: 0 }); setMode('pointer');
    }, [controller.grant?.display.id, controller.grant?.display.geometry]);
    React.useEffect(() => {
        if (!connected) {
            keyboardVisible.current = false; keyboardCamera.current = null; target.current = null; viewport.current = null;
            Keyboard.dismiss(); setImmersive(false); setKeyboardOpen(false); setKeyboardHeight(0);
        }
    }, [connected]);
    const closeKeyboard = React.useCallback(() => {
        keyboardVisible.current = false; Keyboard.dismiss(); setKeyboardOpen(false);
        const prior = keyboardCamera.current; keyboardCamera.current = null;
        if (prior) { setZoom(prior.camera.zoom); setOffset(prior.camera.offset); }
    }, []);
    const resolveVirtualViewport = React.useCallback((): DesktopViewport => {
        const isPad = Platform.OS === 'ios' && Boolean((Platform as { isPad?: boolean }).isPad);
        if (resolveSafeViewport) {
            return resolveSafeViewport({
                window,
                insets,
                keyboardHeight,
                cachedPortrait: cachedPortrait.current,
                initialMetrics,
                platformOS: Platform.OS,
                isPad,
            });
        }
        if (cachedPortrait.current) return cachedPortrait.current;
        const portraitWidth = Math.min(window.width, window.height);
        const portraitHeight = Math.max(window.width, window.height);
        const portraitTop = Math.max(0, insets.top, insets.left, insets.right);
        const portraitBottom = Platform.OS === 'ios' && !isPad && insets.bottom > 0 ? 34 : Math.max(0, insets.bottom);
        const width = Math.min(10_000, Math.max(100, Math.round(portraitWidth)));
        const height = Math.min(10_000, Math.max(width, Math.round(portraitHeight - portraitTop - portraitBottom)));
        return { width, height };
    }, [window, insets, keyboardHeight]);
    const onTarget = React.useCallback((selectedTarget: DesktopViewportTarget) => { target.current = { ...selectedTarget }; }, []);
    const onViewport = React.useCallback((next: DesktopViewport) => {
        viewport.current = next;
        const prior = keyboardCamera.current, display = controller.grant?.display;
        if (!keyboardVisible.current || !prior || !display || display.id !== prior.displayId || display.geometry !== prior.geometry) return;
        const camera = desktopViewportFocus({ width: display.width, height: display.height }, prior.viewport, next, prior.camera, prior.target);
        if (camera) { setZoom(camera.zoom); setOffset(camera.offset); }
    }, [controller.grant?.display.id, controller.grant?.display.geometry, controller.grant?.display.width, controller.grant?.display.height]);
    const openPanel = (next: NonNullable<Panel>) => { closeKeyboard(); setPanel(previous => previous === next ? null : next); };
    const openKeyboard = () => {
        setPanel(null); setImmersive(false);
        if (keyboardVisible.current) { closeKeyboard(); return; }
        const display = controller.grant?.display;
        keyboardCamera.current = viewport.current && display ? { viewport: { ...viewport.current }, camera: { zoom, offset: { ...offset } },
            target: target.current ? { ...target.current } : null, display: { width: display.width, height: display.height }, displayId: display.id, geometry: display.geometry } : null;
        keyboardVisible.current = true; setKeyboardOpen(true);
    };
    const exit = React.useCallback(() => {
        if (exitFlight.current) return; exitFlight.current = true; setExiting(true); setPanel(null); closeKeyboard();
        onOrientationModeChange?.('portrait');
        // disconnect clears live input synchronously; weak-network leave cleanup
        // continues after navigation without keeping the user on this page.
        void controller.disconnect().catch(() => {});
        if (router.canGoBack()) router.back(); else router.replace('/');
    }, [closeKeyboard, controller, onOrientationModeChange, router]);

    React.useEffect(() => {
        if (!focused || Platform.OS !== 'android' || !backHandler?.addEventListener) return;
        const sub = backHandler.addEventListener('hardwareBackPress', () => {
            if (keyboardVisible.current || keyboardOpen) { closeKeyboard(); return true; }
            if (panel !== null) { setPanel(null); return true; }
            if (immersive) { setImmersive(false); return true; }
            exit();
            return true;
        });
        return () => sub.remove();
    }, [focused, keyboardOpen, panel, immersive, closeKeyboard, exit]);

    const selectDisplay = (id: string) => {
        setSelected(id);
        controller.selectDisplay?.(id);
    };
    const button = (title: string, action: () => void, disabled = false, active = false, testID?: string) => <Pressable key={testID ?? title} testID={testID}
        accessibilityRole="button" accessibilityState={{ disabled, selected: active }} disabled={disabled} onPress={action}
        style={({ pressed }) => [styles.button, active && styles.selected, pressed && styles.pressed, disabled && styles.disabled]}>
        <Text style={[styles.buttonText, active && styles.selectedText]}>{title}</Text></Pressable>;
    const icon = (name: IconName, title: string, action: () => void, testID: string, disabled = false, active = false) => <Pressable key={testID} testID={testID}
        accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled, selected: active }} disabled={disabled} onPress={action}
        style={({ pressed }) => [styles.iconButton, active && styles.selected, pressed && styles.pressed, disabled && styles.disabled]}>
        <Ionicons name={name} size={21} color={active ? COLORS.action : COLORS.foreground} /></Pressable>;
    const menuRow = (name: IconName, title: string, action: () => void, detail?: string, testID?: string) => <Pressable testID={testID}
        accessibilityRole="button" accessibilityLabel={detail ? `${title}: ${detail}` : title} onPress={action} style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}>
        <Ionicons name={name} size={19} color={COLORS.quiet} /><Text numberOfLines={1} style={styles.menuText}>{title}</Text>
        {detail ? <Text numberOfLines={1} style={styles.menuDetail}>{detail}</Text> : null}<Ionicons name="chevron-forward" size={16} color={COLORS.quiet} />
    </Pressable>;
    const emptyMessage = controller.status?.enabled === false ? labels.disabled : controller.status?.permissions?.screenRecording === false ? labels.permission
        : controller.status?.permissions?.locked ? labels.locked : controller.error ? remoteDesktopError(controller.error)
            : !controller.status ? labels.checking : labels.notConnected;
    const connectionMessage = controller.error ? remoteDesktopError(controller.error) : controller.notice ? remoteDesktopError(controller.notice)
        : controller.closing ? labels.disconnecting : controller.busy ? labels.connecting : !connected ? emptyMessage
            : !controller.inputAllowed ? labels.preferredRoute : !controller.ready ? labels.waiting : controller.status?.permissions?.accessibility === false ? labels.inputPermission
                : controller.status?.permissions?.accessibility !== true ? labels.inputChecking : labels.connected;
    const warning = !!controller.error || !!controller.notice || !inputEnabled;
    const panelTitle = panel === 'display' ? labels.display : panel === 'quality' ? labels.settings : panel === 'spaces' ? labels.desktops
        : panel === 'windows' ? labels.windows : panel === 'status' ? labels.connection : labels.controls;
    const compactLandscape = window.height < 460;
    const popoverWidth = Math.min(360, Math.max(1, window.width - insets.left - insets.right - 24));
    const popoverHeight = Math.max(1, window.height - insets.top - insets.bottom - 92);
    // Edge-to-edge KeyboardProvider requires explicit IME inset on both iOS and Android.
    const keyboardInset = keyboardOpen ? Math.max(0, keyboardHeight) : 0;
    return <View testID="remote-desktop-page" style={[styles.root, { paddingBottom: keyboardInset }]}>
        <View testID="desktop-video-stage" style={[styles.stage, connectedVirtual && { paddingTop: insets.top, paddingBottom: keyboardOpen ? 0 : insets.bottom }]}>
            {connected && controller.room ? <RoomContext.Provider value={controller.room}>
                <DesktopCanvas controller={controller} zoom={zoom} offset={offset} setZoom={setZoom} setOffset={setOffset} mode={mode}
                    onViewport={onViewport} onTarget={onTarget} />
            </RoomContext.Provider> : <ScrollView testID="desktop-empty-stage" bounces={false} showsVerticalScrollIndicator={false}
                contentContainerStyle={[styles.empty, compactLandscape && styles.emptyCompact, {
                    paddingTop: insets.top + (compactLandscape ? 12 : 0),
                    paddingBottom: Math.max(insets.bottom + 76, compactLandscape ? 76 : 84),
                    paddingLeft: insets.left + 24, paddingRight: insets.right + 24 }]}>
                <Ionicons name="desktop-outline" size={38} color={COLORS.quiet} />
                <Text accessibilityLiveRegion="polite" style={styles.emptyMessage}>{emptyMessage}</Text>
                {controller.status?.enabled && !controller.status.permissions?.locked && controller.status.permissions?.screenRecording !== false ? <>
                    {controller.displays.length > 1 ? button(displayName(controller.displays.find(display => display.id === displayId)), () => openPanel('display'), controller.busy, false, 'desktop-choose-display')
                        : isVirtualDisplay && currentDisplay ? <Text testID="desktop-single-display-label" style={styles.secondary}>{displayName(currentDisplay)}</Text> : null}
                    {button(controller.closing ? labels.disconnecting : controller.busy ? labels.connecting : labels.connect,
                        () => {
                            if (!displayId) return;
                            const targetDisplay = controller.displays.find(display => display.id === displayId);
                            if (displayId === 'virtual' || isDisplayVirtual(targetDisplay)) void controller.connect(displayId, resolveVirtualViewport());
                            else void controller.connect(displayId);
                        }, !displayId || controller.busy || exiting, false, 'desktop-connect')}
                </> : button(labels.refresh, () => { void controller.refresh(); }, controller.busy, false, 'desktop-refresh')}
            </ScrollView>}
            <View pointerEvents="box-none" style={StyleSheet.absoluteFillObject}>
                {panel && !keyboardOpen && !immersive ? <Glass testID={`desktop-${panel}-panel`} style={[styles.popover, { width: popoverWidth, maxHeight: popoverHeight,
                    right: insets.right + 12, top: insets.top + 12 }]}>
                    <View style={[styles.panelHeader, compactLandscape && styles.panelHeaderCompact]}>
                        {panel !== 'controls' ? icon('chevron-back', labels.back, () => setPanel('controls'), 'desktop-panel-back') : null}
                        <Text numberOfLines={1} style={styles.panelTitle}>{panelTitle}</Text>
                        {icon('close-outline', labels.close, () => setPanel(null), 'desktop-panel-close')}
                    </View>
                    <ScrollView style={styles.panelScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
                        contentContainerStyle={[styles.panelContent, compactLandscape && styles.panelContentCompact]}>
                        {panel === 'controls' ? <>
                            <View style={styles.modeRow}>
                                {icon('navigate-outline', labels.pointer, () => setMode('pointer'), 'desktop-pointer', !inputEnabled, mode === 'pointer')}
                                {icon('hand-left-outline', labels.drag, () => setMode(mode === 'drag' ? 'pointer' : 'drag'), 'desktop-drag', !inputEnabled, mode === 'drag')}
                                {icon('return-up-back-outline', labels.rightClick, () => setMode(mode === 'right' ? 'pointer' : 'right'), 'desktop-right-click', !inputEnabled, mode === 'right')}
                                {icon('swap-vertical-outline', labels.scroll, () => setMode(mode === 'scroll' ? 'pointer' : 'scroll'), 'desktop-scroll', !inputEnabled, mode === 'scroll')}
                            </View>
                            <View style={styles.zoomRow}>{button(labels.fit, () => { setZoom(1); setOffset({ x: 0, y: 0 }); }, false, false, 'desktop-fit')}
                                {icon('remove-outline', labels.zoomOut, () => setZoom(Math.max(1, zoom - .5)), 'desktop-zoom-out', zoom <= 1)}
                                <Text accessibilityLabel={labels.zoom} style={styles.utility}>{Math.round(zoom * 100)}%</Text>
                                {icon('add-outline', labels.zoomIn, () => setZoom(Math.min(4, zoom + .5)), 'desktop-zoom-in', zoom >= 4)}</View>
                            {menuRow('desktop-outline', labels.display, () => setPanel('display'), controller.grant ? displayName(controller.grant.display) : undefined, 'desktop-display-menu')}
                            {connectedVirtual ? menuRow('browsers-outline', labels.windows, () => setPanel('windows'), undefined, 'desktop-windows-menu') : null}
                            {menuRow('options-outline', labels.settings, () => setPanel('quality'), `${controller.quality.width} · ${controller.quality.fps} fps`, 'desktop-settings')}
                            {menuRow('copy-outline', labels.desktops, () => setPanel('spaces'), undefined, 'desktop-spaces-menu')}
                            {menuRow('expand-outline', labels.fullscreen, () => { setPanel(null); setImmersive(true); }, undefined, 'desktop-fullscreen')}
                        </> : null}
                        {panel === 'display' ? <View style={styles.choices}>{controller.displays.map(display => button(displayName(display), () => {
                            if (controller.grant) {
                                if (isDisplayVirtual(display)) void controller.switchDisplay(display.id, resolveVirtualViewport());
                                else void controller.switchDisplay(display.id);
                            } else {
                                selectDisplay(display.id);
                            }
                        }, controller.busy, displayId === display.id, `desktop-display-${display.id}`))}</View> : null}
                        {panel === 'quality' ? <>
                            <Text style={styles.sectionTitle}>{labels.clarity}</Text><View style={styles.choices}>{([1280, 1920, 2560] as const).map((width, index) =>
                                button([labels.standard, labels.high, labels.ultra][index], () => { void controller.changeQuality({ ...controller.quality, width }); }, controller.busy, controller.quality.width === width, `desktop-clarity-${width}`))}</View>
                            <Text style={styles.sectionTitle}>{labels.smoothness}</Text><View style={styles.choices}>{([15, 30, 60] as const).map(fps =>
                                button(`${fps} fps`, () => { void controller.changeQuality({ ...controller.quality, fps }); }, controller.busy, controller.quality.fps === fps, `desktop-fps-${fps}`))}</View>
                        </> : null}
                        {panel === 'spaces' ? <View style={styles.choices}>
                            {button(labels.previousDesktop, () => { void controller.navigateSpace('previous'); }, !inputEnabled, false, 'desktop-space-previous')}
                            {button(labels.nextDesktop, () => { void controller.navigateSpace('next'); }, !inputEnabled, false, 'desktop-space-next')}
                            {button(labels.overview, () => { void controller.navigateSpace('overview'); }, !inputEnabled, false, 'desktop-space-overview')}
                        </View> : null}
                        {panel === 'windows' ? <>
                            <View style={styles.choices}>
                                {button(labels.refresh, () => { void controller.refreshWindows?.(); }, controller.busy || windowsLoading, false, 'desktop-windows-refresh')}
                                {button(labels.restoreWindows, () => { void controller.restoreWindow?.(); }, !inputEnabled || windowsLoading, false, 'desktop-windows-restore')}
                            </View>
                            {windowsLoading && windows.length === 0 ? <View testID="desktop-windows-loading" style={styles.windowStatus}>
                                <ActivityIndicator size="small" color={COLORS.action} />
                                <Text style={styles.secondary}>{labels.windowsLoading}</Text>
                            </View> : windows.length === 0 ? <Text testID="desktop-windows-empty" style={styles.secondary}>{labels.windowsEmpty}</Text> : windows.map(item => {
                                const isActive = activeWindowId === item.id || item.onVirtualDisplay;
                                const rowTitle = item.title.trim() || labels.untitledWindow;
                                const badges = [isActive ? labels.windowOnPhone : null, item.minimized ? labels.windowMinimized : null].filter(Boolean).join(' · ');
                                const rowDisabled = !inputEnabled || windowsLoading;
                                return <Pressable key={item.id} testID={`desktop-window-${item.id}`} accessibilityRole="button"
                                    accessibilityLabel={[item.appName, rowTitle, badges].filter(Boolean).join(', ')}
                                    accessibilityState={{ disabled: rowDisabled, selected: isActive }}
                                    disabled={rowDisabled} onPress={() => { void controller.fillWindow?.(item.id); }}
                                    style={({ pressed }) => [styles.windowRow, isActive && styles.selected, pressed && styles.pressed, rowDisabled && styles.disabled]}>
                                    <View style={styles.windowTextColumn}>
                                        <Text numberOfLines={1} style={[styles.buttonText, isActive && styles.selectedText]}>{item.appName}</Text>
                                        <Text numberOfLines={1} style={styles.windowSubtitle}>{rowTitle}</Text>
                                    </View>
                                    {badges ? <Text numberOfLines={1} style={[styles.windowBadge, isActive && styles.selectedText]}>{badges}</Text> : null}
                                </Pressable>;
                            })}
                        </> : null}
                        {panel === 'status' ? <>
                            <Text accessibilityLiveRegion="polite" style={styles.statusDetail}>{connectionMessage}</Text>
                            {controller.grant ? <Text numberOfLines={2} style={styles.menuDetail}>{displayName(controller.grant.display)}</Text> : null}
                            {button(labels.refresh, () => { void controller.refresh(); }, controller.busy, false, 'desktop-details-refresh')}
                            {button(labels.exit, () => { void exit(); }, exiting, false, 'desktop-disconnect')}
                        </> : null}
                    </ScrollView>
                </Glass> : null}
                {immersive ? <Glass testID="desktop-restore-controls" style={[styles.restore, { right: insets.right + 12, bottom: insets.bottom + 12 }]}>
                    {icon('ellipsis-horizontal', labels.showControls, () => setImmersive(false), 'desktop-exit-fullscreen')}
                </Glass> : !keyboardOpen ? <Glass testID="desktop-control-dock" style={[styles.dock, { bottom: insets.bottom + 12,
                    alignSelf: 'center', maxWidth: window.width - insets.left - insets.right - 24 }]}>
                    {icon('close-outline', labels.exit, () => { void exit(); }, 'desktop-exit', exiting)}
                    <Pressable testID="desktop-connection-indicator" accessibilityRole="button" accessibilityLabel={`${labels.connection}: ${connectionMessage}`}
                        accessibilityState={{ expanded: panel === 'status', busy: controller.busy, disabled: exiting }} disabled={exiting}
                        onPress={() => openPanel('status')} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed, exiting && styles.disabled]}>
                        {controller.busy ? <ActivityIndicator size="small" color={COLORS.warning} /> : <Ionicons name={warning ? 'alert-circle-outline' : 'radio-button-on'} size={20} color={warning ? COLORS.warning : COLORS.action} />}
                    </Pressable>
                    {connectedVirtual ? icon('browsers-outline', labels.windows, () => openPanel('windows'), 'desktop-windows', exiting, panel === 'windows') : null}
                    {icon('keypad-outline', labels.keyboard, openKeyboard, 'desktop-keyboard', !connected, keyboardOpen)}
                    {icon('ellipsis-horizontal', labels.controls, () => openPanel('controls'), 'desktop-more', false, panel === 'controls')}
                </Glass> : null}
            </View>
        </View>
        <View style={[styles.keyboardContainer, { paddingLeft: insets.left + 8, paddingRight: insets.right + 8,
            paddingBottom: keyboardOpen ? (keyboardHeight > 0 ? 8 : insets.bottom + 8) : 0 }]}>
            <RemoteDesktopKeyboard visible={keyboardOpen} enabled={inputEnabled} hint={inputEnabled ? undefined : connectionMessage}
                onInput={controller.input} onClose={closeKeyboard} onKeyboardHeight={setKeyboardHeight} />
        </View>
    </View>;
}

const styles = StyleSheet.create(() => ({
    root: { flex: 1, backgroundColor: COLORS.canvas }, stage: { flex: 1, minHeight: 1, backgroundColor: COLORS.canvas },
    canvas: { flex: 1, overflow: 'hidden', backgroundColor: COLORS.canvas }, video: { flex: 1 },
    waiting: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }, secondary: { color: COLORS.quiet, fontSize: 13 },
    empty: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingBottom: 72 }, emptyCompact: { gap: 10 }, emptyMessage: { color: COLORS.quiet, fontSize: 14, textAlign: 'center', maxWidth: 440 },
    glass: { borderRadius: 18, borderWidth: 1, borderColor: 'rgba(232,238,244,0.14)', overflow: 'hidden' },
    dock: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 4, padding: 5 }, restore: { position: 'absolute', padding: 4 },
    iconButton: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    button: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, justifyContent: 'center', backgroundColor: 'rgba(232,238,244,0.07)' },
    buttonText: { color: COLORS.foreground, fontSize: 14, fontWeight: '500' }, selected: { backgroundColor: 'rgba(136,201,229,0.17)' }, selectedText: { color: COLORS.action }, pressed: { opacity: .65 }, disabled: { opacity: .35 },
    popover: { position: 'absolute' }, panelHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, minHeight: 52, flexShrink: 0, borderBottomWidth: 1, borderBottomColor: 'rgba(232,238,244,0.09)' }, panelHeaderCompact: { minHeight: 46 },
    panelTitle: { flex: 1, paddingHorizontal: 10, color: COLORS.foreground, fontSize: 15, fontWeight: '600' }, panelContent: { padding: 12, gap: 10 }, panelContentCompact: { padding: 10, gap: 6 },
    panelScroll: { flexShrink: 1 },
    modeRow: { flexDirection: 'row', justifyContent: 'space-around', gap: 6 }, zoomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 4 },
    utility: { color: COLORS.quiet, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', minWidth: 42, textAlign: 'center' },
    menuRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 }, menuText: { color: COLORS.foreground, fontSize: 14, flexShrink: 1 }, menuDetail: { flex: 1, color: COLORS.quiet, fontSize: 12, textAlign: 'right' },
    sectionTitle: { color: COLORS.quiet, fontSize: 12, marginTop: 4 }, choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, statusDetail: { color: COLORS.foreground, fontSize: 14, lineHeight: 20 },
    windowStatus: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
    windowRow: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, backgroundColor: 'rgba(232,238,244,0.07)' },
    windowTextColumn: { flex: 1, gap: 2 },
    windowSubtitle: { color: COLORS.quiet, fontSize: 12 },
    windowBadge: { color: COLORS.quiet, fontSize: 11, fontWeight: '600', flexShrink: 0 },
    keyboardContainer: { flexGrow: 0, backgroundColor: COLORS.canvas },
}));
