import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionListViewItem, SessionRowData } from './storage';

const listMocks = vi.hoisted(() => ({
    data: null as SessionListViewItem[] | null,
    hideArchivedSessions: false,
}));

vi.mock('react', () => ({
    useMemo: <T,>(factory: () => T) => factory(),
}));

vi.mock('@/sync/storage', () => ({
    useSessionListViewData: () => listMocks.data,
    useSetting: (key: string) => {
        if (key !== 'hideInactiveSessions') throw new Error(`Unexpected setting read: ${key}`);
        return listMocks.hideArchivedSessions;
    },
}));

import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { filterProjectGroupSessions } from './projectGroups';
import { mergeMessageArray } from './messageArray';
import { createReducer, reducer } from './reducer/reducer';
import { applyNativeProjection } from './reducer/nativeProjection';
import type { NormalizedMessage } from './typesRaw';

describe('Track C Batch 10: R093 mergeMessageArray & applyNativeProjection streaming fast paths', () => {
    it('updates head and middle single-row streaming messages without Map/Set or full-list key scans, while matching full sort semantics', () => {
        const rows = Array.from({ length: 2000 }, (_, i) => ({
            id: `m-${i}`,
            at: 2000 - i,
        }));

        let keyCalls = 0;
        const key = (m: { id: string; at: number }) => {
            keyCalls += 1;
            return m.at;
        };

        // Exact-reference head hit returns previous without scanning tail.
        expect(mergeMessageArray(rows, [rows[0]], [], key)).toBe(rows);
        expect(keyCalls).toBe(1);

        // Head streaming delta: only calls key() for updated head and neighbor [1].
        keyCalls = 0;
        const nextHead = { id: 'm-0', at: 2001 };
        const afterHead = mergeMessageArray(rows, [nextHead], [], key);
        expect(afterHead).not.toBe(rows);
        expect(afterHead[0]).toBe(nextHead);
        expect(afterHead[1]).toBe(rows[1]);
        expect(keyCalls).toBe(2);

        // Move an item earlier on key bump & tie break.
        const small = [{ id: 'a', at: 10 }, { id: 'b', at: 8 }, { id: 'c', at: 5 }];
        expect(mergeMessageArray(small, [{ id: 'b', at: 10 }], [], (m) => m.at).map((m) => m.id)).toEqual(['a', 'b', 'c']);
        expect(mergeMessageArray(small, [{ id: 'c', at: 10 }], [], (m) => m.at).map((m) => m.id)).toEqual(['a', 'c', 'b']);
        expect(mergeMessageArray(small, [{ id: 'a', at: 5 }], [], (m) => m.at).map((m) => m.id)).toEqual(['b', 'a', 'c']);

        // Insert new rows at start, middle, and end preserving tie order.
        expect(mergeMessageArray(small, [{ id: 'd', at: 12 }], [], (m) => m.at).map((m) => m.id)).toEqual(['d', 'a', 'b', 'c']);
        expect(mergeMessageArray(small, [{ id: 'd', at: 8 }], [], (m) => m.at).map((m) => m.id)).toEqual(['a', 'b', 'd', 'c']);
        expect(mergeMessageArray(small, [{ id: 'd', at: 5 }], [], (m) => m.at).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('skips O(M) state.messages.values() and alias-map scans on single-row streaming native-row-upsert updates', () => {
        const state = createReducer();

        // Populate 1000 unrelated rows plus 1 active native streaming row.
        const seed: NormalizedMessage[] = Array.from({ length: 1000 }, (_, i) => ({
            id: `seed-${i}`,
            localId: null,
            createdAt: i + 1,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text: `row-${i}`, uuid: `seed-${i}`, parentUUID: null }],
        }));
        seed.push({
            id: 'stream-seed',
            localId: null,
            createdAt: 2000,
            role: 'event',
            isSidechain: false,
            content: {
                type: 'native-row-upsert',
                sourceRowId: 'stream-row',
                role: 'assistant',
                text: 'hello',
                revision: 1,
                replaceIds: [],
            },
            meta: { sentFrom: 'noninvasive-observer' },
            turn: 'turn-1',
        });
        reducer(state, seed);

        const valuesSpy = vi.spyOn(state.messages, 'values');
        const msgIdIterSpy = vi.spyOn(state.messageIds, Symbol.iterator);
        const localIdIterSpy = vi.spyOn(state.localIds, Symbol.iterator);
        const nativeRowIterSpy = vi.spyOn(state.nativeRowIds, Symbol.iterator);

        const changed = new Set<string>();
        const delta: NormalizedMessage = {
            id: 'stream-delta-2',
            localId: null,
            createdAt: 2001,
            role: 'event',
            isSidechain: false,
            content: {
                type: 'native-row-upsert',
                sourceRowId: 'stream-row',
                role: 'assistant',
                text: 'hello world',
                revision: 2,
                replaceIds: [],
            },
            meta: { sentFrom: 'noninvasive-observer' },
            turn: 'turn-1',
        };
        const result = applyNativeProjection(state, [delta], changed);

        expect(result.removed).toEqual([]);
        expect(result.messages).toEqual([]);
        expect(valuesSpy).not.toHaveBeenCalled();
        expect(msgIdIterSpy).not.toHaveBeenCalled();
        expect(localIdIterSpy).not.toHaveBeenCalled();
        expect(nativeRowIterSpy).not.toHaveBeenCalled();

        const internalId = state.nativeRowIds.get('stream-row')!;
        expect(changed.has(internalId)).toBe(true);
        expect(state.messages.get(internalId)?.text).toBe('hello world');

        // Passthrough non-native message preserves array identity when no native rows/fragments exist.
        const plain: NormalizedMessage[] = [{
            id: 'plain-1',
            localId: null,
            createdAt: 3000,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text: 'plain', uuid: 'plain-1', parentUUID: null }],
        }];
        const passthrough = applyNativeProjection(state, plain, new Set());
        expect(passthrough.messages).toBe(plain);
    });
});

describe('Track C Batch 10: R098 useVisibleSessionListViewData zero-clone fast paths', () => {
    function makeRow(id: string, archived = false, active = false): SessionRowData {
        return { id, name: id, archived, active } as SessionRowData;
    }

    function makeProject(id: string, sessions: SessionRowData[]): SessionListViewItem {
        return {
            type: 'project',
            source: 'rig',
            project: {
                id,
                name: id,
                machineId: 'machine-1',
                sessionCount: sessions.length,
                activeCount: sessions.filter((s) => s.active).length,
                workspaces: [{ id: '', name: null, sessions }],
            },
        };
    }

    beforeEach(() => {
        listMocks.data = null;
        listMocks.hideArchivedSessions = false;
    });

    it('returns the exact data array and project item references without cloning when hideArchivedSessions is false', () => {
        const projA = makeProject('a', [makeRow('s1', false, true), makeRow('s2', true)]);
        const projB = makeProject('b', [makeRow('s3', false)]);
        const input: SessionListViewItem[] = [
            { type: 'projects-header', source: 'rig' },
            projA,
            projB,
            { type: 'header', title: 'Today' },
            { type: 'session', session: makeRow('s4', true) },
        ];
        listMocks.data = input;
        listMocks.hideArchivedSessions = false;

        const output = useVisibleSessionListViewData();
        expect(output).toBe(input);
        expect(output![1]).toBe(projA);
        expect(output![2]).toBe(projB);
    });

    it('preserves untouched project item references even when hideArchivedSessions is true', () => {
        const cleanProj = makeProject('clean', [makeRow('s1', false, true)]);
        const mixedProj = makeProject('mixed', [makeRow('s2', false), makeRow('s3', true)]);
        listMocks.data = [
            { type: 'projects-header', source: 'rig' },
            cleanProj,
            mixedProj,
        ];
        listMocks.hideArchivedSessions = true;

        const output = useVisibleSessionListViewData()!;
        expect(output[1]).toBe(cleanProj);
        expect(output[2]).not.toBe(mixedProj);
        expect(output[2].type === 'project' && output[2].project.sessionCount).toBe(1);
        expect(filterProjectGroupSessions((cleanProj as Extract<SessionListViewItem, { type: 'project' }>).project, (s) => !s.archived))
            .toBe((cleanProj as Extract<SessionListViewItem, { type: 'project' }>).project);
    });
});
