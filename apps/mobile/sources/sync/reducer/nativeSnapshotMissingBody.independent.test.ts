import { expect, it } from 'vitest';
import { nativeRecentMessages, type PeerRecentWindow } from '../codelyncRecent';
import { createReducer, reducer } from './reducer';

// Synthetic protocol identities exercise the same retained-watermark boundary
// independently of the producer and native UI.
it('an equal-revision full native recent window restores a missing canonical payload', () => {
    const owner = 'synthetic-original-owner';
    const sourceRowId = 'synthetic-assistant-row';
    const body = 'The original owner supplied this complete assistant body.';
    const window: PeerRecentWindow = {
        version: 1,
        session: {
            id: 'synthetic-bridge-session', nativeUpdatedAt: 2000, basicOnly: false,
            metadata: null, metadataVersion: 1, agentState: null, agentStateVersion: 1,
            seq: 0, createdAt: 1, active: false, activeAt: 1,
        },
        rows: [{
            id: sourceRowId, role: 'assistant', turnId: 'synthetic-native-turn', text: body,
            at: 1000, projectionRevision: 1, snapshotRevision: 7, streamRevision: 0,
            ownerGeneration: owner, replaceIds: [],
        }],
        nextCursor: null, hasMore: false, ownerGeneration: owner, revision: 7,
        status: 'idle', currentTurnId: null, seq: 0, observedAt: 2000,
    };
    const state = createReducer();
    const first = reducer(state, nativeRecentMessages(window));
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({ kind: 'agent-text', text: body });
    const canonical = state.nativeRowIds.get(sourceRowId)!;
    const snapshotKey = JSON.stringify(['snapshot', owner, sourceRowId]);
    expect(state.nativeRevisions.get(snapshotKey)).toBe(7);
    expect(state.nativeRetiredRowIds.has(sourceRowId)).toBe(false);

    // A retained identity/watermark with an absent resident payload is the
    // precise cache inconsistency under investigation. Do not clear revision,
    // owner, retirement or stream-ahead protection to make a replay succeed.
    state.messages.delete(canonical);
    const replay = nativeRecentMessages(window);
    expect(state.messageIds.has(replay[0].id)).toBe(true);
    expect(state.nativeRowIds.get(sourceRowId)).toBe(canonical);
    const restored = reducer(state, replay);

    // The same-owner full seed repairs the absent payload without clearing watermarks.
    expect(restored.messages).toContainEqual(expect.objectContaining({ id: canonical, kind: 'agent-text', text: body }));
});
