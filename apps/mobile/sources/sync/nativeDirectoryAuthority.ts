import type { Metadata, Session } from './storageTypes';
import { isCodeLightSessionIdentity } from '@/utils/codeLightSourceScope';

type NativeHeader = NonNullable<Metadata['nativeSession']>;
export type NativeDirectoryAuthority = { identity: string; header: NativeHeader };

function identity(session: Pick<Session, 'id' | 'metadata'>): string | null {
    const metadata = session.metadata, bridge = metadata?.bridge, source = bridge?.source;
    if (metadata?.client?.id !== 'noninvasive-bridge' || !metadata.machineId || !source?.id || !source.hostId
        || source.kind !== undefined && source.kind !== 'session') return null;
    const native = isCodeLightSessionIdentity(source, bridge?.controlMode);
    if (!native) return null;
    // Owner proof can become temporarily unavailable during reattachment. It
    // remains a control fence, and cannot clear this independent directory fact.
    return JSON.stringify([session.id, metadata.machineId, source.app, source.hostId, source.id,
        ...(source.app === 'claude-desktop' ? [source.protocol, source.nativeCollection] : [])]);
}

/** Catalog membership is a separate authority from observer metadata versions. */
export function applyNativeDirectoryAuthority<T extends Omit<Session, 'presence'>>(incoming: T, previous: Session | undefined, catalog: boolean | 'cached' = false): T {
    const scope = identity(incoming);
    const authority = previous?.nativeDirectory ?? (scope && previous && identity(previous) === scope
        && previous.metadata?.nativeSession?.catalogueAvailable === false
        ? { identity: scope, header: { ...previous.metadata.nativeSession } } : undefined);
    if (catalog && scope && incoming.metadata?.nativeSession && !(catalog === 'cached' && authority?.identity === scope)) {
        return { ...incoming, nativeDirectory: { identity: scope, header: { ...incoming.metadata.nativeSession } } };
    }
    if (scope && authority?.identity === scope && incoming.metadata) {
        return { ...incoming, nativeDirectory: authority, metadata: { ...incoming.metadata, nativeSession: authority.header } };
    }
    return { ...incoming, nativeDirectory: undefined };
}
