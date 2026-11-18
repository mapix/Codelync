import { useCallback, useSyncExternalStore } from 'react';
import type { Session } from '@/sync/storageTypes';
import { apiSocket } from '@/sync/apiSocket';
import { codelyncActivitySourceScope, codelyncProjectActivityStore } from '@/sync/codelyncProjectActivity';
import { isCodelyncSessionIdentity } from '@/utils/codelyncSourceScope';

export function codelyncSessionActivityScope(session: Session | null | undefined): string | null {
    const metadata = session?.metadata, source = metadata?.bridge?.source, machine = metadata?.machineId;
    return metadata?.client?.id === 'noninvasive-bridge' && typeof machine === 'string' && !!machine
        && isCodelyncSessionIdentity(source, metadata.bridge?.controlMode) && source
        ? codelyncActivitySourceScope(machine, source.app, source.hostId, source.id) : null;
}

const peerStatusListeners = new Set<() => void>();
let releasePeerStatusSubscription: (() => void) | null = null;
let lastPeerIdentity: string | null | undefined;

function subscribePeerStatus(listener: () => void): () => void {
    peerStatusListeners.add(listener);
    if (!releasePeerStatusSubscription) {
        let initialEcho = true;
        lastPeerIdentity = apiSocket.peerIdentity();
        releasePeerStatusSubscription = apiSocket.onStatusChange(() => {
            if (initialEcho) {
                initialEcho = false;
                lastPeerIdentity = apiSocket.peerIdentity();
                return;
            }
            const nextPeerIdentity = apiSocket.peerIdentity();
            if (nextPeerIdentity === lastPeerIdentity) return;
            lastPeerIdentity = nextPeerIdentity;
            for (const notify of [...peerStatusListeners]) notify();
        });
        initialEcho = false;
    }
    return () => {
        peerStatusListeners.delete(listener);
        if (peerStatusListeners.size === 0 && releasePeerStatusSubscription) {
            const release = releasePeerStatusSubscription;
            releasePeerStatusSubscription = null;
            lastPeerIdentity = undefined;
            release();
        }
    };
}

const noopSubscribe = () => () => {};

/** Label-only activity lookup; it never owns a controller or grants input. */
export function useCodelyncSessionActivityForSource(session: Session) {
    const id = session.id, key = codelyncSessionActivityScope(session);
    const subscribe = useCallback((listener: () => void) => {
        if (!key) return noopSubscribe();
        const release = codelyncProjectActivityStore.subscribeSession(id, listener);
        const releasePeer = subscribePeerStatus(listener);
        return () => { release(); releasePeer(); };
    }, [id, key]);
    const get = useCallback(() => codelyncProjectActivityStore.getSessionScoped(id, key, apiSocket.peerIdentity()), [id, key]);
    return useSyncExternalStore(subscribe, get, get);
}
