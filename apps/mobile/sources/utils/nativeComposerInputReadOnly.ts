import type { Session } from '@/sync/storageTypes';
import { isCodeLightSessionIdentity } from './codeLightSourceScope';
import { nativeSubagentInputReadOnly } from './nativeParentControl';
import { codeLightSavedHistory } from './nativeSavedHistory';

/** Explicit original-owner policy is independent of temporary control readiness. */
export function nativeComposerInputReadOnly(session: Pick<Session, 'metadata'> | null | undefined): boolean {
    if (codeLightSavedHistory(session) || nativeSubagentInputReadOnly(session)) return true;
    const metadata = session?.metadata, bridge = metadata?.bridge, source = bridge?.source;
    return metadata?.client?.id === 'noninvasive-bridge' && metadata?.capabilities?.readOnly === true
        && source?.kind === 'session' && typeof source.id === 'string' && !!source.id.trim()
        && typeof source.hostId === 'string' && !!source.hostId.trim()
        && isCodeLightSessionIdentity(source, bridge?.controlMode);
}
