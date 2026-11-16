import * as React from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Room, RoomEvent, setLogLevel } from 'livekit-client';
import { registerGlobals, RNKeyProvider, RNE2EEManager } from '@livekit/react-native';
import { TokenStorage } from '@/auth/tokenStorage';
import { getConnectionSnapshot, subscribeConnection } from '@/sync/codeLightConnection';
import { desktopRequest, desktopBinding, DesktopRequestError, type DesktopStatus, type DesktopDisplay, type DesktopGrant, type DesktopInput, type DesktopQuality, type DesktopView, type DesktopSpaceAction } from '@/sync/remoteDesktop';
import { DesktopInputQueue, DesktopInputQueueError, desktopInputAcknowledged } from '@/sync/desktopInputQueue';

type ActiveDesktop = { grant: DesktopGrant; room: Room; keyProvider: RNKeyProvider; peer: string; sequence: number };

export function useRemoteDesktop() {
    const focused = useIsFocused(), connection = React.useSyncExternalStore(subscribeConnection, getConnectionSnapshot);
    const [status, setStatus] = React.useState<DesktopStatus | null>(null), [displays, setDisplays] = React.useState<DesktopDisplay[]>([]);
    const [grant, setGrant] = React.useState<DesktopGrant | null>(null), [room, setRoom] = React.useState<Room | null>(null);
    const [busy, setBusy] = React.useState(false), [closing, setClosing] = React.useState(false), [ready, setReady] = React.useState(false), [error, setError] = React.useState<string | null>(null);
    const [quality, setQuality] = React.useState<DesktopQuality>({ width: 1920, fps: 30 });
    const [notice, setNotice] = React.useState<string | null>(null);
    const live = React.useRef<ActiveDesktop | null>(null);
    const epoch = React.useRef(0), requestPending = React.useRef(false), inputQueue = React.useRef<DesktopInputQueue | null>(null);
    const errorCode = (failure: unknown) => failure instanceof DesktopRequestError || failure instanceof DesktopInputQueueError ? failure.code : 'desktop-media-connect-failed';

    const disconnect = React.useCallback(async () => {
        ++epoch.current; const prior = live.current; live.current = null;
        inputQueue.current?.close(); inputQueue.current = null;
        setReady(false); setGrant(null); setRoom(null); setBusy(!!prior); setClosing(!!prior); requestPending.current = !!prior;
        if (prior) {
            await Promise.allSettled([prior.room.disconnect(), desktopRequest('leave', desktopBinding(prior.grant), prior.peer)]);
            prior.keyProvider.dispose();
        }
        setBusy(false); setClosing(false); requestPending.current = false;
    }, []);
    const adoptView = React.useCallback((active: ActiveDesktop, result: DesktopView) => {
        if (live.current !== active) return;
        if (result.geometry !== active.grant.display.geometry || result.trackSid !== active.grant.trackSid || result.viewPending) {
            inputQueue.current?.close(); inputQueue.current = null; setReady(false);
            active.grant = { ...active.grant, trackSid: result.trackSid, display: { ...active.grant.display, geometry: result.geometry } };
            setGrant(active.grant);
        }
        setStatus(previous => previous ? { ...previous, permissions: result.permissions } : previous);
    }, []);
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
                const inventory = await desktopRequest<{ displays: DesktopDisplay[]; permissions: NonNullable<DesktopStatus['permissions']> }>('displays', {}, connection.peerId ?? undefined);
                if (current !== epoch.current) return;
                setDisplays(inventory.displays); setStatus({ ...status, permissions: inventory.permissions });
            } else setDisplays([]);
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

    const connect = React.useCallback(async (displayId: string) => {
        if (requestPending.current || live.current || !connection.peerId) return;
        requestPending.current = true; const current = ++epoch.current; setBusy(true); setError(null); setNotice(null); setReady(false);
        let created: Room | null = null, keyProvider: RNKeyProvider | null = null, joined: DesktopGrant | null = null;
        const peer = connection.peerId;
        try {
            joined = await desktopRequest<DesktopGrant>('join', { displayId, quality }, peer);
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
            installInputQueue(active);
            setGrant(joined); setRoom(created);
        } catch (failure) {
            await created?.disconnect(); keyProvider?.dispose();
            if (joined) await desktopRequest('leave', desktopBinding(joined), peer).catch(() => {});
            if (current === epoch.current) setError(errorCode(failure));
        } finally { if (current === epoch.current) { requestPending.current = false; setBusy(false); } }
    }, [connection.peerId, quality, disconnect, installInputQueue]);

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
    const switchDisplay = React.useCallback(async (displayId: string) => {
        const active = live.current; if (!active || requestPending.current || active.grant.display.id === displayId) return;
        requestPending.current = true; inputQueue.current?.close(); inputQueue.current = null; setBusy(true); setReady(false);
        try {
            const result = await desktopRequest<{ trackSid: string; display: DesktopDisplay }>('display', { ...desktopBinding(active.grant), displayId }, active.peer);
            if (live.current === active) { active.grant = { ...active.grant, display: result.display, trackSid: result.trackSid }; setGrant(active.grant); }
        } catch (failure) { if (live.current === active) { setError(errorCode(failure)); await disconnect(); } }
        finally { if (live.current === active) { requestPending.current = false; setBusy(false); } }
    }, [disconnect]);
    const navigateSpace = React.useCallback(async (kind: DesktopSpaceAction) => {
        const active = live.current; if (!active || requestPending.current || !ready) return;
        requestPending.current = true; inputQueue.current?.close(); inputQueue.current = null;
        setReady(false); setBusy(true); setError(null); setNotice(null);
        try {
            const result = await desktopRequest<DesktopView & { spaceChanged: boolean }>('space', {
                ...desktopBinding(active.grant), sequence: ++active.sequence, kind,
            }, active.peer);
            if (live.current === active) {
                adoptView(active, result);
                if (kind !== 'overview' && !result.spaceChanged) setNotice('desktop-space-unconfirmed');
            }
        } catch (failure) {
            if (live.current === active) { setNotice(errorCode(failure)); setError(null); await recoverView(); }
        } finally { if (live.current === active) { requestPending.current = false; setBusy(false); } }
    }, [ready, adoptView, recoverView]);
    return { status, displays, grant, room, busy, closing, ready, error, notice, quality, connect, disconnect, refresh, input, changeQuality, switchDisplay, navigateSpace, videoReady };
}
