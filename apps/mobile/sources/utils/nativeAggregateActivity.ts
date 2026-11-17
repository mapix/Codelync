import type { Session } from '@/sync/storageTypes';
import { NativeAggregateActivitySchema, type NativeAggregateActivity } from '@/sync/nativeSubagents';
import { isCodelyncSessionSource } from './codelyncSourceScope';

/** Attention state is trusted only for this current native parent owner. It
 * never supplies a turn ID or changes a parent command target. */
export function currentNativeAggregate(session: Session): NativeAggregateActivity | null {
    const source = session.metadata?.bridge?.source, parsed = NativeAggregateActivitySchema.safeParse(session.agentState?.aggregateActivity);
    if (!source || session.metadata?.client?.id !== 'noninvasive-bridge' || session.metadata?.bridge?.controlMode !== 'session'
        || !isCodelyncSessionSource(source, session.metadata.bridge.controlMode) || typeof source.runtimeGeneration !== 'string' || !source.runtimeGeneration.trim()
        || session.metadata?.bridge?.sourceStatus !== 'connected' || !parsed.success) return null;
    const value = parsed.data;
    return value.app === source.app && value.parentConversationId === source.id && value.hostId === source.hostId &&
        value.ownerGeneration === source.runtimeGeneration ? value : null;
}
