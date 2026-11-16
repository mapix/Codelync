import type { Session } from '@/sync/storageTypes';
import { NativeQuerySchema } from './nativeQuery';
import { NativeTaskSignalSchema, NativeTasksSchema } from '@/sync/nativeTasks';
import { isCodeLightSessionIdentity } from './codeLightSourceScope';

/** A lightweight catalog omits selected-parent task rows. Preserve only its
 * exact prior source/owner/query envelope; omission is not an empty roster. */
export function mergeNativeTasksCatalogState(metadata: Session['metadata'], state: Session['agentState'], previous: Session | undefined,
    directory: boolean, stateInherited = false): Session['agentState'] {
    if (!directory && !stateInherited) return state;
    let result = state;
    for (const field of ['nativeTasks', 'nativeTaskSignal'] as const) {
        const parsed = field === 'nativeTasks' ? NativeTasksSchema.safeParse(previous?.agentState?.[field]) : NativeTaskSignalSchema.safeParse(previous?.agentState?.[field]);
        if (!parsed.success || !stateInherited && state && Object.hasOwn(state, field)) continue;
        const source = metadata?.bridge?.source, scope = parsed.data.scope;
        const sameSource = metadata?.client?.id === 'noninvasive-bridge' && typeof metadata.machineId === 'string' && !!metadata.machineId.trim()
            && isCodeLightSessionIdentity(source, metadata?.bridge?.controlMode) && metadata.machineId === previous?.metadata?.machineId
            && source?.app === scope.app && source.nativeCollection === scope.nativeCollection && source.hostId === scope.hostId
            && source.id === scope.parentConversationId && source.runtimeGeneration === scope.ownerGeneration;
        const query = NativeQuerySchema.safeParse(state?.nativeQuery);
        const sameQuery = !query.success ? state?.nativeQuery === undefined : query.data.app === scope.app && query.data.nativeConversationId === scope.parentConversationId
            && query.data.hostId === scope.hostId && query.data.ownerGeneration === scope.ownerGeneration && query.data.queryToken === scope.queryToken;
        if (sameSource && sameQuery) result = { ...result, [field]: parsed.data };
        else if (result && Object.hasOwn(result, field)) { const next = { ...result }; delete next[field]; result = next; }
    }
    return result;
}
