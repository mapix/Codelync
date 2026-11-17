import type { Session } from '@/sync/storageTypes';
import { isCodelyncSessionIdentity } from './codelyncSourceScope';
import { nativeSubagentInputReadOnly } from './nativeParentControl';
import { codelyncSavedHistory } from './nativeSavedHistory';

/** Explicit original-owner policy is independent of temporary control readiness. */
export function nativeComposerInputReadOnly(session: Pick<Session, 'metadata'> | null | undefined): boolean {
    if (codelyncSavedHistory(session) || nativeSubagentInputReadOnly(session)) return true;
    const metadata = session?.metadata, bridge = metadata?.bridge, source = bridge?.source;
    return metadata?.client?.id === 'noninvasive-bridge' && metadata?.capabilities?.readOnly === true
        && source?.kind === 'session' && typeof source.id === 'string' && !!source.id.trim()
        && typeof source.hostId === 'string' && !!source.hostId.trim()
        && isCodelyncSessionIdentity(source, bridge?.controlMode);
}
