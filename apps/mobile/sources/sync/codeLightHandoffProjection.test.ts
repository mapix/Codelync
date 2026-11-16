import { expect, it } from 'vitest';
import type { Session } from './storageTypes';
import type { PeerRecentWindow } from './codeLightRecent';
import type { NormalizedMessage } from './typesRaw';
import { nativeRecentMessages } from './codeLightRecent';
import { createReducer, reducer } from './reducer/reducer';
import { createCodeLightHandoff } from '../utils/codeLightHandoff';

const session = { id: 'relay-session', metadata: { machineId: 'mac-a', client: { id: 'noninvasive-bridge' }, nativeSession: { title: 'Original conversation' },
    bridge: { controlMode: 'session', sourceStatus: 'connected', source: { app: 'codex', hostId: 'local', id: 'native-conversation', runtimeGeneration: 'owner' } } } } as Session;

it('a real recent-window projection retains the original identity needed for handoff', () => {
    const current: PeerRecentWindow = { version: 1, session: { id: session.id, nativeUpdatedAt: 500, basicOnly: false, metadata: session.metadata,
        metadataVersion: 3, agentState: null, agentStateVersion: 2, seq: 100, createdAt: 1, active: true, activeAt: 10 },
        rows: [{ id: 'original-assistant-row', role: 'assistant', turnId: 'native-turn', text: 'Actual projected result', at: 100,
            replaceIds: [], projectionRevision: 1, streamRevision: 3, snapshotRevision: 100, ownerGeneration: 'owner' }],
        nextCursor: null, hasMore: false, ownerGeneration: 'owner', revision: 99, status: 'idle', currentTurnId: null, seq: 100, observedAt: 10000 };
    const state = createReducer();
    const projected = reducer(state, nativeRecentMessages(current));
    const message = projected.messages.find(m => m.kind === 'agent-text');
    expect(message?.meta?.nativeRow).toEqual({ id: 'original-assistant-row', offset: 0, revision: 3 });
    if (message?.kind !== 'agent-text') throw Error('Missing actual projected message');
    expect(createCodeLightHandoff(session, message)?.nativeRow.id).toBe('original-assistant-row');
    expect(createCodeLightHandoff(session, message)?.text).toBe('Actual projected result');
});

it('a native text correction replaces provenance with its own current projection revision', () => {
    const state = createReducer();
    const update: NormalizedMessage = { id: 'correction-wire', localId: null, createdAt: 100, role: 'event', isSidechain: false, turn: 'native-turn',
        content: { type: 'native-row-upsert', sourceRowId: 'original-assistant-row', role: 'assistant', text: 'Corrected original result', revision: 4, replaceIds: [] },
        meta: { sentFrom: 'noninvasive-observer' } };
    const result = reducer(state, [update]);
    const message = result.messages.find(m => m.kind === 'agent-text');
    expect(message?.meta?.nativeRow).toEqual({ id: 'original-assistant-row', offset: 0, revision: 4 });
    if (message?.kind !== 'agent-text') throw Error('Missing corrected original message');
    expect(createCodeLightHandoff(session, message)?.text).toBe('Corrected original result');
});
