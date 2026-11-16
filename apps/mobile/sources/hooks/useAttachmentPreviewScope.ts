import * as React from 'react';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import { currentImageReadCredentials } from '@/sync/imageReadCredentials';
import { encodeBase64 } from '@/encryption/base64';
import { nativeReadingIdentity } from '@/utils/nativeReadingWindow';
import { noteNativeImageStage } from '@/sync/nativeImageDiagnostics';

type Reason = 'ready' | 'credentials-unavailable' | 'target-unavailable' | 'peer-mismatch' | 'key-unavailable' | 'key-invalid' | 'scope-unavailable';
type Snapshot = { authority: string | null; key: string | null; nativeIdentity: string | null; reason: Reason; keyPresent: boolean; peerMatch: boolean };

/** Private, content-free cache identity. Live owner status never grants blob access. */
export function attachmentPreviewSnapshot(sessionId: string, refValue: string, liveRef = false): Snapshot {
    try {
        const credentials = sync.getCredentials(), blobKey = sync.encryption.getSessionBlobKey(sessionId);
        const peer = credentials?.peer, socketPeer = apiSocket.peerIdentity();
        const peerMatch = !peer || socketPeer === 'peer:' + peer.id;
        const state = storage.getState();
        const reason: Reason = !credentials?.secret ? 'credentials-unavailable' : !sessionId || !refValue ? 'target-unavailable'
            : !peerMatch ? 'peer-mismatch' : !blobKey ? 'key-unavailable' : blobKey.length !== 32 ? 'key-invalid' : 'ready';
        const source = credentials?.secret && sessionId && refValue && peerMatch ? JSON.stringify([credentials.secret,
            peer ? ['peer', peer.id, peer.device.publicKey, socketPeer]
                : ['legacy', credentials.token, credentials.serverUrl ?? getServerUrl(), getServerUrl()],
            sessionId, liveRef ? 'explicit-live-ref' : refValue, state.currentViewingSessionId ?? null]) : null;
        return { authority: source, key: reason === 'ready' ? JSON.stringify([source, encodeBase64(blobKey!)]) : null,
            nativeIdentity: nativeReadingIdentity(sessionId, state.sessions[sessionId]?.metadata ?? null, 'immutable-attachment'),
            reason, keyPresent: !!blobKey, peerMatch };
    } catch { return { authority: null, key: null, nativeIdentity: null, reason: 'scope-unavailable', keyPresent: false, peerMatch: false }; }
}

function scopeChanged(captured: Snapshot, current: Snapshot): boolean {
    return (captured.authority !== null && captured.authority !== current.authority)
        || (captured.key !== null && captured.key !== current.key)
        || !!(captured.nativeIdentity && current.nativeIdentity && captured.nativeIdentity !== current.nativeIdentity);
}

function sameScope(captured: Snapshot, current: Snapshot): boolean {
    return captured.authority !== null && captured.key !== null && !scopeChanged(captured, current);
}

/** Only opened previews subscribe; unrelated store updates do not notify or read bytes. */
export function useAttachmentPreviewScope(sessionId: string, refValue: string, onClose?: () => void, liveRef = false) {
    const read = React.useCallback(() => JSON.stringify(attachmentPreviewSnapshot(sessionId, refValue, liveRef)), [sessionId, refValue, liveRef]);
    const subscribe = React.useCallback((listener: () => void) => {
        let previous = read();
        const changed = () => { const next = read(); if (next !== previous) { previous = next; listener(); } };
        const releaseStore = storage.subscribe(changed), releaseStatus = apiSocket.onStatusChange(changed);
        return () => { releaseStore(); releaseStatus(); };
    }, [read]);
    const current = React.useSyncExternalStore(subscribe, read, read);
    const captured = React.useRef<Snapshot>(JSON.parse(current));
    const expected = React.useRef<AuthCredentials | null | undefined>(undefined);
    if (expected.current === undefined) {
        const credentials = sync.getCredentials();
        expected.current = captured.current.authority && credentials ? { ...credentials,
            ...(credentials.peer ? { peer: { ...credentials.peer, device: { ...credentials.peer.device } } } : {}) } : null;
    }
    const [, rebind] = React.useState(0);
    const close = React.useRef(onClose); close.current = onClose;
    const closed = React.useRef(false);
    const closeOnce = React.useCallback(() => { if (!closed.current) { closed.current = true; close.current?.(); } }, []);
    const isCurrent = React.useCallback(() => !closed.current && sameScope(captured.current, attachmentPreviewSnapshot(sessionId, refValue, liveRef)), [sessionId, refValue, liveRef]);
    const snapshot: Snapshot = JSON.parse(current);
    const changed = closed.current || scopeChanged(captured.current, snapshot);
    const valid = !changed && sameScope(captured.current, snapshot);
    React.useEffect(() => { if (changed) closeOnce(); }, [changed, closeOnce]);
    React.useEffect(() => { noteNativeImageStage('preview-scope', { reason: changed ? 'scope-changed'
        : !valid && snapshot.reason === 'ready' ? 'awaiting-explicit-retry' : snapshot.reason,
        keyPresent: snapshot.keyPresent, peerMatch: snapshot.peerMatch }); }, [current, valid, changed]);
    const retry = React.useCallback(() => {
        const next = attachmentPreviewSnapshot(sessionId, refValue, liveRef);
        if (closed.current || scopeChanged(captured.current, next)) { closeOnce(); return false; }
        if (!captured.current.authority || !next.key || !expected.current) return false;
        if (captured.current.key === null) {
            captured.current = { ...captured.current, key: next.key, nativeIdentity: captured.current.nativeIdentity ?? next.nativeIdentity };
            rebind(value => value + 1);
        }
        return true;
    }, [sessionId, refValue, liveRef, closeOnce]);
    const assertCurrent = React.useCallback(async () => {
        if (!isCurrent() || !expected.current) {
            if (closed.current || scopeChanged(captured.current, attachmentPreviewSnapshot(sessionId, refValue, liveRef))) {
                closeOnce(); throw Error('Attachment preview source changed');
            }
            throw Error('Attachment preview unavailable');
        }
        try { await currentImageReadCredentials(expected.current); }
        catch { closeOnce(); throw Error('Attachment preview source changed'); }
        if (!isCurrent()) { closeOnce(); throw Error('Attachment preview source changed'); }
    }, [isCurrent, closeOnce, sessionId, refValue, liveRef]);
    return { valid, changed, retry, isCurrent, assertCurrent };
}
