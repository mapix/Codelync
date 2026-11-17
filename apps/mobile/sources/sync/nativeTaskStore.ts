import type { Session } from './storageTypes';
import { storage } from './storage';
import { apiSocket, getCurrentAppState } from './apiSocket';
import { getServerUrl } from './serverConfig';
import { NativeTaskCache, type NativeTaskCacheContext } from './nativeTaskCache';
import { nativeTaskReader } from './nativeTasksRpc';
import { materializeNativeTaskReply } from './nativeTaskMaterialize';
import { captureCurrentNativeTaskScope, currentNativeTaskSignal, nativeTaskScopesEqual } from '@/utils/codelyncNativeTasks';

export const nativeTaskPeerIdentity = () => apiSocket.peerIdentity() ?? getServerUrl();
export function nativeTaskCacheContext(session: Session | null | undefined): NativeTaskCacheContext | null {
    const scope = captureCurrentNativeTaskScope(session); if (!session || !scope) return null;
    const signal = currentNativeTaskSignal(session);
    return { sessionId: session.id, peerId: nativeTaskPeerIdentity(), scope: { ...scope }, signal,
        desiredDigest: signal?.digest ?? session.agentState?.nativeTasks?.digest ?? null };
}
export const nativeTaskCache = new NativeTaskCache({
    read: (context, since) => nativeTaskReader.tasks(context.sessionId, context.scope, since),
    apply: (baseline, reply) => materializeNativeTaskReply(baseline, reply),
    current: context => {
        const scope = captureCurrentNativeTaskScope(storage.getState().sessions[context.sessionId]);
        return getCurrentAppState() === 'active' && nativeTaskPeerIdentity() === context.peerId && !!scope && nativeTaskScopesEqual(scope, context.scope);
    },
});
/** Passive access only: a missing cache never activates a parent read. */
export function currentNativeTasksSnapshot(session: Session | null | undefined) {
    const context = nativeTaskCacheContext(session); return context ? nativeTaskCache.get(context).native : null;
}
