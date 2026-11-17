import type { Session } from '../sync/storageTypes';
import { NativeAggregateActivitySchema, NativeSubagentSchema, type NativeSubagent, type NativeSubagentStatus } from '../sync/nativeSubagents';
import { isCodelyncNativeSession } from './codelyncSessionBrowser';
import { isCodelyncSessionIdentity, isCodelyncSessionSource } from './codelyncSourceScope';
import { captureCurrentNativeTaskScope, projectCodelyncNativeTasks } from './codelyncNativeTasks';
import type { NativeTasks } from '@/sync/nativeTasks';

export type CodelyncSubagentRow = NativeSubagent & { status: NativeSubagentStatus; targetSessionId: string | null };
export type CodelyncSubagentView = { present: boolean; available: boolean; truncated: boolean; complete: boolean; rows: CodelyncSubagentRow[];
    count?: number | null; countComplete?: boolean; loading?: boolean; failed?: boolean };
export type CodelyncSubagentFilter = 'all' | 'in-progress' | 'finished' | 'unknown';
type Parent = Pick<Session, 'id' | 'metadata' | 'agentState'> | null;

/** Explicit original membership only. A parentId/fork or a title never qualifies. */
export function projectCodelyncSubagents(parent: Parent, catalog: Session[] = [], supplied?: unknown, snapshot?: NativeTasks | null): CodelyncSubagentView {
    const metadata = parent?.metadata, bridge = metadata?.bridge, source = bridge?.source;
    const present = metadata?.client?.id === 'noninvasive-bridge' && bridge?.controlMode === 'session'
        && !!source?.id && !!source.hostId && isCodelyncSessionIdentity(source, bridge.controlMode);
    const taskView = source?.app === 'claude-desktop' && supplied === undefined ? projectCodelyncNativeTasks(parent, snapshot) : null;
    const tasks = taskView?.native ?? null, signal = taskView?.signal;
    const truncated = tasks ? tasks.dispatchChildrenTruncated : parent?.agentState?.subagentsTruncated === true;
    if (!present || !source) return { present: false, available: false, truncated, complete: false, rows: [] };
    if (source.app === 'claude-desktop' && supplied === undefined && parent?.agentState && Object.hasOwn(parent.agentState, 'nativeTaskSignal') && !tasks) {
        return { present: true, available: false, complete: false, rows: [], truncated: signal?.dispatchChildrenTruncated ?? false,
            count: signal?.dispatchChildrenAvailable ? signal.dispatchChildCount : null,
            countComplete: !!signal?.dispatchChildrenAvailable && signal.dispatchChildrenComplete && !signal.dispatchChildrenTruncated };
    }
    const raw: unknown = tasks ? tasks.dispatchChildren.map(row => ({ ...row, id: row.nativeConversationId, app: tasks.scope.app,
        relationship: 'native-subagent', runtimeGeneration: tasks.scope.runtimeGeneration, parentConversationId: tasks.scope.parentConversationId,
        parentHostId: tasks.scope.hostId, parentNativeCollection: tasks.scope.nativeCollection, parentOwnerGeneration: tasks.scope.ownerGeneration }))
        : supplied === undefined ? parent?.agentState?.subagents : supplied;
    if (!Array.isArray(raw) || raw.length > 256) return { present: true, available: false, truncated, complete: false, rows: [], count: null, countComplete: false };

    let available = bridge.sourceStatus === 'connected' && isCodelyncSessionSource(source, bridge.controlMode)
        && typeof source.runtimeGeneration === 'string' && !!source.runtimeGeneration.trim()
        && (tasks ? tasks.dispatchChildrenAvailable && captureCurrentNativeTaskScope(parent) !== null
            : source.app === 'claude-desktop' ? parent?.agentState?.subagentsAvailable === true : parent?.agentState?.subagentsAvailable !== false);
    const ids = new Set<string>(), duplicates = new Set<string>();
    const native: NativeSubagent[] = [];
    for (const value of raw) {
        const parsed = NativeSubagentSchema.safeParse(value);
        if (!parsed.success) { available = false; continue; }
        const row = parsed.data;
        if (row.nativeConversationId === source.id || row.parentConversationId !== source.id || row.app !== source.app || (source.app === 'claude-desktop'
            ? row.parentHostId !== source.hostId || row.parentNativeCollection !== source.nativeCollection : row.hostId !== source.hostId)) { available = false; continue; }
        if (ids.has(row.id)) duplicates.add(row.id);
        else { ids.add(row.id); native.push(row); }
        if ((source.app === 'claude-desktop' ? row.parentOwnerGeneration : row.ownerGeneration) !== source.runtimeGeneration) available = false;
    }
    if (duplicates.size) available = false;

    const targets = new Map<string, string | null>();
    for (const row of native) for (const candidate of catalog) {
        const child = candidate.metadata?.bridge?.source;
        if (typeof metadata?.machineId !== 'string' || !metadata.machineId || candidate.id === parent?.id || !isCodelyncNativeSession(candidate) || candidate.metadata?.machineId !== metadata.machineId
            || child?.app !== source.app || child.id !== row.nativeConversationId || child.hostId !== row.hostId
            || source.app === 'claude-desktop' && (child.nativeCollection !== row.nativeCollection || child.runtimeGeneration !== row.ownerGeneration)) continue;
        targets.set(row.id, targets.has(row.id) ? null : candidate.id);
    }
    const aggregate = (parent?.agentState as unknown as { aggregateActivity?: Record<string, unknown> } | null)?.aggregateActivity;
    const total = parent?.agentState?.subagentsTotal;
    const nativeTotal = source.app === 'antigravity' && available && parent?.agentState?.subagentsAvailable === true && Number.isSafeInteger(total)
        && typeof total === 'number' && total >= native.length && total <= 20000 ? total : null;
    const aggregateCount = source.app === 'antigravity' ? nativeTotal : native.length;
    const aggregateMatches = !aggregate || aggregate.version === 1 && aggregate.rosterAvailable === true && aggregate.rosterComplete === true
        && aggregate.childCount === aggregateCount && aggregate.app === source.app && aggregate.hostId === source.hostId
        && aggregate.ownerGeneration === source.runtimeGeneration && aggregate.parentConversationId === source.id;
    const nativeCountComplete = source.app === 'antigravity' && available && nativeTotal !== null && !!aggregate
        && aggregateMatches && NativeAggregateActivitySchema.safeParse(aggregate).success;
    const complete = available && !truncated && (tasks ? tasks.dispatchChildrenComplete : parent?.agentState?.subagentsComplete === true) && aggregateMatches
        && (source.app !== 'antigravity' || nativeCountComplete && nativeTotal === native.length);
    return { present: true, available, truncated, complete, count: source.app === 'antigravity' ? nativeTotal
        : signal?.dispatchChildrenAvailable ? signal.dispatchChildCount : available ? native.length : null,
        countComplete: source.app === 'antigravity' ? nativeCountComplete : signal ? signal.dispatchChildrenAvailable && signal.dispatchChildrenComplete && !signal.dispatchChildrenTruncated : complete,
        rows: native.map(row => ({ ...row, status: available ? row.status : 'unknown',
        targetSessionId: duplicates.has(row.id) ? null : targets.get(row.id) ?? null })) };
}

export function filterCodelyncSubagents(rows: CodelyncSubagentRow[], filter: CodelyncSubagentFilter): CodelyncSubagentRow[] {
    if (filter === 'all') return rows;
    return rows.filter(row => filter === 'unknown' ? row.status === 'unknown' : filter === 'in-progress'
        ? ['pending', 'running', 'waiting', 'idle'].includes(row.status) : ['stopped', 'completed', 'failed'].includes(row.status));
}

/** Native catalog evidence can establish the reverse link before a parent roster is loaded. */
export function codelyncSubagentParent(child: Session, catalog: Session[], snapshotForParent?: (session: Session) => NativeTasks | null): Session | null {
    const source = child.metadata?.bridge?.source, parentId = child.metadata?.nativeSession?.parentId;
    const machineId = child.metadata?.machineId;
    if (!source || !parentId || typeof machineId !== 'string' || !machineId || !isCodelyncNativeSession(child)) return null;
    const nativeChild = child.metadata?.nativeSession?.isSubagent === true;
    const matches = catalog.filter(parent => {
        const parentSource = parent.metadata?.bridge?.source;
        if (parent.id === child.id || !isCodelyncNativeSession(parent) || parent.metadata?.machineId !== machineId
            || parentSource?.app !== source.app || parentSource.id !== parentId) return false;
        const provenRow = projectCodelyncSubagents(parent, [child], undefined, snapshotForParent?.(parent)).rows.some(row => row.nativeConversationId === source.id && row.targetSessionId === child.id);
        return source.app === 'claude-desktop' ? provenRow || nativeChild && parentSource.hostId === source.hostId && parentSource.nativeCollection === source.nativeCollection
            : parentSource.hostId === source.hostId && (nativeChild || provenRow);
    });
    return matches.length === 1 ? matches[0] : null;
}
