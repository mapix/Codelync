import * as React from 'react';
import { AppState } from 'react-native';
import type { Session } from '@/sync/storageTypes';
import { apiSocket, getCurrentAppState } from '@/sync/apiSocket';
import { nativeTaskCache, nativeTaskCacheContext, nativeTaskPeerIdentity } from '@/sync/nativeTaskStore';
import { nativeTaskCacheKey } from '@/sync/nativeTaskCache';

const EMPTY = Object.freeze({ native: null, loading: false, failed: false });
const subscribePeer = (listener: () => void) => apiSocket.onStatusChange(listener);
function useNativeTaskForeground() {
    const [active, setActive] = React.useState(() => getCurrentAppState() === 'active');
    React.useEffect(() => {
        const changed = () => setActive(getCurrentAppState() === 'active'), subscription = AppState.addEventListener('change', changed);
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', changed);
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') { window.addEventListener('focus', changed); window.addEventListener('blur', changed); }
        return () => { subscription.remove(); if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', changed);
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') { window.removeEventListener('focus', changed); window.removeEventListener('blur', changed); } };
    }, []);
    return active;
}
/** Expanded foreground intents share an ephemeral read; collapsed views only subscribe. */
export function useCodelyncNativeTaskData(session: Session | null, expanded = false, screenActive = true) {
    const foreground = useNativeTaskForeground(), consumer = React.useRef(Symbol('native-task-view'));
    React.useSyncExternalStore(subscribePeer, nativeTaskPeerIdentity);
    const context = nativeTaskCacheContext(session), key = context ? nativeTaskCacheKey(context) : '';
    const desired = context?.desiredDigest ?? null;
    const subscribe = React.useCallback((listener: () => void) => key ? nativeTaskCache.subscribe(key, listener) : () => {}, [key]);
    const read = React.useCallback(() => context ? nativeTaskCache.get(context) : EMPTY, [key, desired]);
    const view = React.useSyncExternalStore(subscribe, read);
    const enabled = expanded && screenActive && foreground && session?.metadata?.capabilities?.rpcMethods?.includes('native-task-read') === true;
    React.useEffect(() => {
        if (context) nativeTaskCache.retain(consumer.current, context, enabled);
        return () => nativeTaskCache.release(consumer.current);
    }, [key, desired, enabled]);
    const retry = React.useCallback(() => { if (context && enabled) nativeTaskCache.retry(context); }, [key, desired, enabled]);
    // A digestless legacy producer already publishes full metadata. It cannot
    // serve an incremental baseline and keeps that authoritative live mirror.
    const legacy = !session?.agentState?.nativeTaskSignal && session?.agentState?.nativeTasks?.digest === undefined ? session?.agentState?.nativeTasks : null;
    return { ...view, native: view.failed ? null : legacy ?? view.native, retry };
}
