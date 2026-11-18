import * as React from 'react';
import { Message, ToolCallMessage } from '@/sync/typesMessage';
import { knownTools } from '@/components/tools/knownTools';
import { isInteractiveQuestionToolName } from '@/utils/toolDisplay';
import { assignTurns } from '@/utils/agentTurns';

// Display item types for the grouped message list
export type TextItem = {
    type: 'message';
    id: string;
    message: Message;
};

export type AgentWorkGroupItem = {
    type: 'agent-work-group';
    id: string;
    /** Stable identity of the user prompt that opened this turn. */
    turnUserMessageId: string | null;
    /** Hidden intermediate messages, in chronological (render) order. */
    messages: Message[];
    hasRunning: boolean;
    hasPendingPermission: boolean;
    startedAt: number;
    completedAt: number | null;
};

export type ToolsGroupItem = {
    type: 'tools-group';
    id: string;
    anchorId: string;
    /** Original rows in chronological order, rendered only when opened. */
    messages: ToolCallMessage[];
};

export type DisplayItem = TextItem | AgentWorkGroupItem | ToolsGroupItem;
type GroupingOptions = { collapseCurrentTurn?: boolean; collapseAgentWork?: boolean; adjacentTools?: boolean; sessionId?: string };

type CachedGrouping = {
    sessionId: string | undefined;
    enabled: boolean;
    collapseCurrentTurn: boolean;
    collapseAgentWork: boolean | undefined;
    adjacentTools: boolean | undefined;
    messages: Message[];
    items: DisplayItem[];
};

function isSettledUserMessage(message: Message): boolean {
    return message.kind === 'user-text' && !message.pending && message.sendError === undefined;
}

function findSplitItemIndex(items: readonly DisplayItem[], anchor: Message): number {
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        if (item.type === 'message' && item.message === anchor) return i;
    }
    return -1;
}

/**
 * The messages array arrives newest-first (that is how sync stores it); the
 * returned display items are chronological, ready for a top-to-bottom list.
 *
 * Grouping is single-level on purpose: while a turn is streaming every message
 * renders flat, and once the turn completes its intermediate work collapses
 * into one AgentWorkGroupItem above the final answer. Native chats instead opt
 * into adjacent ordinary tool groups, retaining all intervening text. When
 * disabled and adjacent grouping is not requested, messages pass through.
 */
export function useGroupedMessages(
    messages: Message[],
    enabled: boolean = true,
    options: GroupingOptions = {},
): DisplayItem[] {
    const collapseCurrentTurn = options.collapseCurrentTurn ?? true;
    const { collapseAgentWork, adjacentTools, sessionId } = options;
    const previous = React.useRef<CachedGrouping | null>(null);
    return React.useMemo(() => {
        const prev = previous.current;
        if (prev
            && prev.sessionId === sessionId
            && prev.enabled === enabled
            && prev.collapseCurrentTurn === collapseCurrentTurn
            && prev.collapseAgentWork === collapseAgentWork
            && prev.adjacentTools === adjacentTools
            && prev.messages.length > 0
            && messages.length > 0) {
            let suffix = 0;
            while (suffix < messages.length
                && suffix < prev.messages.length
                && messages[messages.length - 1 - suffix] === prev.messages[prev.messages.length - 1 - suffix]) {
                suffix++;
            }
            if (suffix >= 2) {
                const start = messages.length - suffix;
                for (let currIdx = start; currIdx < messages.length - 1; currIdx++) {
                    if (!isSettledUserMessage(messages[currIdx])) continue;
                    const splitIdx = findSplitItemIndex(prev.items, messages[currIdx]);
                    if (splitIdx > 0) {
                        const headItems = groupMessagesForDisplay(messages.slice(0, currIdx + 1), enabled, {
                            collapseCurrentTurn,
                            collapseAgentWork,
                            adjacentTools,
                            sessionId,
                        });
                        const stableHead = retainToolsGroupIds(headItems, prev.items.slice(splitIdx));
                        const combined = [...prev.items.slice(0, splitIdx), ...stableHead];
                        previous.current = { sessionId, enabled, collapseCurrentTurn, collapseAgentWork, adjacentTools, messages, items: combined };
                        return combined;
                    }
                    break;
                }
            }
        }
        const items = groupMessagesForDisplay(messages, enabled, { collapseCurrentTurn, collapseAgentWork, adjacentTools, sessionId });
        const stable = retainToolsGroupIds(items, prev && prev.sessionId === sessionId ? prev.items : []);
        previous.current = { sessionId, enabled, collapseCurrentTurn, collapseAgentWork, adjacentTools, messages, items: stable };
        return stable;
    }, [messages, enabled, collapseCurrentTurn, collapseAgentWork, adjacentTools, sessionId]);
}

export function groupMessagesForDisplay(
    messages: Message[],
    enabled: boolean = true,
    options: GroupingOptions = {},
): DisplayItem[] {
    if (!enabled) {
        const flat = messages
            .filter((msg) => !isInvisibleMessage(msg))
            .map((msg) => ({ type: 'message', id: msg.id, message: msg } as TextItem));
        flat.reverse();
        return options.adjacentTools ? groupAdjacentTools(flat, options.sessionId) : flat;
    }

    const collapseCurrentTurn = options.collapseCurrentTurn ?? true;
    // Newest-first → turn 0 is the current assistant turn.
    const turnOf = assignTurns(messages);
    const workGroups = options.collapseAgentWork === false ? [] : collectAgentWorkGroups(messages, turnOf, collapseCurrentTurn);
    const hiddenWorkIndexes = new Set<number>();
    const workGroupByOldestIndex = new Map<number, AgentWorkGroupItem>();

    for (const group of workGroups) {
        workGroupByOldestIndex.set(group.oldestIdx, group.item);
        for (const index of group.hiddenIndexes) {
            hiddenWorkIndexes.add(index);
        }
    }

    // Build newest-first, matching the input order, then reverse once at the
    // end. Groups are emitted at their oldest hidden member so the final order
    // reads user message → collapsed work → final answer.
    const result: DisplayItem[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        if (isInvisibleMessage(msg)) continue;

        if (hiddenWorkIndexes.has(i)) {
            const workGroup = workGroupByOldestIndex.get(i);
            if (workGroup) {
                result.push(workGroup);
            }
            continue;
        }

        result.push({ type: 'message', id: msg.id, message: msg });
    }

    result.reverse();
    return options.adjacentTools ? groupAdjacentTools(result, options.sessionId) : result;
}

/** Adjacent visible ordinary tools only; text and interactive rows remain boundaries. */
export function groupAdjacentTools(items: readonly DisplayItem[], sessionId?: string): DisplayItem[] {
    const result: DisplayItem[] = [];
    let run: ToolCallMessage[] = [];
    const flush = () => {
        if (run.length) result.push({ type: 'tools-group', id: JSON.stringify(['tools', sessionId ?? null, run[0].id]), anchorId: run[0].id, messages: run });
        run = [];
    };
    for (const item of items) {
        const message = item.type === 'message' ? item.message : null;
        if (message && isOrdinaryToolMessage(message)) {
            if (run.length && run[run.length - 1].turn !== undefined && message.turn !== undefined && run[run.length - 1].turn !== message.turn) flush();
            run.push(message);
        } else {
            flush(); result.push(item);
        }
    }
    flush(); return result;
}

export function isOrdinaryToolMessage(message: Message): message is ToolCallMessage {
    return message.kind === 'tool-call' && !isInvisibleMessage(message) && !isUserAttachment(message)
        && !isInteractiveQuestionToolName(message.tool.name) && message.tool.permission?.status !== 'pending';
}

/** Include a retained adjacent run for an accurate count without mounting its details. */
export function ordinaryToolRunWindowEnd(messages: readonly Message[], requestedEnd: number): number {
    let end = Math.min(messages.length, Math.max(0, requestedEnd));
    if (!end || !isOrdinaryToolMessage(messages[end - 1])) return end;
    while (end < messages.length && isOrdinaryToolMessage(messages[end])) {
        const previous = messages[end - 1], next = messages[end];
        if ('turn' in previous && 'turn' in next && previous.turn !== undefined && next.turn !== undefined && previous.turn !== next.turn) break;
        end++;
    }
    return end;
}

/** Preserve a summary's list key when live/history extends its original rows. */
export function retainToolsGroupIds(items: DisplayItem[], previous: readonly DisplayItem[]): DisplayItem[] {
    if (!previous.length) return items;
    const oldByAnchor = new Map<string, ToolsGroupItem>();
    for (let i = 0; i < previous.length; i++) {
        const item = previous[i];
        if (item.type === 'tools-group' && !oldByAnchor.has(item.anchorId)) {
            oldByAnchor.set(item.anchorId, item);
        }
    }
    if (!oldByAnchor.size) return items;
    const used = new Set<string>();
    let changed = false;
    const result = items.map(item => {
        if (item.type !== 'tools-group') return item;
        let old: ToolsGroupItem | undefined;
        for (let i = 0; i < item.messages.length; i++) {
            const candidate = oldByAnchor.get(item.messages[i].id);
            if (candidate && !used.has(candidate.id)) {
                old = candidate;
                break;
            }
        }
        if (!old) return item;
        used.add(old.id);
        if (old.id === item.id) return item;
        changed = true;
        return { ...item, id: old.id, anchorId: old.anchorId };
    });
    return changed ? result : items;
}

function collectAgentWorkGroups(messages: Message[], turnOf: number[], collapseCurrentTurn: boolean): Array<{
    item: AgentWorkGroupItem;
    hiddenIndexes: number[];
    oldestIdx: number;
}> {
    const segments = new Map<number, number[]>();
    for (let i = 0; i < messages.length; i++) {
        const turn = turnOf[i];
        if (!segments.has(turn)) {
            segments.set(turn, []);
        }
        segments.get(turn)!.push(i);
    }

    const groups: Array<{
        item: AgentWorkGroupItem;
        hiddenIndexes: number[];
        oldestIdx: number;
    }> = [];

    for (const [turn, indexes] of segments) {
        if (turn === 0 && !collapseCurrentTurn) {
            continue;
        }

        const visibleAgentIndexes = indexes.filter((index) => {
            const msg = messages[index];
            if (msg.kind === 'user-text') return false;
            if (isInvisibleMessage(msg) || isUserAttachment(msg)) return false;
            if (msg.kind === 'tool-call' && isInteractiveQuestionToolName(msg.tool.name)) return false;
            return true;
        });

        const finalTextIndex = visibleAgentIndexes.find((index) => messages[index].kind === 'agent-text');
        if (finalTextIndex === undefined) continue;

        const hiddenIndexes = visibleAgentIndexes.filter((index) => index > finalTextIndex);
        if (hiddenIndexes.length === 0) continue;

        const oldestIdx = Math.max(...hiddenIndexes);
        const hiddenMessages = hiddenIndexes.map((index) => messages[index]);
        const turnUserMessageId = indexes
            .map((index) => messages[index])
            .find((message) => message.kind === 'user-text' && !message.pending && message.sendError === undefined)?.id ?? null;
        const startedAt = Math.min(...hiddenMessages.map((msg) => msg.createdAt));
        const completedAt = messages[finalTextIndex].createdAt;
        // Members render flat when the group expands, so they are stored in
        // the order they will be drawn.
        hiddenMessages.reverse();

        groups.push({
            hiddenIndexes,
            oldestIdx,
            item: {
                type: 'agent-work-group',
                // Keyed by the final answer, the one member a turn is sure to
                // have: history pages in oldest-last, so a turn's older work
                // (and its opening prompt) can arrive after the group exists.
                id: `work-${messages[finalTextIndex].id}`,
                turnUserMessageId,
                messages: hiddenMessages,
                hasRunning: false,
                hasPendingPermission: hasPendingPermission(hiddenMessages),
                startedAt,
                completedAt,
            },
        });
    }

    return groups;
}

/** Returns true for messages that render as null and should be excluded entirely */
function isInvisibleMessage(msg: Message): boolean {
    // Hidden tools (ToolSearch, CodexReasoning, etc.)
    if (msg.kind === 'tool-call') {
        const known = knownTools[msg.tool.name as keyof typeof knownTools] as any;
        return known?.hidden === true;
    }
    // Thinking messages render as null in MessageView
    if (msg.kind === 'agent-text') {
        if (msg.isThinking) return true;
        if (msg.text.trim().length === 0) return true;
    }
    return false;
}

/** User-sent file/image attachments should never be collapsed into a group */
function isUserAttachment(msg: Message): boolean {
    return msg.kind === 'tool-call' && msg.tool.name === 'file';
}

function hasPendingPermission(messages: Message[]): boolean {
    return messages.some((msg) => (
        msg.kind === 'tool-call'
        && msg.tool.permission?.status === 'pending'
    ));
}

export function formatWorkDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m`;
    }
    if (minutes > 0) {
        return `${minutes}m${seconds}s`;
    }
    return `${seconds}s`;
}
