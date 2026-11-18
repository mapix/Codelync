import type { NormalizedMessage } from '../typesRaw';
import type { ReducerState } from './reducer';

const EMPTY_IDS: string[] = [];
const EMPTY_REPLACEMENTS = { wireIds: EMPTY_IDS, sourceIds: EMPTY_IDS };

/** A consumed provisional alias cannot be claimed by another full native row. */
function ownedReplacements(state: ReducerState, sourceId: string, wireIds: string[], sourceIds: string[]) {
    if (wireIds.length === 0 && sourceIds.length === 0) return EMPTY_REPLACEMENTS;
    let direct: Set<string> | null = null;
    if (sourceIds.length > 0) {
        for (const id of sourceIds) {
            if (id !== sourceId && !state.nativeRetiredRowIds.has(id)) {
                (direct ??= new Set()).add(id);
            }
        }
    }
    const canClaim = (mapped: string | undefined) => {
        if (!mapped) return true;
        const row = state.messages.get(mapped);
        if (row?.tool) return false;
        const owner = row?.meta?.nativeRow?.id;
        if (owner) return owner === sourceId || (direct !== null && direct.has(owner));
        // Missing payloads still retain identity mappings; they are not free aliases.
        for (const [id, target] of state.nativeRowIds) {
            if (target === mapped && id !== sourceId && !state.nativeRetiredRowIds.has(id) && !(direct !== null && direct.has(id))) {
                return false;
            }
        }
        return true;
    };
    let claimedWireIds = EMPTY_IDS;
    if (wireIds.length > 0) {
        claimedWireIds = [];
        for (const id of wireIds) {
            if (!canClaim(state.messageIds.get(id))) continue;
            let allowed = true;
            for (const row of state.messages.values()) {
                if (row.realID === id && !canClaim(row.id)) {
                    allowed = false;
                    break;
                }
            }
            if (allowed) claimedWireIds.push(id);
        }
    }
    let claimedSourceIds = EMPTY_IDS;
    if (direct !== null) {
        claimedSourceIds = [];
        for (const id of direct) {
            if (canClaim(state.nativeRowIds.get(id))) claimedSourceIds.push(id);
        }
    }
    return { wireIds: claimedWireIds, sourceIds: claimedSourceIds };
}

function canonicalIdFor(state: ReducerState, sourceId: string) {
    const base = `native:${sourceId}`;
    let id = base, suffix = 0;
    while (state.messages.has(id) && state.messages.get(id)?.meta?.nativeRow?.id !== sourceId) id = `${base}:identity:${++suffix}`;
    return id;
}

/** Superseded native identities are authoritative aliases, not text-based deduplication. */
function bindReplacements(state: ReducerState, sourceId: string, wireIds: string[], sourceIds: string[], target: string, changed: Set<string>, removed: string[], replacedRows: string[] = EMPTY_IDS) {
    if (wireIds.length === 0 && sourceIds.length === 0 && replacedRows.length === 0) return;
    const replaced = wireIds.length > 0 ? new Set(wireIds) : null;
    const aliases = new Set<string>(replacedRows);
    for (const id of wireIds) { const mapped = state.messageIds.get(id); if (mapped) aliases.add(mapped); }
    for (const id of sourceIds) { const mapped = state.nativeRowIds.get(id); if (mapped) aliases.add(mapped); }
    if (replaced) {
        for (const row of state.messages.values()) {
            if (!row.tool && row.realID && replaced.has(row.realID)) aliases.add(row.id);
        }
    }
    aliases.delete(target);
    if (aliases.size > 0) {
        const targetRow = state.messages.get(target);
        if (targetRow?.role === 'user' && replaced) {
            let acceptedInput: ReturnType<ReducerState['messages']['get']>;
            for (const id of aliases) {
                const row = state.messages.get(id);
                if (row?.role === 'user' && row.meta?.sentFrom !== 'noninvasive-observer'
                    && (replaced.has(row.realID ?? '') || replaced.has(row.localId ?? ''))) {
                    acceptedInput = row;
                    break;
                }
            }
            if (acceptedInput) {
                state.messages.set(target, { ...targetRow, createdAt: acceptedInput.createdAt, localId: acceptedInput.localId ?? targetRow.localId,
                    meta: { ...targetRow.meta, ...acceptedInput.meta, nativeRow: targetRow.meta?.nativeRow, nativeTimestamp: targetRow.meta?.nativeTimestamp }, pending: false, deliveryUnconfirmed: false, nativeAdmission: undefined, sendError: undefined, sortAt: acceptedInput.createdAt });
                changed.add(target);
            }
        }
        for (const id of aliases) { state.messages.delete(id); changed.delete(id); if (!removed.includes(id)) removed.push(id); }
        for (const [id, mapped] of state.messageIds) if (aliases.has(mapped)) state.messageIds.set(id, target);
        for (const [id, mapped] of state.localIds) if (aliases.has(mapped)) state.localIds.set(id, target);
        for (const [id, mapped] of state.nativeRowIds) if (aliases.has(mapped) && (id === sourceId || sourceIds.includes(id))) {
            state.nativeRowIds.set(id, target); if (id !== sourceId) state.nativeRetiredRowIds.add(id);
        }
    }
    for (const id of wireIds) state.messageIds.set(id, target);
    for (const id of sourceIds) { state.nativeRowIds.set(id, target); if (id !== sourceId) state.nativeRetiredRowIds.add(id); }
}

/** 原 owner 的修订只替换明确的片段身份；内容相同不代表同一消息。 */
export function applyNativeProjection(state: ReducerState, messages: NormalizedMessage[], changed: Set<string>) {
    const removed: string[] = [];
    let updates: NormalizedMessage[] | null = null;
    let passthrough: NormalizedMessage[] | null = null;
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const isUpsert = message.role === 'event' && message.content.type === 'native-row-upsert';
        const isNativeFragment = !isUpsert && !!message.meta?.nativeRow;
        if (isUpsert) (updates ??= []).push(message);
        if (isUpsert || isNativeFragment) {
            if (!passthrough) passthrough = messages.slice(0, i);
        } else if (passthrough) {
            passthrough.push(message);
        }
    }
    if (updates) for (const message of updates) {
        if (message.role !== 'event' || message.content.type !== 'native-row-upsert') continue;
        const update = message.content;
        if (update.tools?.length) {
            for (const tool of update.tools ?? []) {
                const key = `tool:${tool.id}`;
                if (update.snapshotRevision !== undefined) {
                    const id = state.toolIdToMessageId.get(tool.id) ?? `native-tool:${tool.id}`, existing = state.messages.get(id);
                    const owner = update.ownerGeneration ?? 'unknown', priorOwner = state.nativeSnapshotOwners.get(key);
                    if (priorOwner !== owner) { state.nativeSnapshotOwners.set(key, owner); if (priorOwner !== undefined) state.nativeRevisions.delete(key); }
                    const seedKey = JSON.stringify(['tool-snapshot', owner, tool.id]);
                    const streamAhead = (state.nativeRevisions.get(key) ?? 0) > (update.streamRevision ?? 0);
                    if ((state.nativeRevisions.get(seedKey) ?? 0) >= update.snapshotRevision || streamAhead && existing?.tool) continue;
                    state.nativeRevisions.set(seedKey, update.snapshotRevision);
                    if ((update.streamRevision ?? 0) > 0) state.nativeRevisions.set(key, Math.max(update.streamRevision!, state.nativeRevisions.get(key) ?? 0));
                    const completed = ['completed', 'failed', 'cancelled', 'interrupted', 'error'].includes(tool.status);
                    // 旧 running seed 不能触发通用 tool-start 的“审批占位→运行”分支，把真实终态重新打开。
                    if (!completed && existing?.tool?.state !== undefined && existing.tool.state !== 'running' && existing.tool.startedAt !== null) continue;
                    state.messages.set(id, { ...existing, id, realID: message.id, role: 'agent', createdAt: existing?.createdAt ?? message.createdAt, text: null, event: null, meta: message.meta, turn: message.turn,
                        tool: { ...existing?.tool, callId: tool.id, name: tool.name || existing?.tool?.name || 'Tool', input: tool.arguments ?? tool.input ?? existing?.tool?.input ?? {},
                            createdAt: existing?.tool?.createdAt ?? message.createdAt, startedAt: existing?.tool?.startedAt ?? message.createdAt,
                            completedAt: completed ? existing?.tool?.completedAt ?? null : null, description: existing?.tool?.description ?? tool.name ?? '',
                            state: completed ? tool.status === 'completed' ? 'completed' : 'error' : 'running',
                            result: streamAhead ? state.nativeToolUpdates.get(tool.id) ?? tool.output : tool.output } });
                    state.toolIdToMessageId.set(tool.id, id); state.messageIds.set(message.id, id); changed.add(id);
                    continue;
                }
                if ((state.nativeRevisions.get(key) ?? 0) >= update.revision) continue;
                state.nativeRevisions.set(key, update.revision);
                const id = state.toolIdToMessageId.get(tool.id), existing = id ? state.messages.get(id) : undefined;
                if (tool.name !== 'file' && tool.input && existing?.tool) {
                    state.messages.set(existing.id, { ...existing, tool: { ...existing.tool, input: tool.input } }); changed.add(existing.id);
                }
                if (tool.name === 'file' && tool.arguments && existing?.tool) {
                    // 旧图片读取失败后成功补读仍属于同一原生 item，更新参数而非新建第二条工具消息。
                    state.messages.set(existing.id, { ...existing, tool: { ...existing.tool, name: tool.name, input: tool.arguments, result: tool.output,
                        state: tool.status === 'completed' ? 'completed' : 'error' } });
                    changed.add(existing.id);
                }
                state.nativeToolUpdates.set(tool.id, tool.output);
            }
        }
        if (update.role === 'tool') continue;
        if (state.nativeRetiredRowIds.has(update.sourceRowId)) continue;
        const mappedCanonical = state.nativeRowIds.get(update.sourceRowId), mappedRow = mappedCanonical ? state.messages.get(mappedCanonical) : undefined;
        const currentCanonical = mappedRow?.meta?.nativeRow?.id === update.sourceRowId && !mappedRow.tool ? mappedCanonical : undefined;
        const toolOnly = update.role === 'assistant' && update.text.trim().length === 0 && !!update.tools?.length;
        const replacements = ownedReplacements(state, update.sourceRowId, toolOnly ? [] : update.replaceIds,
            toolOnly ? [] : update.replaceSourceRowIds ?? []);
        // 正文已经由快照播种时，较早/同版本 wire 的替换关联仍需生效，不能留下临时 steering 气泡。
        if (currentCanonical) bindReplacements(state, update.sourceRowId, replacements.wireIds, replacements.sourceIds, currentCanonical, changed, removed);
        if (update.snapshotRevision !== undefined) {
            const owner = update.ownerGeneration ?? 'unknown';
            const priorOwner = state.nativeSnapshotOwners.get(update.sourceRowId);
            if (priorOwner !== owner) {
                state.nativeSnapshotOwners.set(update.sourceRowId, owner);
                if (priorOwner !== undefined) state.nativeRevisions.delete(update.sourceRowId);
            }
            const key = JSON.stringify(['snapshot', owner, update.sourceRowId]);
            const knownSnapshot = state.nativeRevisions.get(key) ?? 0;
            const missingPayload = !currentCanonical || mappedRow?.text == null || mappedRow.text.trim().length === 0 && update.text.trim().length > 0;
            if (knownSnapshot > update.snapshotRevision || knownSnapshot === update.snapshotRevision && !missingPayload
                || (state.nativeRevisions.get(update.sourceRowId) ?? 0) > (update.streamRevision ?? 0)) continue;
            // 快照版本与流式 entry.revision 分属两个 owner；较大的快照版本不能压住后来的第1次文本修订。
            state.nativeRevisions.set(key, update.snapshotRevision);
            if ((update.streamRevision ?? 0) > 0) state.nativeRevisions.set(update.sourceRowId, update.streamRevision!);
        } else {
            if ((state.nativeRevisions.get(update.sourceRowId) ?? 0) >= update.revision) continue;
            state.nativeRevisions.set(update.sourceRowId, update.revision);
        }
        let existing: Array<NonNullable<ReturnType<ReducerState['messages']['get']>>>;
        let replaced: Set<string> | null = null;
        if (replacements.wireIds.length === 0 && replacements.sourceIds.length === 0) {
            existing = currentCanonical && mappedRow ? [mappedRow] : [];
        } else {
            replaced = replacements.wireIds.length > 0 ? new Set(replacements.wireIds) : null;
            const aliases = new Set<string>();
            if (currentCanonical) aliases.add(currentCanonical);
            for (const id of replacements.wireIds) { const mapped = state.messageIds.get(id); if (mapped) aliases.add(mapped); }
            for (const id of replacements.sourceIds) { const mapped = state.nativeRowIds.get(id); if (mapped) aliases.add(mapped); }
            // 最近窗口会改变 realID；必须沿原生身份与旧 wire 别名找回同一显示行。
            existing = [];
            if (replaced) {
                for (const row of state.messages.values()) {
                    if (!row.tool && (aliases.has(row.id) || (!!row.realID && replaced.has(row.realID)))) existing.push(row);
                }
            } else {
                for (const id of aliases) {
                    const row = state.messages.get(id);
                    if (row && !row.tool) existing.push(row);
                }
            }
            if (existing.length > 1) existing.sort((a, b) => a.createdAt - b.createdAt);
        }
        const first = existing[0];
        const internalId = first?.id ?? canonicalIdFor(state, update.sourceRowId);
        const acceptedInput = update.role === 'user' && first?.role === 'user' && first.meta?.sentFrom !== 'noninvasive-observer'
            && replaced !== null && (replaced.has(first.realID ?? '') || replaced.has(first.localId ?? ''));
        // 保存被替换 wire id：历史分页和重新连线不能让旧片段再次出现。
        if (replaced) for (const id of replaced) state.messageIds.set(id, internalId);
        const replacedRowIds = existing.length > 1 ? existing.slice(1).map(row => row.id) : EMPTY_IDS;
        for (const id of replacedRowIds) { state.messages.delete(id); changed.delete(id); removed.push(id); }
        state.messages.set(internalId, { ...first, id: internalId, realID: message.id,
            role: update.role === 'user' ? 'user' : 'agent', createdAt: acceptedInput ? first.createdAt : update.snapshotRevision !== undefined ? message.createdAt : first?.createdAt ?? message.createdAt,
            text: update.role === 'reasoning' ? `*${update.text}*` : update.text,
            isThinking: update.role === 'reasoning', event: null, tool: null, nativeAdmission: undefined,
            meta: { ...(acceptedInput ? { ...message.meta, ...first.meta } : message.meta),
                nativeTimestamp: message.meta?.nativeTimestamp,
                nativeRow: { id: update.sourceRowId, offset: 0, revision: update.streamRevision ?? update.revision } }, turn: message.turn,
            ...(acceptedInput ? { pending: false, deliveryUnconfirmed: false, sendError: undefined, sortAt: first.createdAt } : {}) });
        state.messageIds.set(message.id, internalId);
        state.nativeRowIds.set(update.sourceRowId, internalId);
        bindReplacements(state, update.sourceRowId, replacements.wireIds, replacements.sourceIds, internalId, changed, removed, replacedRowIds);
        changed.add(internalId);
    }
    for (const message of messages) {
        const source = message.meta?.nativeRow;
        if (!source || (message.role !== 'user' && message.role !== 'agent')) continue;
        if (state.nativeRetiredRowIds.has(source.id)) {
            const canonical = state.nativeRowIds.get(source.id); if (canonical) state.messageIds.set(message.id, canonical);
            continue;
        }
        const fragments = state.nativeTextFragments.get(source.id) ?? new Map<string, NormalizedMessage>();
        fragments.set(message.id, message); state.nativeTextFragments.set(source.id, fragments);
    }
    for (const [sourceId, fragments] of state.nativeTextFragments) {
        if (state.nativeRetiredRowIds.has(sourceId)) { state.nativeTextFragments.delete(sourceId); continue; }
        const internalId = state.nativeRowIds.get(sourceId) ?? `native:${sourceId}`;
        const currentOwner = state.messages.get(internalId)?.meta?.nativeRow?.id;
        if (currentOwner && currentOwner !== sourceId) continue;
        const ordered = fragments.size > 1
            ? [...fragments].sort((a, b) => a[1].meta!.nativeRow!.offset - b[1].meta!.nativeRow!.offset)
            : fragments;
        for (const [wireId, message] of ordered) {
            const source = message.meta!.nativeRow!, first = state.messages.get(internalId);
            const part = message.role === 'user' ? message.content.text : message.role === 'agent' ? message.content[0] : null;
            const thinking = typeof part === 'object' && part?.type === 'thinking';
            const text = typeof part === 'string' ? part : part?.type === 'text' ? part.text : thinking ? part.thinking : null;
            if (text === null) { fragments.delete(wireId); continue; }
            const revision = state.nativeRevisions.get(sourceId) ?? 0;
            if (source.revision > revision) continue; // A missing correction must arrive before its suffix.
            state.nativeRowIds.set(sourceId, internalId);
            state.messageIds.set(wireId, internalId);
            if (source.revision < revision) { fragments.delete(wireId); continue; }
            const previous = first?.isThinking && first.text ? first.text.slice(1, -1) : first?.text ?? '';
            if (source.offset > previous.length) continue;
            if (source.offset < previous.length) {
                if (previous.slice(source.offset, source.offset + text.length) === text) fragments.delete(wireId);
                continue;
            }
            // suffix 只追加到原 row；重连、重复片段和完整快照不能再创建一个消息气泡。
            const combined = previous + text;
            state.messages.set(internalId, { ...first, id: internalId, realID: wireId, role: message.role === 'user' ? 'user' : 'agent',
                createdAt: first?.createdAt ?? message.createdAt, text: thinking ? `*${combined}*` : combined, isThinking: thinking,
                tool: null, event: null, meta: { ...message.meta, ...first?.meta }, turn: message.turn });
            changed.add(internalId); fragments.delete(wireId);
        }
        if (!fragments.size) state.nativeTextFragments.delete(sourceId);
    }
    return { removed, messages: passthrough ?? messages };
}

export function applyNativeToolUpdates(state: ReducerState, changed: Set<string>) {
    for (const [callId, output] of state.nativeToolUpdates) {
        const id = state.toolIdToMessageId.get(callId);
        const row = id ? state.messages.get(id) : undefined;
        if (!row?.tool) continue;
        // 中途结果只更新 running 工具；旧进度永远不能覆盖原 owner 的终态。
        if (row.tool.state === 'running' && row.tool.result !== output) { row.tool.result = output; changed.add(row.id); }
        state.nativeToolUpdates.delete(callId);
    }
}
