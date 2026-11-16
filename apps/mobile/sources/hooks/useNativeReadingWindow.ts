import * as React from 'react';
import type { Metadata } from '@/sync/storageTypes';
import { apiSocket } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import { nativeReadingIdentity, retainNativeReadingWindow, type NativeReadingWindowState } from '@/utils/nativeReadingWindow';

const subscribeAuthority = (listener: () => void) => apiSocket.onStatusChange(listener);
const readAuthority = () => apiSocket.peerIdentity() ?? getServerUrl();

/** Read-scope retention never restores a controller or modifies native metadata. */
export function useNativeReadingWindow(sessionId: string, metadata: Metadata | null): string {
    const authority = React.useSyncExternalStore(subscribeAuthority, readAuthority, readAuthority);
    const identity = nativeReadingIdentity(sessionId, metadata, authority) ?? JSON.stringify([authority, sessionId, 'unverified-native-reading']);
    const previous = React.useRef<NativeReadingWindowState | null>(null);
    const next = retainNativeReadingWindow(previous.current, identity, metadata?.bridge?.source.runtimeGeneration);
    React.useLayoutEffect(() => { previous.current = next; }, [next]);
    return JSON.stringify(next);
}
