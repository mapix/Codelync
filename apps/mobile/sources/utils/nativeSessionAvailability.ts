import type { Session } from '@/sync/storageTypes';
import { isNoninvasiveBridge } from '@/sync/noninvasiveBridge';

export type NativeSessionAvailability = 'available' | 'loading' | 'unavailable' | 'legacy-missing';
export function nativeSessionAvailability(input: { nativeProduct: boolean; ready: boolean; pending: boolean;
    directoryPhase: string; session: Session | null | undefined }): NativeSessionAvailability {
    if (!input.ready) return 'loading';
    if (input.pending) return 'available';
    if (input.session) return isNoninvasiveBridge(input.session.metadata)
        && input.session.metadata?.nativeSession?.catalogueAvailable === false ? 'unavailable' : 'available';
    if (!input.nativeProduct) return 'legacy-missing';
    return ['idle', 'loading'].includes(input.directoryPhase) ? 'loading' : 'unavailable';
}
