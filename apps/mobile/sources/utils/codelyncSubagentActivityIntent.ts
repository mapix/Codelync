import type { Session } from '../sync/storageTypes';
import type { CodelyncOperationSource } from './codelyncOperationLog';
import { isCodelyncSessionSource } from './codelyncSourceScope';

type Intent = { revision: number; app: string; nativeConversationId: string; hostId: string; ownerGeneration: string | null };
const intents = new Map<string, Intent>(), listeners = new Set<() => void>();
const latest = new Map<string, Set<() => void>>();
let revision = 0;

/** A navigation hint only; it never sends or recovers a source command. */
export function requestCodelyncSubagentActivity(session: Session): boolean {
    const source = session.metadata?.bridge?.source;
    if (!isCodelyncSessionSource(source, session.metadata?.bridge?.controlMode) || !source?.id || !source.hostId) return false;
    intents.set(session.id, { revision: ++revision, app: source.app, nativeConversationId: source.id, hostId: source.hostId,
        ownerGeneration: source.runtimeGeneration || null });
    for (const listener of listeners) listener();
    return true;
}
export const subscribeCodelyncSubagentActivity = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getCodelyncSubagentActivity = (sessionId: string) => intents.get(sessionId) ?? null;
export function consumeCodelyncSubagentActivity(source: CodelyncOperationSource, expected: Intent): boolean {
    if (intents.get(source.sessionId) !== expected) return false;
    intents.delete(source.sessionId);
    return expected.app === source.app && expected.nativeConversationId === source.nativeConversationId && expected.hostId === source.hostId
        && (!expected.ownerGeneration || expected.ownerGeneration === source.ownerGeneration);
}
export function subscribeCodelyncLatestViewport(sessionId: string, handler: () => void) {
    let handlers = latest.get(sessionId); if (!handlers) { handlers = new Set(); latest.set(sessionId, handlers); }
    handlers.add(handler);
    return () => { handlers.delete(handler); if (!handlers.size) latest.delete(sessionId); };
}
export function requestCodelyncLatestViewport(sessionId: string) { for (const handler of latest.get(sessionId) ?? []) handler(); }
