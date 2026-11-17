import type { ConnectionSnapshot } from '@/sync/codelyncConnection';

export type CodelyncConnectionState = {
    kind: 'hidden' | 'connected' | 'connecting' | 'failed' | 'access-ended';
    busy: boolean;
    canRetry: boolean;
    canInspect: boolean;
};

/** A readable HTTP route is recovery state, never a connected write socket. */
export function codelyncConnectionState(input: {
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    snapshot: ConnectionSnapshot;
    error: { code: string; httpStatus?: number; peerAuthenticated?: boolean } | null;
    canReconnect: boolean;
    peerIdentity?: string | null;
}): CodelyncConnectionState {
    const { status, snapshot, error, canReconnect } = input;
    const canInspect = !!snapshot.peerId && snapshot.channels.length > 0;
    const retryTarget = snapshot.automatic || snapshot.selectedId !== null;
    const base = { busy: snapshot.connecting, canRetry: canInspect && retryTarget, canInspect };
    if (!snapshot.peerId) return { ...base, kind: 'hidden', canRetry: false };
    if (input.peerIdentity && input.peerIdentity !== 'peer:' + snapshot.peerId) return { ...base, kind: 'failed', canRetry: false };
    if (status === 'connected') return { ...base, kind: input.peerIdentity === null ? 'failed' : 'connected' };
    const accessEnded = snapshot.failureCode === 'access-ended' || error?.peerAuthenticated === true && (['device-revoked', 'device-access-revoked', 'access-revoked'].includes(error?.code ?? '')
        || !canReconnect && ['missing-token', 'invalid-token'].includes(error?.code ?? ''));
    if (accessEnded) return { ...base, kind: 'access-ended', busy: false, canRetry: false };
    if (snapshot.failureCode) return { ...base, kind: 'failed', busy: false };
    if (snapshot.readable && snapshot.realtimeRecovering) return { ...base, kind: 'connecting', busy: snapshot.connecting };
    if (snapshot.connecting || status === 'connecting') return { ...base, kind: 'connecting', busy: true };
    return { ...base, kind: 'failed' };
}
