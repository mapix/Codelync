import { expect, it } from 'vitest';
import { createReducer, reducer } from './reducer';
import type { NormalizedMessage } from '../typesRaw';

const fragment = (id: string, sourceId: string): NormalizedMessage => ({ id, localId: null, createdAt: 1, role: 'user', isSidechain: false,
    content: { type: 'text', text: 'Same original input' }, meta: { sentFrom: 'noninvasive-observer', nativeRow: { id: sourceId, offset: 0, revision: 0 } }, turn: 'original-turn' });
const snapshot = (replaceSourceRowIds: string[] = []): NormalizedMessage => ({ id: 'current-snapshot', localId: null, createdAt: 2, role: 'event', isSidechain: false,
    content: { type: 'native-row-upsert', sourceRowId: 'accepted-row', role: 'user', text: 'Same original input', revision: 1,
        snapshotRevision: 3, streamRevision: 1, ownerGeneration: 'owner', replaceIds: [], replaceSourceRowIds }, meta: { sentFrom: 'noninvasive-observer' }, turn: 'original-turn' });
it('the native caller/server replacement merges an old steering UUID even when the full snapshot arrives first', () => {
    const state = createReducer(); reducer(state, [fragment('old-wire', 'legacy-steering-uuid')]);
    reducer(state, [snapshot(['legacy-steering-uuid'])]);
    expect(state.messages.size).toBe(1);
    reducer(state, [fragment('old-wire-replayed', 'legacy-steering-uuid')]); expect(state.messages.size).toBe(1);
});
it('a same-version late replacement still retires its aliases without replacing newer text', () => {
    const state = createReducer(); reducer(state, [fragment('old-wire', 'legacy-steering-uuid')]); reducer(state, [snapshot()]);
    const update = snapshot(['legacy-steering-uuid']); update.id = 'late-wire';
    if (update.role === 'event' && update.content.type === 'native-row-upsert') { delete update.content.snapshotRevision; update.content.replaceIds = ['old-wire']; update.content.text = 'Older text must not replace the snapshot'; }
    reducer(state, [update]); expect(state.messages.size).toBe(1); expect([...state.messages.values()][0].text).toBe('Same original input');
});
it('equal text from unrelated original rows is not merged', () => {
    const state = createReducer(); reducer(state, [fragment('wire-one', 'first-row'), fragment('wire-two', 'second-row')]);
    expect(state.messages.size).toBe(2);
});

const full = (sourceRowId: string, text: string, snapshotRevision = 40, streamRevision = 1,
    replaceSourceRowIds = ['claude-api:shared-partial']): NormalizedMessage => ({
    id: `full:${sourceRowId}:${snapshotRevision}:${streamRevision}`, localId: null, createdAt: 10, role: 'event', isSidechain: false,
    content: { type: 'native-row-upsert', sourceRowId, role: 'assistant', text, revision: streamRevision,
        snapshotRevision, streamRevision, ownerGeneration: 'owner', replaceIds: ['partial-wire'], replaceSourceRowIds },
    meta: { sentFrom: 'noninvasive-observer' }, turn: 'original-turn',
});
const textFor = (state: ReturnType<typeof createReducer>, nativeId: string) => state.messages.get(state.nativeRowIds.get(nativeId) ?? '');

it('a consumed API alias cannot make another full UUID overwrite the confirmed body', () => {
    const state = createReducer();
    reducer(state, [full('full-text-uuid', 'Confirmed assistant body')]);
    reducer(state, [full('full-tool-uuid', '')]);
    expect(textFor(state, 'full-text-uuid')).toMatchObject({ text: 'Confirmed assistant body', meta: { nativeRow: { id: 'full-text-uuid' } } });
    expect(textFor(state, 'full-tool-uuid')).toMatchObject({ text: '', meta: { nativeRow: { id: 'full-tool-uuid' } } });
    expect(state.nativeRowIds.get('full-text-uuid')).not.toBe(state.nativeRowIds.get('full-tool-uuid'));
    expect(state.nativeRetiredRowIds.has('claude-api:shared-partial')).toBe(true);
    reducer(state, [full('other-text-uuid', 'Different original body')]);
    expect(textFor(state, 'full-text-uuid')?.text).toBe('Confirmed assistant body');
    expect(textFor(state, 'other-text-uuid')?.text).toBe('Different original body');
});

it('a missing wire alias index does not make a foreign confirmed native row available for replacement', () => {
    const state = createReducer(); reducer(state, [full('full-text-uuid', 'Confirmed assistant body')]);
    textFor(state, 'full-text-uuid')!.realID = 'partial-wire';
    state.messageIds.delete('partial-wire');
    reducer(state, [full('full-tool-uuid', '')]);
    expect(textFor(state, 'full-text-uuid')?.text).toBe('Confirmed assistant body');
    expect(state.nativeRowIds.get('full-text-uuid')).not.toBe(state.nativeRowIds.get('full-tool-uuid'));
});

it('retired partial fragments cannot mutate the confirmed UUID while waiting for a missing prefix', () => {
    const state = createReducer();
    const suffix: NormalizedMessage = { id: 'late-api-suffix', localId: null, createdAt: 1, role: 'agent', isSidechain: false,
        content: [{ type: 'text', text: 'late suffix', uuid: 'late-api-suffix', parentUUID: null }],
        meta: { sentFrom: 'noninvasive-observer', nativeRow: { id: 'claude-api:shared-partial', offset: 999, revision: 0 } } };
    reducer(state, [suffix]);
    expect(state.nativeTextFragments.has('claude-api:shared-partial')).toBe(true);
    reducer(state, [full('full-text-uuid', 'Confirmed assistant body')]);
    reducer(state, [suffix]);
    expect(state.nativeTextFragments.has('claude-api:shared-partial')).toBe(false);
    expect(textFor(state, 'full-text-uuid')?.text).toBe('Confirmed assistant body');
});

it('repairs the observed foreign empty canonical at equal snapshot and stream watermarks without stealing its UUID', () => {
    const state = createReducer(), seed = full('full-text-uuid', 'Confirmed assistant body');
    reducer(state, [seed]);
    const damaged = state.nativeRowIds.get('full-text-uuid')!;
    state.messages.set(damaged, { ...state.messages.get(damaged)!, text: '', meta: { nativeRow: { id: 'full-tool-uuid', offset: 0, revision: 1 } } });
    state.nativeRowIds.set('full-tool-uuid', damaged);
    state.nativeSnapshotOwners.set('full-tool-uuid', 'owner');
    state.nativeRevisions.set(JSON.stringify(['snapshot', 'owner', 'full-tool-uuid']), 40);
    state.nativeRevisions.set('full-tool-uuid', 1);
    reducer(state, [seed]);
    expect(textFor(state, 'full-text-uuid')).toMatchObject({ text: 'Confirmed assistant body', meta: { nativeRow: { id: 'full-text-uuid' } } });
    expect(textFor(state, 'full-tool-uuid')).toMatchObject({ text: '', meta: { nativeRow: { id: 'full-tool-uuid' } } });
    expect(state.nativeRowIds.get('full-text-uuid')).not.toBe(damaged);
    expect(state.nativeRevisions.get(JSON.stringify(['snapshot', 'owner', 'full-text-uuid']))).toBe(40);
});

it('keeps strictly newer snapshot, stream-ahead and truly retired identities protected during payload repair', () => {
    for (const protection of ['snapshot', 'stream', 'retired']) {
        const state = createReducer(), seed = full('full-text-uuid', 'Confirmed assistant body');
        reducer(state, [seed]);
        const canonical = state.nativeRowIds.get('full-text-uuid')!;
        state.messages.delete(canonical);
        if (protection === 'snapshot') state.nativeRevisions.set(JSON.stringify(['snapshot', 'owner', 'full-text-uuid']), 41);
        if (protection === 'stream') state.nativeRevisions.set('full-text-uuid', 2);
        if (protection === 'retired') state.nativeRetiredRowIds.add('full-text-uuid');
        reducer(state, [seed]);
        expect(state.messages.has(canonical), protection).toBe(false);
    }
});

it('applies a legitimate empty correction to the same UUID and ignores an older full body', () => {
    const state = createReducer(); reducer(state, [full('full-text-uuid', 'Confirmed assistant body')]);
    reducer(state, [full('full-text-uuid', '', 41, 2)]);
    expect(textFor(state, 'full-text-uuid')?.text).toBe('');
    reducer(state, [full('full-text-uuid', 'Confirmed assistant body')]);
    expect(textFor(state, 'full-text-uuid')?.text).toBe('');
});
