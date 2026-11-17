import type { Session } from '../sync/storageTypes';
import type { BridgeRpcTrace } from '../sync/noninvasiveRpcJournal';
import { isCodelyncSessionSource } from './codelyncSourceScope';

export type CodelyncOperationSource = { sessionId: string; app: 'codex' | 'antigravity' | 'claude-desktop'; nativeConversationId: string; hostId: string; ownerGeneration: string };
export type CodelyncOperationTrace = BridgeRpcTrace & { authority: string; entityId: string; method: string; source: CodelyncOperationSource };
export type CodelyncOperationStatus = 'confirmed' | 'failed' | 'not-sent' | 'unknown' | 'pending';
export type CodelyncOperationRow = { commandId: string; method: string; at: number; status: CodelyncOperationStatus; source: CodelyncOperationSource; historicalOwner: boolean };

export function codelyncOperationSource(session: Session | null | undefined): CodelyncOperationSource | null {
    const bridge = session?.metadata?.bridge, source = bridge?.source;
    if (!session || session.metadata?.client?.id !== 'noninvasive-bridge' || bridge?.controlMode !== 'session' || !isCodelyncSessionSource(source, bridge?.controlMode)
        || typeof source?.runtimeGeneration !== 'string' || !source.runtimeGeneration.trim() || !source.id || !source.hostId) return null;
    return { sessionId: session.id, app: source.app as CodelyncOperationSource['app'], nativeConversationId: source.id,
        hostId: source.hostId, ownerGeneration: source.runtimeGeneration };
}

/** Only attributable content-free events are returned; no pending parameters are read. */
export function readCodelyncOperationTrace(value: unknown, authority: string, sessionId: string): CodelyncOperationTrace | null {
    if (!value || typeof value !== 'object') return null;
    const event = value as Record<string, any>, source = event.source;
    if (event.authority !== authority || typeof event.entityId !== 'string' || event.entityId.length > 512 || !source || source.sessionId !== sessionId
        || !['codex', 'antigravity', 'claude-desktop'].includes(source.app) || ![source.nativeConversationId, source.hostId, source.ownerGeneration].every(value => typeof value === 'string' && value.length > 0 && value.length <= 2048)
        || !['dispatch', 'transport-error', 'receipt-query', 'unconfirmed', 'confirmed', 'not-sent'].includes(event.stage)
        || typeof event.commandId !== 'string' || !event.commandId || event.commandId.length > 512 || !Number.isFinite(event.at)
        || typeof event.method !== 'string' || !event.method || event.method.length > 64) return null;
    return { stage: event.stage, commandId: event.commandId, at: event.at, authority, entityId: event.entityId, method: event.method,
        source: { sessionId, app: source.app, nativeConversationId: source.nativeConversationId, hostId: source.hostId, ownerGeneration: source.ownerGeneration },
        ...(['complete', 'failed', 'running', 'unknown'].includes(event.status) ? { status: event.status } : {}) };
}

export function projectCodelyncOperationLog(events: CodelyncOperationTrace[], source: CodelyncOperationSource): CodelyncOperationRow[] {
    const rows = new Map<string, CodelyncOperationRow>();
    for (const event of events) {
        if (event.source.sessionId !== source.sessionId || event.source.app !== source.app || event.source.nativeConversationId !== source.nativeConversationId || event.source.hostId !== source.hostId) continue;
        const previous = rows.get(event.commandId);
        const status: CodelyncOperationStatus = event.stage === 'confirmed' ? event.status === 'failed' ? 'failed' : event.status === 'complete' ? 'confirmed' : 'unknown'
            : event.stage === 'not-sent' ? 'not-sent' : event.stage === 'unconfirmed' || event.stage === 'transport-error' ? 'unknown' : previous?.status ?? 'pending';
        rows.set(event.commandId, { commandId: event.commandId, method: event.method, at: event.at, status,
            source: event.source, historicalOwner: event.source.ownerGeneration !== source.ownerGeneration });
    }
    return [...rows.values()].sort((a, b) => b.at - a.at).slice(0, 64);
}
