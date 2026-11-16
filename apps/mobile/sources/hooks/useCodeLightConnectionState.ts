import * as React from 'react';
import { useSocketStatus } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { getConnectionSnapshot, subscribeConnection } from '@/sync/codeLightConnection';
import { codeLightConnectionState } from '@/utils/codeLightConnectionState';

export function useCodeLightConnectionState() {
    const snapshot = React.useSyncExternalStore(subscribeConnection, getConnectionSnapshot, getConnectionSnapshot);
    const status = useSocketStatus().status;
    const subscribe = React.useCallback((listener: () => void) => apiSocket.onStatusChange(() => listener()), []);
    const read = React.useCallback(() => {
        const error = apiSocket.peerConnectionError();
        return JSON.stringify({ error: error ? { code: error.code, httpStatus: error.httpStatus } : null,
            canReconnect: apiSocket.peerCanReconnect(), peerIdentity: apiSocket.peerIdentity() });
    }, []);
    const details = JSON.parse(React.useSyncExternalStore(subscribe, read, read));
    return { snapshot, state: codeLightConnectionState({ snapshot, status, ...details }) };
}
