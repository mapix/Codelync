import type { Session } from '@/sync/storageTypes';
import { isCodelyncSessionIdentity } from './codelyncSourceScope';

/** A response-only cached body never authorizes a new original-owner action. */
export function nativeCachedReadControlsUnavailable(session: Pick<Session, 'metadata'> | null | undefined): boolean {
    const metadata = session?.metadata, source = metadata?.bridge?.source;
    const value = metadata?.nativeReadFreshness as Record<string, unknown> | null | undefined;
    return metadata?.client?.id === 'noninvasive-bridge' && isCodelyncSessionIdentity(source, metadata.bridge?.controlMode)
        && value?.version === 1 && value.mode === 'cached' && value.currentControlAuthority === false
        && typeof value.ownerGeneration === 'string' && !!value.ownerGeneration.trim() && value.ownerGeneration === source?.runtimeGeneration;
}
