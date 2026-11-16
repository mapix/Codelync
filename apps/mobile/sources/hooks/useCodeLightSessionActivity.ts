import { useCallback, useSyncExternalStore } from 'react';
import type { Session } from '@/sync/storageTypes';
import { apiSocket } from '@/sync/apiSocket';
import { codeLightActivitySourceScope, codeLightProjectActivityStore } from '@/sync/codeLightProjectActivity';
import { isCodeLightSessionIdentity } from '@/utils/codeLightSourceScope';

export function codeLightSessionActivityScope(session: Session | null | undefined): string | null {
    const metadata = session?.metadata, source = metadata?.bridge?.source, machine = metadata?.machineId;
    return metadata?.client?.id === 'noninvasive-bridge' && typeof machine === 'string' && !!machine
        && isCodeLightSessionIdentity(source, metadata.bridge?.controlMode) && source
        ? codeLightActivitySourceScope(machine, source.app, source.hostId, source.id) : null;
}

/** Label-only activity lookup; it never owns a controller or grants input. */
export function useCodeLightSessionActivityForSource(session: Session) {
    const id = session.id, key = codeLightSessionActivityScope(session);
    const subscribe = useCallback((listener: () => void) => {
        const release = codeLightProjectActivityStore.subscribeSession(id, listener);
        const releasePeer = apiSocket.onStatusChange(() => listener());
        return () => { release(); releasePeer(); };
    }, [id]);
    const get = useCallback(() => codeLightProjectActivityStore.getSessionScoped(id, key, apiSocket.peerIdentity()), [id, key]);
    return useSyncExternalStore(subscribe, get, get);
}
