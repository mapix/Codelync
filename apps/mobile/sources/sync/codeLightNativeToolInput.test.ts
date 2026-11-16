import { expect, it } from 'vitest';
import fixture from '../../../../test/fixtures/native-antigravity-tools.json';
import { nativeRecentMessages, type PeerRecentWindow } from './codeLightRecent';
import { createReducer, reducer } from './reducer/reducer';
import { RawRecordSchema, normalizeRawMessage, NativeFileArgumentsSchema } from './typesRaw';

function recent(): PeerRecentWindow {
    const tools = fixture.trajectory.steps.filter(step => step.metadata?.toolCall).map(step => {
        const call = step.metadata!.toolCall!;
        return { id: call.id, name: call.name, arguments: JSON.parse(call.argumentsJson) as Record<string, unknown>, output: 'Native result', status: 'completed' };
    });
    return { version: 1, session: { id: 'native-fixture', nativeUpdatedAt: 1, metadata: {} as any, metadataVersion: 1, agentState: null, agentStateVersion: 1, seq: 1, createdAt: 1, active: true, activeAt: 1, basicOnly: false },
        rows: tools.map((tool, index) => ({ id: 'row-' + index, role: 'tool', turnId: 'native-turn', text: '', at: 1, projectionRevision: 1, snapshotRevision: 1, streamRevision: 0, replaceIds: [], ownerGeneration: 'owner', tools: [tool] })),
        hasMore: false, nextCursor: null, revision: 1, ownerGeneration: 'owner', status: 'idle', currentTurnId: null, seq: 1, observedAt: 1 };
}

it('renders original read_file/write_file inputs through recent window and raw row-upsert normalization', () => {
    const state = createReducer(), source = recent(), messages = nativeRecentMessages(source);
    reducer(state, messages);
    const read = [...state.messages.values()].find(row => row.tool?.name === 'read_file');
    const write = [...state.messages.values()].find(row => row.tool?.name === 'write_file');
    expect(read?.tool?.input).toEqual({ Path: '/isolated/codelight-qa/input.json' });
    expect(write?.tool?.input).toEqual({ Path: '/isolated/codelight-qa/result.json', Content: '{"sum":42}\n', Overwrite: true });
    const record = RawRecordSchema.parse({ role: 'session', content: { id: 'native-update', time: 2, role: 'agent', turn: 'native-turn', ev: { t: 'native-row-upsert', sourceRowId: 'row-1', role: 'tool', text: '', revision: 1, replaceIds: [],
        tools: [{ id: 'fixture-write-call', name: 'write_file', input: { Path: '/isolated/codelight-qa/result.json', Content: 'Updated input', Overwrite: true }, output: 'Native result', status: 'completed' }] } } });
    const normalized = normalizeRawMessage('native-update', null, 2, record); expect(normalized).not.toBeNull();
    reducer(state, [normalized!]); reducer(state, [normalized!]);
    const updated = [...state.messages.values()].filter(row => row.tool?.callId === 'fixture-write-call');
    expect(updated).toHaveLength(1); expect(updated[0].tool?.input).toMatchObject({ Content: 'Updated input' });
    expect(updated[0].tool?.state).toBe('completed'); expect(updated[0].tool?.result).toBe('Native result');
});

it('one oversized ordinary input does not discard a recent tool or page and cannot loosen attachment markers', () => {
    const source = recent(); source.rows[0].tools![0].arguments = { Content: 'x'.repeat(65537) };
    const state = createReducer(); reducer(state, nativeRecentMessages(source));
    expect([...state.messages.values()].filter(row => row.tool)).toHaveLength(2);
    expect(NativeFileArgumentsSchema.safeParse({ Path: '/arbitrary/phone/path' }).success).toBe(false);
    const bad = { role: 'session', content: { id: 'invalid-file', time: 2, role: 'agent', turn: 'turn', ev: { t: 'native-row-upsert', sourceRowId: 'file', role: 'tool', text: '', revision: 1, replaceIds: [], tools: [{ id: 'file', name: 'file', input: { Path: '/arbitrary/phone/path' }, output: '', status: 'completed' }] } } };
    expect(RawRecordSchema.safeParse(bad).success).toBe(false);
});
