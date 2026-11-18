import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';

vi.hoisted(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/tools/knownTools', () => ({
    knownTools: {
        Skill: { hidden: true },
    },
}));

import { buildCodelyncBrowserRows, codelyncProjectKey } from '@/utils/codelyncSessionBrowser';
import {
    groupMessagesForDisplay,
    retainToolsGroupIds,
    useGroupedMessages,
    type DisplayItem,
    type ToolsGroupItem,
} from '@/hooks/useGroupedMessages';

function nativeSession(
    id: string,
    nativeId: string,
    options: {
        parentId?: string | null;
        isSubagent?: boolean;
        archived?: boolean;
        projectKey?: string;
        updatedAt?: number;
        title?: string;
    } = {},
): Session {
    return {
        id,
        updatedAt: options.updatedAt ?? 100,
        metadata: {
            path: '/repo/app',
            machineId: 'machine-1',
            bridge: {
                controlMode: 'session',
                source: {
                    id: nativeId,
                    hostId: 'local',
                    app: 'codex',
                },
            },
            nativeSession: {
                title: options.title ?? id,
                updatedAt: options.updatedAt ?? 100,
                parentId: options.parentId ?? null,
                isSubagent: options.isSubagent ?? false,
                archived: options.archived ?? false,
                agentName: id,
                preview: id,
                isPinned: false,
                projectKey: options.projectKey ?? 'proj-a',
                projectPath: '/repo/app',
                projectLabel: 'app',
            },
        },
    } as unknown as Session;
}

function toolMessage(id: string, createdAt: number, turn = 'turn-1'): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt,
        turn,
        tool: {
            name: 'CodexBash',
            state: 'completed',
            input: { command: id },
            createdAt,
            startedAt: createdAt,
            completedAt: createdAt + 1,
            description: id,
        },
        children: [],
    };
}

function userMessage(id: string, createdAt: number): Message {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt,
        text: id,
    };
}

function agentMessage(id: string, createdAt: number, turn?: string): Message {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt,
        text: id,
        ...(turn ? { turn } : {}),
    };
}

describe('Track C Batch 7 — R063 codelyncSessionBrowser & R068 useGroupedMessages', () => {
    const roots: ReturnType<typeof create>[] = [];

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        for (const root of roots.splice(0)) {
            act(() => root.unmount());
        }
        vi.restoreAllMocks();
    });

    it('R063: projects browser rows in a single native pass without redundant filter passes or collapsed ordinary parentId reads', () => {
        let foreignBridgeReads = 0;
        let ordinaryParentReads = 0;

        const ord1 = nativeSession('ord-1', 'n-1', { projectKey: 'proj-a', updatedAt: 10 });
        const ord2 = nativeSession('ord-2', 'n-2', { projectKey: 'proj-a', updatedAt: 20 });
        const sub1 = nativeSession('sub-1', 'n-sub-1', { parentId: 'n-1', isSubagent: true, projectKey: 'worktree-sub', updatedAt: 30 });
        const archived = nativeSession('arch-1', 'n-arch', { archived: true, updatedAt: 40 });
        const foreign = {
            id: 'foreign-1',
            updatedAt: 50,
            metadata: {
                path: '/other',
                bridge: { controlMode: 'window', source: { id: 'w-1', hostId: 'local', app: 'codex' } },
            },
        } as unknown as Session;

        for (const ordinary of [ord1, ord2]) {
            const ns = ordinary.metadata!.nativeSession!;
            let backingParent = ns.parentId;
            Object.defineProperty(ns, 'parentId', {
                get: () => {
                    ordinaryParentReads++;
                    return backingParent;
                },
                set: (v) => { backingParent = v; },
                enumerable: true,
                configurable: true,
            });
        }

        const foreignMeta = foreign.metadata!;
        const foreignBridge = foreignMeta.bridge;
        Object.defineProperty(foreignMeta, 'bridge', {
            get: () => {
                foreignBridgeReads++;
                return foreignBridge;
            },
            enumerable: true,
            configurable: true,
        });

        // Folded ordinary project: zero parentId reads for ord1/ord2, single pass check on foreign.
        const folded = buildCodelyncBrowserRows([ord1, ord2, sub1, archived, foreign], '', new Set(), new Set());
        expect(folded).toEqual([
            expect.objectContaining({
                kind: 'project',
                key: codelyncProjectKey(ord1),
                count: 2,
            }),
        ]);
        expect(ordinaryParentReads).toBe(0);
        // isCodelyncNativeSession reads metadata.bridge once per session on scan (no double sessions.filter).
        expect(foreignBridgeReads).toBe(1);

        // Expanded project produces ord-1 (+ child sub-1 with family recency 30) ahead of ord-2 (20).
        const expanded = buildCodelyncBrowserRows(
            [ord1, ord2, sub1, archived, foreign],
            '',
            new Set([codelyncProjectKey(ord1)]),
            new Set(['ord-1']),
        );
        expect(expanded.filter((row) => row.kind === 'session').map((row) => row.key)).toEqual(['ord-1', 'sub-1', 'ord-2']);
    });

    it('R068: incrementally reuses historical turn items across live streaming updates and resets cleanly on option/session change', () => {
        let items: DisplayItem[] = [];
        function Harness({
            messages,
            enabled = true,
            sessionId = 's1',
            adjacentTools = false,
        }: {
            messages: Message[];
            enabled?: boolean;
            sessionId?: string;
            adjacentTools?: boolean;
        }) {
            items = useGroupedMessages(messages, enabled, { sessionId, collapseCurrentTurn: false, adjacentTools });
            return null;
        }

        // Oldest turn (turn 2): u1 -> t1 -> a1
        const u1 = userMessage('u1', 1);
        const t1 = toolMessage('t1', 2, 'turn-1');
        const a1 = agentMessage('a1', 3, 'turn-1');
        // Middle turn (turn 1): u2 -> t2 -> a2
        const u2 = userMessage('u2', 4);
        const t2 = toolMessage('t2', 5, 'turn-2');
        const a2 = agentMessage('a2', 6, 'turn-2');
        // Active turn (turn 0): u3 -> t3
        const u3 = userMessage('u3', 7);
        const t3 = toolMessage('t3', 8, 'turn-3');

        // Newest-first message order
        const initialMessages: Message[] = [t3, u3, a2, t2, u2, a1, t1, u1];

        let root!: ReturnType<typeof create>;
        act(() => {
            root = create(React.createElement(Harness, { messages: initialMessages }));
        });
        roots.push(root);

        const initialSnapshot = items;
        expect(initialSnapshot.map((item) => item.id)).toEqual(['u1', 'work-a1', 'a1', 'u2', 'work-a2', 'a2', 'u3', 't3']);

        // Stream a new tool + final text into the active turn while historical objects u1..u3 are identical references.
        const t4 = toolMessage('t4', 9, 'turn-3');
        const a3 = agentMessage('a3', 10, 'turn-3');
        const streamedMessages: Message[] = [a3, t4, t3, u3, a2, t2, u2, a1, t1, u1];

        act(() => {
            root.update(React.createElement(Harness, { messages: streamedMessages }));
        });

        expect(items).toEqual(groupMessagesForDisplay(streamedMessages, true, { sessionId: 's1', collapseCurrentTurn: false, adjacentTools: false }));
        // Historical items strictly before u3 retain exact object identities!
        expect(items[0]).toBe(initialSnapshot[0]);
        expect(items[1]).toBe(initialSnapshot[1]);
        expect(items[2]).toBe(initialSnapshot[2]);
        expect(items[3]).toBe(initialSnapshot[3]);
        expect(items[4]).toBe(initialSnapshot[4]);
        expect(items[5]).toBe(initialSnapshot[5]);

        // Enabling adjacentTools invalidates cache cleanly instead of returning stale ungrouped tail.
        act(() => {
            root.update(React.createElement(Harness, { messages: streamedMessages, adjacentTools: true }));
        });
        expect(items.some((item) => item.type === 'tools-group')).toBe(true);

        // Switching sessionId does not carry over previous session's cached tail.
        act(() => {
            root.update(React.createElement(Harness, { messages: streamedMessages, sessionId: 's2', adjacentTools: true }));
        });
        expect((items.find((item) => item.type === 'tools-group') as ToolsGroupItem).id).toContain('"s2"');
    });

    it('R068: retainToolsGroupIds retains keys across 1500 groups in linear map time without quadratic scanning', () => {
        const makeGroup = (index: number, prefix: string): ToolsGroupItem => ({
            type: 'tools-group',
            id: `${prefix}-group-${index}`,
            anchorId: `tool-${index}`,
            messages: [toolMessage(`tool-${index}`, index)],
        });

        const previous: DisplayItem[] = Array.from({ length: 1500 }, (_, i) => makeGroup(i, 'old'));
        const next: DisplayItem[] = previous.map((item, i) => {
            const g = item as ToolsGroupItem;
            return {
                type: 'tools-group',
                id: `new-group-${i}`,
                anchorId: `prepended-${i}`,
                messages: [toolMessage(`prepended-${i}`, i), ...g.messages],
            };
        });

        const start = performance.now();
        const retained = retainToolsGroupIds(next, previous);
        const elapsedMs = performance.now() - start;

        expect(retained).toHaveLength(1500);
        expect(retained[0]).toMatchObject({ id: 'old-group-0', anchorId: 'tool-0' });
        expect(retained[1499]).toMatchObject({ id: 'old-group-1499', anchorId: 'tool-1499' });
        expect(elapsedMs).toBeLessThan(250);
    });
});
