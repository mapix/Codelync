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

/** Label-only activity lookup; it never owns a controller or grants input. */
export function useCodelyncSessionActivityForSource(session: Session) {
    const id = session.id, key = codelyncSessionActivityScope(session);
    const subscribe = useCallback((listener: () => void) => {
        const release = codelyncProjectActivityStore.subscribeSession(id, listener);
        const releasePeer = apiSocket.onStatusChange(() => listener());
        return () => { release(); releasePeer(); };
    }, [id]);
    const get = useCallback(() => codelyncProjectActivityStore.getSessionScoped(id, key, apiSocket.peerIdentity()), [id, key]);
    return useSyncExternalStore(subscribe, get, get);
}
