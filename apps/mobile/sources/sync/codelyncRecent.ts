import type { Session } from './storageTypes';
import { codelyncSavedHistory, NativeSavedHistorySchema, type NativeSavedHistory } from '@/utils/nativeSavedHistory';
import { NativeFileArgumentsSchema, type NativeFileArguments, type NormalizedMessage } from './typesRaw';
import { projectNativeToolInput, type NativeToolInput } from '@codelync/wire/codelync';
import { mergeNativeTasksCatalogState } from '@/utils/nativeTaskCatalogMerge';

export interface PeerSessionDescriptor {
    id: string;
    nativeUpdatedAt: number;
    basicOnly: boolean;
    metadata: Session['metadata'];
    metadataVersion: number;
    agentState: Session['agentState'];
    agentStateVersion: number;
    seq: number;
    createdAt: number;
    active: boolean;
    activeAt: number;
    sessionKey?: string;
}
export interface NativeRecentRow {
    id: string;
    role: 'user' | 'assistant' | 'reasoning' | 'tool';
    turnId: string;
    text: string;
    at: number | null;
    order?: number;
    projectionRevision: number;
    snapshotRevision: number;
    streamRevision: number;
    ownerGeneration: string | null;
    replaceIds: string[];
    replaceSourceRowIds?: string[];
    tools?: { id: string; name: string; output: string; status: string; arguments?: NativeFileArguments | Record<string, unknown>; input?: NativeToolInput; inputUnavailable?: boolean }[];
}
export interface PeerRecentWindow {
    freshness?: { version: 1; mode: 'cached' | 'fresh'; capturedAt: number; ownerGeneration: string | null;
        currentControlAuthority: boolean; revalidationPending: boolean };
    historicalRead?: NativeSavedHistory;
    version: 1;
    session: PeerSessionDescriptor;
    rows: NativeRecentRow[];
    nextCursor: string | null;
    hasMore: boolean;
    ownerGeneration: string | null;
    revision: number | null;
    status: string;
    currentTurnId: string | null;
    seq: number;
    observedAt: number;
}

/** Cache provenance is data scope, never original-owner control authority. */
export function peerRecentIsCached(window: PeerRecentWindow): boolean {
    const value = window.freshness;
    if (value === undefined) return false;
    if (!value || value.version !== 1 || !['cached', 'fresh'].includes(value.mode) || !Number.isFinite(value.capturedAt) || value.capturedAt < 0
        || typeof value.currentControlAuthority !== 'boolean' || typeof value.revalidationPending !== 'boolean'
        || value.ownerGeneration !== window.ownerGeneration || value.ownerGeneration !== null && (typeof value.ownerGeneration !== 'string' || !value.ownerGeneration.trim())) throw Error('Invalid native recent freshness');
    if (value.mode === 'fresh') {
        if (value.revalidationPending) throw Error('Fresh native data cannot remain cache pending');
        if (value.currentControlAuthority && (window.historicalRead || !value.ownerGeneration
            || window.session.metadata?.bridge?.source.runtimeGeneration !== value.ownerGeneration)) throw Error('Fresh native control owner does not match its descriptor');
        return false;
    }
    if (value.currentControlAuthority || !value.revalidationPending || !value.ownerGeneration || window.historicalRead
        || window.session.metadata?.bridge?.source.runtimeGeneration !== value.ownerGeneration) throw Error('Cached native data has no current control authority');
    return true;
}

/** Even a newer retained metadata field cannot lend controls to a cached body. */
export function cachedPeerDescriptorSession(value: PeerSessionDescriptor, previous?: Session, previousIsLive = false): Session {
    if (previousIsLive && previous && previous.metadataVersion >= value.metadataVersion) {
        return { ...peerDescriptorSession(value, previous), metadata: previous.metadata, metadataVersion: previous.metadataVersion,
            agentState: previous.agentState, agentStateVersion: previous.agentStateVersion, active: previous.active, activeAt: previous.activeAt,
            presence: previous.presence, thinking: previous.thinking, updatedAt: Math.max(value.nativeUpdatedAt, previous.updatedAt) };
    }
    // A persisted or already-derived header cannot lend its higher version to
    // response-only readonly controls and then suppress the real fresh header.
    const retained = previous ? { ...previous, metadataVersion: Math.min(previous.metadataVersion, value.metadataVersion),
        agentStateVersion: Math.min(previous.agentStateVersion, value.agentStateVersion) } : undefined;
    const session = peerDescriptorSession(value, retained), metadata = session.metadata;
    if (!metadata?.bridge) throw Error('Cached native source identity is unavailable');
    const retainedRows = session.agentState?.subagents ?? (previous?.metadata?.bridge?.source.runtimeGeneration === metadata.bridge.source.runtimeGeneration ? previous?.agentState?.subagents : undefined);
    return { ...session, active: false, thinking: false, presence: session.activeAt,
        metadata: { ...metadata, bridge: { ...metadata.bridge, sourceStatus: 'owner-unavailable', currentTurnId: null },
            nativeControls: undefined, nativeObservedModel: undefined,
            capabilities: { readOnly: true, steering: false, send: false, abort: false, rpcMethods: ['bridge-receipt'],
                attachments: { enabled: false, maxBytes: 0, mediaTypes: [] }, files: { browse: false, read: false, search: false, write: false },
                modelSelection: false, reasoningSelection: false, permissionModeSelection: false, resume: false, shell: false,
                messageReceipts: metadata.capabilities?.messageReceipts },
            nativeReadFreshness: { version: 1, mode: 'cached', currentControlAuthority: false, ownerGeneration: metadata.bridge.source.runtimeGeneration } },
        agentState: session.agentState ? { ...session.agentState, nativeQuery: undefined, nativeTasks: undefined, nativeTaskSignal: undefined,
            subagentsAvailable: false, subagentsComplete: false,
            subagents: retainedRows?.map(row => ({ ...row, status: 'unknown' })),
            aggregateActivity: session.agentState.aggregateActivity ? { ...session.agentState.aggregateActivity, known: false, active: false, waiting: false, status: 'unknown' } : undefined } : null };
}

/** Peer-sealed catalog fields stay light; runtime activity never comes from recency. */
export function peerDescriptorSession(value: PeerSessionDescriptor, previous?: Session, catalog = false): Session {
    if (!value || typeof value.id !== 'string' || !value.id || !Number.isFinite(value.nativeUpdatedAt) || !value.metadata
        || ![value.metadataVersion, value.agentStateVersion, value.seq].every(number => Number.isSafeInteger(number) && number >= 0)
        || ![value.createdAt, value.activeAt].every(number => Number.isFinite(number) && number >= 0)) throw Error('Invalid native session descriptor');
    const metadataAhead = previous && previous.metadataVersion > value.metadataVersion;
    const stateAhead = previous && previous.agentStateVersion > value.agentStateVersion;
    let metadata = metadataAhead ? previous.metadata : value.basicOnly && previous?.metadata ? { ...previous.metadata, ...value.metadata } : value.metadata;
    if (catalog && value.metadata.nativeSession) {
        // The directory header has its own clock; a later owner metadata version
        // still owns capabilities/generation, but cannot hide this index change.
        metadata = { ...(metadata ?? value.metadata), nativeSession: { ...value.metadata.nativeSession } };
    }
    return { ...previous, id: value.id, createdAt: value.createdAt, updatedAt: value.nativeUpdatedAt,
        seq: Math.max(value.seq, previous?.seq ?? 0), active: value.active === true, activeAt: value.activeAt, presence: value.active ? 'online' : value.activeAt,
        metadata, metadataVersion: metadataAhead ? previous.metadataVersion : value.metadataVersion,
        agentState: mergeNativeTasksCatalogState(metadata, value.basicOnly || stateAhead ? previous?.agentState ?? null : value.agentState, previous,
            catalog || value.basicOnly, !!(value.basicOnly || stateAhead)),
        agentStateVersion: value.basicOnly || stateAhead ? previous?.agentStateVersion ?? 0 : value.agentStateVersion,
        thinking: previous?.thinking ?? false, thinkingAt: previous?.thinkingAt ?? 0 };
}

export function isCurrentNativeRecent(window: PeerRecentWindow, session: Session): boolean {
    if (window.session?.id !== session.id) return false;
    const currentSource = session.metadata?.bridge?.source, incomingSource = window.session.metadata?.bridge?.source;
    if (currentSource && incomingSource && ['app', 'id', 'hostId'].some(field => (currentSource as Record<string, unknown>)[field] !== (incomingSource as Record<string, unknown>)[field])) return false;
    if (window.historicalRead) {
        const incoming = NativeSavedHistorySchema.safeParse(window.historicalRead), header = codelyncSavedHistory({ metadata: window.session.metadata });
        if (!incoming.success || !header || window.ownerGeneration !== null || incoming.data.sourceStamp !== header.sourceStamp
            || incoming.data.namespaceHash !== header.namespaceHash || incoming.data.nativeId !== header.nativeId) return false;
        const current = codelyncSavedHistory(session);
        if (current) return current.sourceStamp === header.sourceStamp && current.namespaceHash === header.namespaceHash;
        return window.session.metadataVersion > session.metadataVersion;
    }
    const currentOwner = session.metadata?.bridge?.source.runtimeGeneration;
    const currentMain = session.metadata?.nativeDesktopRuntimeGeneration ?? session.agentState?.nativeDesktopRuntimeGeneration;
    const incomingMain = window.session.metadata?.nativeDesktopRuntimeGeneration ?? window.session.agentState?.nativeDesktopRuntimeGeneration;
    if (session.metadataVersion > window.session.metadataVersion && currentMain && incomingMain && currentMain !== incomingMain) return false;
    return !(session.metadataVersion > window.session.metadataVersion && currentOwner && window.ownerGeneration && currentOwner !== window.ownerGeneration);
}

/** Each recent native row can render without earlier wire text/tool seeds. */
export function nativeRecentMessages(window: PeerRecentWindow): NormalizedMessage[] {
    if (window.version !== 1 || !Array.isArray(window.rows) || window.rows.length > 100) throw Error('Invalid native recent window');
    const messages: NormalizedMessage[] = [];
    for (const row of window.rows) {
        if (!row || typeof row.id !== 'string' || !row.id || !row.turnId || !Number.isSafeInteger(row.projectionRevision) || row.projectionRevision < 1
            || !Number.isSafeInteger(row.snapshotRevision) || row.snapshotRevision < 1 || !Number.isSafeInteger(row.streamRevision) || row.streamRevision < 0
            || typeof row.text !== 'string' || !Array.isArray(row.replaceIds) || !row.replaceIds.every(id => typeof id === 'string')) throw Error('Invalid native recent row');
        if (window.historicalRead ? row.ownerGeneration !== null : typeof window.ownerGeneration === 'string' && row.ownerGeneration !== window.ownerGeneration) throw Error('Native recent row belongs to another owner');
        // 原 owner 的时间未知时保留索引时间；observedAt 只描述新鲜度，不能伪装成原消息的发送时间。
        const nativeTimestamp = typeof row.at === 'number' && Number.isFinite(row.at) && row.at >= 0 ? row.at : null;
        const createdAt = nativeTimestamp ?? window.session.nativeUpdatedAt;
        const meta = { sentFrom: 'noninvasive-observer', nativeTimestamp, ...(Number.isSafeInteger(row.order) ? { nativeOrder: row.order } : {}) };
        const common = { localId: null, createdAt, isSidechain: false, turn: row.turnId, meta };
        if (row.tools?.length || row.role === 'tool') {
            const tools = (row.tools ?? []).map(({ arguments: args, input, inputUnavailable, ...tool }) => {
                if (tool.name === 'file') return { ...tool, ...(args ? { arguments: NativeFileArgumentsSchema.parse(args) } : {}) };
                const value = input ?? args;
                return { ...tool, ...(value !== undefined ? projectNativeToolInput(value) : inputUnavailable ? { inputUnavailable: true } : {}) };
            });
            messages.push({ ...common, id: `recent-tool:${row.id}:${row.ownerGeneration}:${row.snapshotRevision}`, role: 'event', content: { type: 'native-row-upsert', sourceRowId: row.id, role: 'tool', text: '',
                revision: row.projectionRevision, replaceIds: [], tools, snapshotRevision: row.snapshotRevision, streamRevision: row.streamRevision, ownerGeneration: row.ownerGeneration ?? undefined } });
        }
        if (row.role !== 'tool') {
            const toolOnly = row.role === 'assistant' && row.text.trim().length === 0 && !!row.tools?.length;
            messages.push({ ...common, id: `recent-row:${row.id}:${row.ownerGeneration}:${row.snapshotRevision}`, role: 'event', content: { type: 'native-row-upsert', sourceRowId: row.id, role: row.role,
                text: row.text, revision: row.projectionRevision, replaceIds: toolOnly ? [] : row.replaceIds, ...(!toolOnly && row.replaceSourceRowIds ? { replaceSourceRowIds: row.replaceSourceRowIds } : {}), snapshotRevision: row.snapshotRevision, streamRevision: row.streamRevision, ownerGeneration: row.ownerGeneration ?? undefined } });
        }
    }
    return messages;
}
