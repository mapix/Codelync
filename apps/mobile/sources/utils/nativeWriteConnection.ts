import type { Metadata } from '@/sync/storageTypes';
import { isNoninvasiveBridge } from '@/sync/noninvasiveBridge';

/** HTTP reading readiness never substitutes for the native write connection. */
export function nativeWriteConnectionBlocked(metadata: Metadata | null | undefined, connected: boolean): boolean {
    return isNoninvasiveBridge(metadata) && !connected;
}
