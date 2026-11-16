import type { Session } from '@/sync/storageTypes';
import { NativeTasksSchema, NativeTaskSignalSchema, type NativeTask, type NativeTasks, type NativeTaskScope, type NativeTaskSignal } from '@/sync/nativeTasks';
import { isCodeLightSessionIdentity, isCodeLightSessionSource } from './codeLightSourceScope';
import { readNativeQuery } from './nativeQuery';
import { nativeTaskScopesEqual as sharedNativeTaskScopesEqual } from '@slopus/happy-wire/native-tasks';

type Parent = Pick<Session, 'id' | 'metadata' | 'agentState'> | null | undefined;
export type CodeLightNativeTasksView = { present: boolean; available: boolean; complete: boolean; truncated: boolean;
    rows: NativeTask[]; native: NativeTasks | null; signal: NativeTaskSignal | null; count: number | null; countComplete: boolean };
export function nativeTaskScopesEqual(a: NativeTaskScope, b: NativeTaskScope): boolean {
    return sharedNativeTaskScopesEqual(a, b);
}
function scopeCurrent(parent: Parent, scope: NativeTaskScope): boolean {
    const metadata = parent?.metadata, bridge = metadata?.bridge, source = bridge?.source;
    const query = readNativeQuery(metadata, parent?.agentState?.nativeQuery);
    return metadata?.client?.id === 'noninvasive-bridge' && source?.app === scope.app && bridge?.sourceStatus === 'connected'
        && isCodeLightSessionSource(source, bridge.controlMode) && scope.nativeCollection === source.nativeCollection
        && scope.hostId === source.hostId && scope.parentConversationId === source.id && scope.ownerGeneration === source.runtimeGeneration
        && !!query && query.queryToken === scope.queryToken;
}
export function currentNativeTaskSignal(parent: Parent): NativeTaskSignal | null {
    const parsed = NativeTaskSignalSchema.safeParse(parent?.agentState?.nativeTaskSignal);
    return parsed.success && scopeCurrent(parent, parsed.data.scope) ? parsed.data : null;
}
export function projectCodeLightNativeTasks(parent: Parent, snapshot?: NativeTasks | null): CodeLightNativeTasksView {
    const metadata = parent?.metadata, bridge = metadata?.bridge, source = bridge?.source;
    const present = metadata?.client?.id === 'noninvasive-bridge' && source?.app === 'claude-desktop'
        && isCodeLightSessionIdentity(source, bridge?.controlMode);
    const signal = currentNativeTaskSignal(parent), signaled = !!parent?.agentState && Object.hasOwn(parent.agentState, 'nativeTaskSignal');
    const empty = { present, available: false, complete: false, truncated: signal?.tasksTruncated ?? false, rows: [], native: null, signal,
        count: signal?.tasksAvailable ? signal.taskCount : null, countComplete: !!signal?.tasksAvailable && signal.tasksComplete && !signal.partial && !signal.tasksTruncated };
    if (!present || !source) return empty;
    const parsed = NativeTasksSchema.safeParse(snapshot === undefined ? signaled ? null : parent?.agentState?.nativeTasks : snapshot);
    if (!parsed.success) return empty;
    const native = parsed.data, scope = native.scope;
    if (scope.app !== source.app || scope.nativeCollection !== source.nativeCollection || scope.hostId !== source.hostId
        || scope.parentConversationId !== source.id) return empty;
    if (signaled && (!signal || native.digest !== signal.digest || !nativeTaskScopesEqual(scope, signal.scope))) return empty;
    const current = scopeCurrent(parent, scope);
    const seen = new Set<string>();
    const duplicate = native.tasks.some(row => { const exists = seen.has(row.nativeTaskId); seen.add(row.nativeTaskId); return exists; });
    const available = current && native.tasksAvailable && !duplicate;
    const rows = native.tasks.filter((row, index) => native.tasks.findIndex(other => other.nativeTaskId === row.nativeTaskId) === index)
        .map(row => ({ ...row, status: available ? row.status : 'unknown' as const }));
    return { present, native, signal, available, complete: available && native.tasksComplete && !native.partial && !native.tasksTruncated,
        truncated: native.tasksTruncated, rows, count: signal?.tasksAvailable ? signal.taskCount : available ? rows.length : null,
        countComplete: signaled ? empty.countComplete : available && native.tasksComplete && !native.partial && !native.tasksTruncated };
}

/** Immutable native scope only. Neither task output nor a mutation target is captured. */
export function captureCurrentNativeTaskScope(parent: Parent): NativeTaskScope | null {
    if (parent?.agentState && Object.hasOwn(parent.agentState, 'nativeTaskSignal')) return currentNativeTaskSignal(parent)?.scope ?? null;
    const scope = projectCodeLightNativeTasks(parent).native?.scope;
    return scope && scopeCurrent(parent, scope) ? { ...scope } : null;
}
