import type { Session } from '@/sync/storageTypes';
import type { LoadingProgress } from '@/sync/codelyncLoadingProgress';
import { nativeCachedReadControlsUnavailable } from './nativeCachedRead';

export type NativeSessionReadNotice = 'checking' | 'read-failed' | 'source-unavailable' | null;
/** Read/source outcome only. WebSocket transitions are a separate icon state. */
export function nativeSessionReadNotice(session: Session | null | undefined, progress: LoadingProgress, selection = 'idle'): NativeSessionReadNotice {
    if (!session) return null;
    if (progress.revalidationFailed || progress.phase === 'error') return 'read-failed';
    if (progress.revalidating || progress.phase === 'loading' || progress.phase === 'idle' && selection === 'connecting') return 'checking';
    if (progress.phase === 'complete' && ['disconnected', 'owner-unavailable', 'locked', 'permission-required'].includes(session.metadata?.bridge?.sourceStatus ?? '')
        && !nativeCachedReadControlsUnavailable(session)) return 'source-unavailable';
    if (progress.phase === 'idle' && selection === 'failed') return 'read-failed';
    return null;
}
