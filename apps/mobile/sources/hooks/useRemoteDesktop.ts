import * as React from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Room, RoomEvent, setLogLevel } from 'livekit-client';
import { registerGlobals, RNKeyProvider, RNE2EEManager } from '@livekit/react-native';
import { TokenStorage } from '@/auth/tokenStorage';
import { getConnectionSnapshot, subscribeConnection } from '@/sync/codelyncConnection';
import { desktopRequest, desktopBinding, DesktopRequestError, type DesktopStatus, type DesktopDisplay, type DesktopDisplaysResponse, type DesktopGrant, type DesktopInput, type DesktopQuality, type DesktopView, type DesktopSpaceAction, type DesktopViewport, type DesktopWindowItem, type DesktopWindowsResponse, type DesktopWindowActionResponse, type DesktopPermissions } from '@/sync/remoteDesktop';
import { DesktopInputQueue, DesktopInputQueueError, desktopInputAcknowledged } from '@/sync/desktopInputQueue';

type ActiveDesktop = { grant: DesktopGrant; room: Room; keyProvider: RNKeyProvider; peer: string; sequence: number };
type AdoptableDesktopView = {
    geometry?: string;
    trackSid: string;
    viewPending?: boolean;
    permissions?: DesktopPermissions;
    display?: DesktopDisplay;
    activeWindowId?: string | null;
};

function isVirtualDisplayItem(display?: Pick<DesktopDisplay, 'id' | 'kind'> | null): boolean {
    return !!display && (display.kind === 'virtual' || display.id === 'virtual');
}

function sameDesktopDisplay(a: DesktopDisplay, b: DesktopDisplay): boolean {
    return a.id === b.id
        && a.name === b.name
        && a.kind === b.kind
        && a.width === b.width
        && a.height === b.height
        && a.logicalWidth === b.logicalWidth
        && a.logicalHeight === b.logicalHeight
        && a.geometry === b.geometry;
}

export function useRemoteDesktop() {
    const focused = useIsFocused(), connection = React.useSyncExternalStore(subscribeConnection, getConnectionSnapshot);
    const [status, setStatus] = React.useState<DesktopStatus | null>(null), [displays, setDisplays] = React.useState<DesktopDisplay[]>([]);
    const [selectedDisplayIdState, setSelectedDisplayId] = React.useState('');
    const [virtualDisplaySupported, setVirtualDisplaySupported] = React.useState(false);
    const [grant, setGrant] = React.useState<DesktopGrant | null>(null), [room, setRoom] = React.useState<Room | null>(null);
    const [busy, setBusy] = React.useState(false), [closing, setClosing] = React.useState(false), [ready, setReady] = React.useState(false), [error, setError] = React.useState<string | null>(null);
    const [quality, setQuality] = React.useState<DesktopQuality>({ width: 1920, fps: 30 });
    const [notice, setNotice] = React.useState<string | null>(null);
    const [windows, setWindows] = React.useState<DesktopWindowItem[]>([]);
    const [activeWindowId, setActiveWindowId] = React.useState<string | null>(null);
    const [windowsLoading, setWindowsLoading] = React.useState(false);
    const live = React.useRef<ActiveDesktop | null>(null);
    const epoch = React.useRef(0), windowsEpoch = React.useRef(0), requestPending = React.useRef(false), inputQueue = React.useRef<DesktopInputQueue | null>(null);
    const errorCode = (failure: unknown) => failure instanceof DesktopRequestError || failure instanceof DesktopInputQueueError ? failure.code : 'desktop-media-connect-failed';

    const resetWindowState = React.useCallback(() => {
        ++windowsEpoch.current;
        setWindows([]);
        setActiveWindowId(null);
        setWindowsLoading(false);
    }, []);

    const disconnect = React.useCallback(async () => {
        ++epoch.current; const prior = live.current; live.current = null;
        inputQueue.current?.close(); inputQueue.current = null;
        resetWindowState();
        setReady(false); setGrant(null); setRoom(null); setBusy(!!prior); setClosing(!!prior); requestPending.current = !!prior;
        if (prior) {
            await Promise.allSettled([prior.room.disconnect(), desktopRequest('leave', desktopBinding(prior.grant), prior.peer)]);
            prior.keyProvider.dispose();
        }
        setBusy(false); setClosing(false); requestPending.current = false;
    }, [resetWindowState]);
    const adoptView = React.useCallback((active: ActiveDesktop, result: AdoptableDesktopView) => {
        if (live.current !== active) return;
        const nextGeometry = result.geometry ?? result.display?.geometry ?? active.grant.display.geometry;
        const nextDisplay: DesktopDisplay = result.display
            ? { ...result.display, geometry: nextGeometry }
            : { ...active.grant.display, geometry: nextGeometry };
        const viewInvalidated = nextGeometry !== active.grant.display.geometry
            || result.trackSid !== active.grant.trackSid
            || Boolean(result.viewPending)
            || nextDisplay.id !== active.grant.display.id;
        const displayChanged = !sameDesktopDisplay(active.grant.display, nextDisplay);
        if (viewInvalidated) {
            inputQueue.current?.close();
            inputQueue.current = null;
            setReady(false);
        }
        if (viewInvalidated || displayChanged) {
            active.grant = { ...active.grant, trackSid: result.trackSid, display: nextDisplay };
            setGrant(active.grant);
        }
        if (result.permissions) {
            const nextPermissions = result.permissions;
            setStatus(previous => previous ? { ...previous, permissions: nextPermissions } : previous);
        }
        if (!isVirtualDisplayItem(nextDisplay)) {
            resetWindowState();
        } else if (result.activeWindowId !== undefined) {
            setActiveWindowId(result.activeWindowId);
        }
    }, [resetWindowState]);
    const recoverView = React.useCallback(async () => {
        const active = live.current; if (!active) return;
        try {
            const result = await desktopRequest<DesktopView>('heartbeat', desktopBinding(active.grant), active.peer);
            if (live.current === active) adoptView(active, result);
        } catch (failure) { if (live.current === active) { setError(errorCode(failure)); await disconnect(); } }
    }, [adoptView, disconnect]);
    const installInputQueue = React.useCallback((active: ActiveDesktop) => {
        const queue = new DesktopInputQueue(async input => {
            if (live.current !== active) throw new DesktopRequestError('desktop-disconnected');
            const sequence = ++active.sequence;
            const receipt = await desktopRequest('input', { ...desktopBinding(active.grant), sequence, input }, active.peer);
            if (!desktopInputAcknowledged(receipt, sequence)) throw new DesktopRequestError('desktop-operation-unknown');
        }, failure => {
            if (live.current !== active || inputQueue.current !== queue) return;
            if (['desktop-not-ready', 'desktop-view-changed'].includes(errorCode(failure))) {
                inputQueue.current = null; setReady(false); void recoverView();
            } else { setError(errorCode(failure)); void disconnect(); }
        });
        inputQueue.current = queue;
    }, [disconnect, recoverView]);
    const refresh = React.useCallback(async () => {
        const current = epoch.current;
        try {
            const status = await desktopRequest<DesktopStatus>('status', {}, connection.peerId ?? undefined);
            if (current !== epoch.current) return;
            setStatus(status); setError(null);
            if (status.enabled) {
                const inventory = await desktopRequest<DesktopDisplaysResponse>('displays', {}, connection.peerId ?? undefined);
                if (current !== epoch.current) return;
                setDisplays(inventory.displays);
                setVirtualDisplaySupported(inventory.virtualDisplaySupported ?? inventory.displays.some(isVirtualDisplayItem));
                setStatus({ ...status, permissions: inventory.permissions });
            } else {
                setDisplays([]);
                setVirtualDisplaySupported(false);
            }
        } catch (failure) { if (current === epoch.current) setError(errorCode(failure)); }
    }, [connection.peerId]);

    React.useEffect(() => {
        if (focused) void refresh(); else void disconnect();
        return () => { void disconnect(); };
    }, [focused, connection.peerId, disconnect, refresh]);
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', state => { if (state !== 'active') void disconnect(); });
        return () => subscription.remove();
    }, [disconnect]);

    const connect = React.useCallback(async (displayId: string, viewport?: DesktopViewport) => {
        if (requestPending.current || live.current || !connection.peerId) return;
        requestPending.current = true; const current = ++epoch.current;
        setSelectedDisplayId(displayId); resetWindowState();
        setBusy(true); setError(null); setNotice(null); setReady(false);
        let created: Room | null = null, keyProvider: RNKeyProvider | null = null, joined: DesktopGrant | null = null;
        const peer = connection.peerId;
        const isTargetVirtual = displayId === 'virtual' || isVirtualDisplayItem(displays.find(item => item.id === displayId));
        const joinBody: Record<string, unknown> = isTargetVirtual && viewport
            ? { displayId, quality, viewport: { width: viewport.width, height: viewport.height } }
            : { displayId, quality };
        try {
            joined = await desktopRequest<DesktopGrant>('join', joinBody, peer);
            if (current !== epoch.current) { await desktopRequest('leave', desktopBinding(joined), peer); return; }
            registerGlobals({ autoConfigureAudioSession: false }); setLogLevel('silent');
            keyProvider = new RNKeyProvider({ sharedKey: true });
            await keyProvider.setSharedKey(joined.key);
            created = new Room({ adaptiveStream: false, dynacast: false, e2ee: { e2eeManager: new RNE2EEManager(keyProvider, false) } });
            await created.setE2EEEnabled(true);
            created.on(RoomEvent.Disconnected, () => { if (current === epoch.current) void disconnect(); });
            created.on(RoomEvent.Reconnecting, () => { if (current === epoch.current) { setError('desktop-disconnected'); void disconnect(); } });
            created.on(RoomEvent.EncryptionError, () => { if (current === epoch.current) { setError('desktop-media-connect-failed'); void disconnect(); } });
            await created.connect(joined.url, joined.token, { autoSubscribe: true });
            if (current !== epoch.current) { await created.disconnect(); keyProvider.dispose(); await desktopRequest('leave', desktopBinding(joined), peer); return; }
            live.current = { grant: joined, room: created, keyProvider, peer, sequence: 0 };
            const active = live.current;
            setSelectedDisplayId(joined.display.id);
            installInputQueue(active);
            setGrant(joined); setRoom(created);
        } catch (failure) {
            await created?.disconnect(); keyProvider?.dispose();
            if (joined) await desktopRequest('leave', desktopBinding(joined), peer).catch(() => {});
            if (current === epoch.current) setError(errorCode(failure));
        } finally { if (current === epoch.current) { requestPending.current = false; setBusy(false); } }
    }, [connection.peerId, displays, quality, disconnect, installInputQueue, resetWindowState]);

    React.useEffect(() => {
        if (!grant) return;
        let pending = false;
        const timer = setInterval(async () => {
            const active = live.current; if (!active || pending) return; pending = true;
            const startingGrant = active.grant;
            try {
                const result = await desktopRequest<DesktopView>('heartbeat', desktopBinding(startingGrant), active.peer);
                if (live.current !== active) return;
                if (!result.connected || !result.capturing || result.permissions.locked) { setError('desktop-disconnected'); await disconnect(); }
                else if (startingGrant === active.grant && !requestPending.current) adoptView(active, result);
            } catch (failure) { if (live.current === active) { setError(errorCode(failure)); await disconnect(); } }
            finally { pending = false; }
        }, 3000);
        return () => clearInterval(timer);
    }, [grant, disconnect, adoptView]);

    const videoReady = React.useCallback(async (trackSid: string) => {
        const active = live.current; if (!active || requestPending.current || active.grant.trackSid !== trackSid) return false;
        const startingGrant = active.grant, geometry = startingGrant.display.geometry;
        const currentView = () => live.current === active && !requestPending.current && active.grant === startingGrant
            && active.grant.trackSid === trackSid && active.grant.display.geometry === geometry;
        try {
            await desktopRequest('ready', { ...desktopBinding(startingGrant), trackSid }, active.peer);
            if (currentView()) { if (!inputQueue.current) installInputQueue(active); setReady(true); setError(null); return true; }
        } catch (failure) {
            if (currentView() && !(failure instanceof DesktopRequestError && failure.code === 'desktop-not-ready')) setError(errorCode(failure));
        }
        return false;
    }, [installInputQueue]);
    const input = React.useCallback(async (input: DesktopInput) => {
        if (!live.current || !ready || requestPending.current) return false;
        return inputQueue.current?.send(input) ?? false;
    }, [ready]);
    const changeQuality = React.useCallback(async (next: DesktopQuality) => {
        if (requestPending.current) return;
        const active = live.current;
        if (!active) { setQuality(next); return; }
        inputQueue.current?.close(); inputQueue.current = null;
        requestPending.current = true; setBusy(true); setReady(false);
        try {
            const result = await desktopRequest<{ trackSid: string }>('quality', { ...desktopBinding(active.grant), quality: next }, active.peer);
            if (live.current === active) { active.grant = { ...active.grant, quality: next, trackSid: result.trackSid }; setGrant(active.grant); setQuality(next); }
        }
        catch (failure) { if (live.current === active) { setError(errorCode(failure)); await disconnect(); } }
        finally { requestPending.current = false; setBusy(false); }
    }, [disconnect]);
    const switchDisplay = React.useCallback(async (displayId: string, viewport?: DesktopViewport) => {
        const active = live.current; if (!active || requestPending.current || active.grant.display.id === displayId) return;
        requestPending.current = true; inputQueue.current?.close(); inputQueue.current = null; setBusy(true); setReady(false);
        setError(null); setNotice(null);
        const isTargetVirtual = displayId === 'virtual' || isVirtualDisplayItem(displays.find(item => item.id === displayId));
        if (!isTargetVirtual) resetWindowState();
        const body: Record<string, unknown> = isTargetVirtual && viewport
            ? { ...desktopBinding(active.grant), displayId, viewport: { width: viewport.width, height: viewport.height } }
            : { ...desktopBinding(active.grant), displayId };
        try {
            const result = await desktopRequest<{ trackSid: string; display: DesktopDisplay; geometry?: string; viewPending?: boolean; permissions?: DesktopPermissions }>('display', body, active.peer);
            if (live.current === active) {
                setSelectedDisplayId(result.display.id);
                adoptView(active, {
                    geometry: result.geometry ?? result.display.geometry,
                    trackSid: result.trackSid,
                    viewPending: result.viewPending,
                    permissions: result.permissions,
                    display: result.display,
                    activeWindowId: isVirtualDisplayItem(result.display) ? undefined : null,
                });
            }
        } catch (failure) { if (live.current === active) { setError(errorCode(failure)); await disconnect(); } }
        finally { if (live.current === active) { requestPending.current = false; setBusy(false); } }
    }, [displays, adoptView, disconnect, resetWindowState]);
    const navigateSpace = React.useCallback(async (kind: DesktopSpaceAction) => {
        const active = live.current; if (!active || requestPending.current || !ready) return;
        requestPending.current = true; inputQueue.current?.close(); inputQueue.current = null;
        setReady(false); setBusy(true); setError(null); setNotice(null);
        const sequence = ++active.sequence;
        try {
            const result = await desktopRequest<DesktopView & { spaceChanged: boolean }>('space', {
                ...desktopBinding(active.grant), sequence, kind,
            }, active.peer);
            if (live.current === active) {
                adoptView(active, result);
                if (kind !== 'overview' && !result.spaceChanged) setNotice('desktop-space-unconfirmed');
            }
        } catch (failure) {
            if (live.current === active) { setNotice(errorCode(failure)); setError(null); await recoverView(); }
        } finally { if (live.current === active) { requestPending.current = false; setBusy(false); } }
    }, [ready, adoptView, recoverView]);

    const refreshWindows = React.useCallback(async () => {
        const active = live.current;
        if (!active || !isVirtualDisplayItem(active.grant.display)) return;
        const reqId = ++windowsEpoch.current;
        setWindowsLoading(true);
        try {
            const result = await desktopRequest<DesktopWindowsResponse>('windows', { connectionId: active.grant.connectionId }, active.peer);
            if (live.current !== active || reqId !== windowsEpoch.current || !isVirtualDisplayItem(active.grant.display)) return;
            setWindows(Array.isArray(result.windows) ? result.windows : []);
            setActiveWindowId(result.activeWindowId ?? null);
        } catch (failure) {
            if (live.current !== active || reqId !== windowsEpoch.current) return;
            const code = errorCode(failure);
            if (['desktop-disconnected', 'desktop-locked'].includes(code)) {
                setError(code);
                await disconnect();
            } else {
                setNotice(code);
            }
        } finally {
            if (reqId === windowsEpoch.current) setWindowsLoading(false);
        }
    }, [disconnect]);

    const runWindowAction = React.useCallback(async (payload: { mode: 'fill'; windowId: string } | { mode: 'restore' }): Promise<boolean> => {
        const active = live.current;
        if (!active || requestPending.current || !ready || !isVirtualDisplayItem(active.grant.display)) return false;
        if (payload.mode === 'fill' && !/^\d{1,10}:\d{1,10}$/u.test(payload.windowId)) return false;
        requestPending.current = true;
        inputQueue.current?.close();
        inputQueue.current = null;
        setReady(false);
        setBusy(true);
        setError(null);
        setNotice(null);
        const sequence = ++active.sequence;
        try {
            const result = await desktopRequest<DesktopWindowActionResponse>('window', {
                ...desktopBinding(active.grant),
                sequence,
                ...payload,
            }, active.peer);
            if (live.current === active) {
                adoptView(active, result);
                setWindows(previous => previous.map(item => ({
                    ...item,
                    onVirtualDisplay: result.activeWindowId !== null && item.id === result.activeWindowId,
                })));
                return true;
            }
        } catch (failure) {
            if (live.current === active) {
                setNotice(errorCode(failure));
                setError(null);
                await recoverView();
            }
        } finally {
            if (live.current === active) {
                requestPending.current = false;
                setBusy(false);
            }
        }
        return false;
    }, [ready, adoptView, recoverView]);

    const fillWindow = React.useCallback((windowId: string) => runWindowAction({ mode: 'fill', windowId }), [runWindowAction]);
    const restoreWindow = React.useCallback(() => runWindowAction({ mode: 'restore' }), [runWindowAction]);

    const selectedDisplay = grant?.display
        ?? displays.find(item => item.id === selectedDisplayIdState)
        ?? displays[0]
        ?? null;
    const selectedDisplayId = selectedDisplay?.id ?? '';
    const isVirtualDisplay = isVirtualDisplayItem(selectedDisplay);

    return {
        status,
        displays,
        selectedDisplayId,
        selectedDisplay,
        selectDisplay: setSelectedDisplayId,
        isVirtualDisplay,
        virtualDisplaySupported,
        grant,
        room,
        busy,
        closing,
        ready,
        inputAllowed: connection.writable !== false,
        error,
        notice,
        quality,
        windows,
        activeWindowId,
        windowsLoading,
        connect,
        disconnect,
        refresh,
        input,
        changeQuality,
        switchDisplay,
        navigateSpace,
        refreshWindows,
        fillWindow,
        restoreWindow,
        videoReady,
    };
}
