import type { Metadata } from '@/sync/storageTypes';
import { isCodeLightSessionIdentity } from './codeLightSourceScope';
import { canReadFromNoninvasiveSource, isNoninvasiveBridge } from '@/sync/noninvasiveBridge';

export type NativeReadingWindowState = { identity: string; owner: string | null };

/** Authenticated content identity is independent of temporary controller readiness. */
export function nativeReadingIdentity(sessionId: string, metadata: Metadata | null, authority: string): string | null {
    const bridge = metadata?.bridge, source = bridge?.source;
    if (!authority || !isNoninvasiveBridge(metadata) || !isCodeLightSessionIdentity(source, bridge?.controlMode)
        || typeof source?.id !== 'string' || !source.id.trim() || typeof source.hostId !== 'string' || !source.hostId.trim()) return null;
    return JSON.stringify([authority, sessionId, metadata?.machineId ?? null, source.app, source.hostId, source.id,
        source.kind ?? 'session', source.protocol ?? null, source.appMode ?? null, source.nativeCollection ?? null]);
}

/** A null live owner preserves only the same identity's existing reading owner. */
export function retainNativeReadingWindow(previous: NativeReadingWindowState | null, identity: string,
    currentOwner: unknown): NativeReadingWindowState {
    const owner = typeof currentOwner === 'string' && currentOwner.trim() ? currentOwner : null;
    if (previous?.identity !== identity) return { identity, owner };
    if (owner !== null && owner !== previous.owner) return { identity, owner };
    return previous;
}

export function nativeReadingControlsUnavailable(metadata: Metadata | null | undefined): boolean {
    return isNoninvasiveBridge(metadata) && (metadata?.capabilities?.readOnly === true || !canReadFromNoninvasiveSource(metadata));
}

/** Captured cached controls never follow a new source, owner or native turn. */
export function nativeReadingControlScope(metadata: Metadata | null | undefined): string | null {
    if (!metadata) return null;
    const identity = nativeReadingIdentity('native-control', metadata, 'native-control');
    return identity ? JSON.stringify([identity, metadata.bridge?.source.runtimeGeneration ?? null, metadata.bridge?.currentTurnId ?? null]) : null;
}
