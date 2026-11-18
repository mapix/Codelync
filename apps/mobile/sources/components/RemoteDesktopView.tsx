import * as React from 'react';
import { ActivityIndicator, Keyboard, PanResponder, Platform, Pressable, ScrollView, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { RoomContext, VideoTrack, useTracks, isTrackReference } from '@livekit/react-native';
import { Track, RemoteVideoTrack } from 'livekit-client';
import { BlurView } from 'expo-blur';
import { RemoteDesktopKeyboard } from './RemoteDesktopKeyboard';
import { useRouter } from 'expo-router';
import { useRemoteDesktop } from '@/hooks/useRemoteDesktop';
import { desktopPoint, type DesktopInput } from '@/sync/remoteDesktop';
import { desktopViewportFocus, type DesktopViewport, type DesktopViewportCamera, type DesktopViewportTarget } from '@/sync/desktopViewportFocus';
import { remoteDesktopLabels, remoteDesktopError } from '@/text/remoteDesktopLabels';

type Controller = ReturnType<typeof useRemoteDesktop>;
type KeyboardCamera = { viewport: DesktopViewport; camera: DesktopViewportCamera; target: DesktopViewportTarget | null;
    display: DesktopViewport; displayId: string; geometry: string };

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
            if (Date.now() - initial.lastMove < 60) return; initial.lastMove = Date.now();
            if (mode === 'scroll') { send({ action: 'scroll', deltaY: Math.max(-1200, Math.min(1200, Math.round(y - initial.lastY))) }); initial.lastY = y; return; }
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

type Panel = 'controls' | 'display' | 'quality' | 'spaces' | 'status' | null;
type IconName = React.ComponentProps<typeof Ionicons>['name'];
const COLORS = { canvas: '#020406', glass: 'rgba(16,25,34,0.76)', foreground: '#E8EEF4', quiet: '#80929C', action: '#88C9E5', warning: '#F2B765' };

function Glass({ children, style, testID }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
    return <View testID={testID} style={[styles.glass, style]}>
        <BlurView intensity={32} tint="dark" pointerEvents="none" style={StyleSheet.absoluteFillObject} />
        <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: COLORS.glass }]} />
        {children}
    </View>;
}

export function RemoteDesktopView() {
    const controller = useRemoteDesktop(), labels = remoteDesktopLabels(), insets = useSafeAreaInsets(), window = useWindowDimensions(), router = useRouter();
    const [selected, setSelected] = React.useState(''), [zoom, setZoom] = React.useState(1), [offset, setOffset] = React.useState({ x: 0, y: 0 });
    const [mode, setMode] = React.useState<'pointer' | 'drag' | 'right' | 'scroll'>('pointer');
    const [panel, setPanel] = React.useState<Panel>(null), [keyboardOpen, setKeyboardOpen] = React.useState(false), [immersive, setImmersive] = React.useState(false);
    const [keyboardHeight, setKeyboardHeight] = React.useState(0), [exiting, setExiting] = React.useState(false);
    const exitFlight = React.useRef(false);
    const viewport = React.useRef<DesktopViewport | null>(null), target = React.useRef<DesktopViewportTarget | null>(null);
    const keyboardCamera = React.useRef<KeyboardCamera | null>(null), keyboardVisible = React.useRef(false);
    const connected = !!controller.grant && !!controller.room;
    const displayId = controller.grant?.display.id ?? (controller.displays.some(display => display.id === selected) ? selected : controller.displays[0]?.id);
    const inputEnabled = connected && controller.ready && controller.inputAllowed && controller.status?.permissions?.accessibility === true && !controller.busy && !exiting;
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
    const onTarget = React.useCallback((selected: DesktopViewportTarget) => { target.current = { ...selected }; }, []);
    const onViewport = React.useCallback((next: DesktopViewport) => {
        viewport.current = next;
        const prior = keyboardCamera.current, display = controller.grant?.display;
        if (!keyboardVisible.current || !prior || !display || display.id !== prior.displayId || display.geometry !== prior.geometry) return;
        const camera = desktopViewportFocus(prior.display, prior.viewport, next, prior.camera, prior.target);
        if (camera) { setZoom(camera.zoom); setOffset(camera.offset); }
    }, [controller.grant?.display.id, controller.grant?.display.geometry]);
    const openPanel = (next: NonNullable<Panel>) => { closeKeyboard(); setPanel(previous => previous === next ? null : next); };
    const openKeyboard = () => {
        setPanel(null); setImmersive(false);
        if (keyboardVisible.current) { closeKeyboard(); return; }
        const display = controller.grant?.display;
        keyboardCamera.current = viewport.current && display ? { viewport: { ...viewport.current }, camera: { zoom, offset: { ...offset } },
            target: target.current ? { ...target.current } : null, display: { width: display.width, height: display.height }, displayId: display.id, geometry: display.geometry } : null;
        keyboardVisible.current = true; setKeyboardOpen(true);
    };
    const exit = () => {
        if (exitFlight.current) return; exitFlight.current = true; setExiting(true); setPanel(null); closeKeyboard();
        // disconnect clears live input synchronously; weak-network leave cleanup
        // continues after navigation without keeping the user on this page.
        void controller.disconnect().catch(() => {});
        if (router.canGoBack()) router.back(); else router.replace('/');
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
        : panel === 'status' ? labels.connection : labels.controls;
    const compactLandscape = window.height < 460;
    const popoverWidth = Math.min(360, Math.max(1, window.width - insets.left - insets.right - 24));
    const popoverHeight = Math.max(1, window.height - insets.top - insets.bottom - 92);
    // Android's resize mode already reduces the window for the OS keyboard.
    const keyboardInset = keyboardOpen && Platform.OS !== 'android' ? Math.max(0, keyboardHeight) : 0;
    return <View testID="remote-desktop-page" style={[styles.root, { paddingBottom: keyboardInset }]}>
        <View testID="desktop-video-stage" style={styles.stage}>
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
                    {controller.displays.length > 1 ? button(controller.displays.find(display => display.id === displayId)?.name ?? labels.display, () => openPanel('display'), controller.busy, false, 'desktop-choose-display') : null}
                    {button(controller.closing ? labels.disconnecting : controller.busy ? labels.connecting : labels.connect,
                        () => { if (displayId) void controller.connect(displayId); }, !displayId || controller.busy || exiting, false, 'desktop-connect')}
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
                            {menuRow('desktop-outline', labels.display, () => setPanel('display'), controller.grant?.display.name, 'desktop-display-menu')}
                            {menuRow('options-outline', labels.settings, () => setPanel('quality'), `${controller.quality.width} · ${controller.quality.fps} fps`, 'desktop-settings')}
                            {menuRow('copy-outline', labels.desktops, () => setPanel('spaces'), undefined, 'desktop-spaces-menu')}
                            {menuRow('expand-outline', labels.fullscreen, () => { setPanel(null); setImmersive(true); }, undefined, 'desktop-fullscreen')}
                        </> : null}
                        {panel === 'display' ? <View style={styles.choices}>{controller.displays.map(display => button(display.name, () => {
                            if (controller.grant) void controller.switchDisplay(display.id); else setSelected(display.id);
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
                        {panel === 'status' ? <>
                            <Text accessibilityLiveRegion="polite" style={styles.statusDetail}>{connectionMessage}</Text>
                            {controller.grant ? <Text numberOfLines={2} style={styles.menuDetail}>{controller.grant.display.name}</Text> : null}
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
    keyboardContainer: { flexGrow: 0, backgroundColor: COLORS.canvas },
}));
