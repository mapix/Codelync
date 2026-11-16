import { describe, expect, it } from 'vitest';
import { nativeRecentMessages, peerDescriptorSession, isCurrentNativeRecent, type PeerRecentWindow } from './codeLightRecent';
import { createReducer, reducer } from './reducer/reducer';
import { messageSortKey } from './typesMessage';
import type { NormalizedMessage } from './typesRaw';
import { RawRecordSchema, normalizeRawMessage } from './typesRaw';

function window(): PeerRecentWindow {
    return { version: 1, session: { id: 'original-mirror', nativeUpdatedAt: 500, basicOnly: false, metadata: { path: '/fixture', host: 'fixture' } as any,
        metadataVersion: 3, agentState: null, agentStateVersion: 2, seq: 100, createdAt: 1, active: true, activeAt: 10 },
        rows: [{ id: 'original-text', role: 'assistant', turnId: 'original-turn', text: 'complete original text, not a suffix', at: 100, order: 10,
            replaceIds: ['wire-part-one', 'wire-part-two'], projectionRevision: 1, streamRevision: 0, snapshotRevision: 100, ownerGeneration: 'owner' },
            { id: 'original-tool', role: 'tool', turnId: 'original-turn', text: '', at: 100, order: 11, replaceIds: [], projectionRevision: 1,
                streamRevision: 0, snapshotRevision: 100, ownerGeneration: 'owner', tools: [{ id: 'original-call', name: 'read_fixture', output: 'complete result', status: 'completed' }] }],
        nextCursor: 'earlier-cursor', hasMore: true, ownerGeneration: 'owner', revision: 99, status: 'active', currentTurnId: 'original-turn', seq: 100, observedAt: 10000 };
}

describe('self-contained native recent windows', () => {
    it('seeds assistant-envelope tools independently without allowing a tool-only UUID to claim a consumed text alias', () => {
        const state = createReducer(), source = window();
        source.rows = [{ ...source.rows[0], id: 'native-full-text', text: 'Confirmed original body', replaceIds: ['api-wire'], replaceSourceRowIds: ['claude-api:shared'] }];
        reducer(state, nativeRecentMessages(source));
        source.rows = [{ ...source.rows[0], id: 'native-full-tool', text: '', tools: [{ id: 'native-tool-call', name: 'Shell', output: 'Original result', status: 'completed' }] }];
        const projected = nativeRecentMessages(source);
        expect(projected).toHaveLength(2);
        reducer(state, projected); reducer(state, projected);
        expect(state.messages.get(state.nativeRowIds.get('native-full-text')!)?.text).toBe('Confirmed original body');
        expect(state.nativeRowIds.get('native-full-text')).not.toBe(state.nativeRowIds.get('native-full-tool'));
        const tools = [...state.messages.values()].filter(row => row.tool);
        expect(tools).toHaveLength(1);
        expect(tools[0].tool).toMatchObject({ callId: 'native-tool-call', state: 'completed', result: 'Original result' });
        const whitespaceEnvelope = { ...source.rows[0], id: 'native-whitespace-tool', text: ' \n ' };
        reducer(state, nativeRecentMessages({ ...source, rows: [whitespaceEnvelope] }));
        expect(state.messages.get(state.nativeRowIds.get('native-full-text')!)?.text).toBe('Confirmed original body');
        expect(state.nativeRowIds.get('native-full-text')).not.toBe(state.nativeRowIds.get('native-whitespace-tool'));
        source.rows[0].text = 'This envelope also has original text'; source.rows[0].snapshotRevision++;
        reducer(state, nativeRecentMessages(source));
        expect(state.messages.get(state.nativeRowIds.get('native-full-tool')!)?.text).toBe('This envelope also has original text');
        expect(state.messages.get(state.nativeRowIds.get('native-full-text')!)?.text).toBe('Confirmed original body');
    });
    it('records only actual native timestamps while keeping legacy display and sort fallback unchanged', () => {
        const source = window(); source.rows = [source.rows[0]];
        let messages = reducer(createReducer(), nativeRecentMessages(source)).messages;
        expect(messages[0].meta?.nativeTimestamp).toBe(100);
        expect(messages[0].createdAt).toBe(100);
        source.rows[0].at = null;
        messages = reducer(createReducer(), nativeRecentMessages(source)).messages;
        expect(messages[0].meta?.nativeTimestamp).toBeNull();
        expect(messages[0].createdAt).toBe(source.session.nativeUpdatedAt);
        expect(messageSortKey(messages[0])).toBe(source.session.nativeUpdatedAt + 10 / 1000);
    });
    it('keeps original image file parameters across fresh seeds, stream corrections and repeated reads', () => {
        const state = createReducer(), current = window();
        const args = { nativeImageId: 'original-image', name: 'image.png' };
        current.rows = [{ ...current.rows[1], id: 'original-image', tools: [{ id: 'original-image', name: 'view_image', output: 'Image could not be loaded.', status: 'failed' }] }];
        reducer(state, nativeRecentMessages(current));
        const record = RawRecordSchema.parse({ role: 'session', content: { id: 'image-recovery', time: 101, role: 'agent', turn: 'original-turn',
            ev: { t: 'native-row-upsert', sourceRowId: 'original-image', role: 'tool', text: '', revision: 1, replaceIds: [],
                tools: [{ id: 'original-image', name: 'file', output: '', status: 'completed', arguments: args }] } } });
        const update = normalizeRawMessage('image-recovery', null, 101, record)!;
        reducer(state, [update]); reducer(state, [update]);
        current.rows[0].snapshotRevision++;
        current.rows[0].streamRevision = 1;
        current.rows[0].tools = [{ id: 'original-image', name: 'file', output: '', status: 'completed', arguments: args }];
        reducer(state, nativeRecentMessages(current)); reducer(state, nativeRecentMessages(current));
        const tools = [...state.messages.values()].filter(row => row.tool);
        expect(tools).toHaveLength(1);
        expect(tools[0].tool).toMatchObject({ callId: 'original-image', name: 'file', input: args, state: 'completed', result: '' });
        const freshState = createReducer(); reducer(freshState, nativeRecentMessages(current));
        expect([...freshState.messages.values()][0].tool?.input).toEqual(args);
    });
    it('a confirmed native own-input window joins the optimistic row before its POST acknowledgment', () => {
        const state = createReducer();
        const optimistic: NormalizedMessage = { id: 'phone-local', localId: 'phone-local', createdAt: 120, role: 'user', isSidechain: false,
            meta: { sentFrom: 'ios', expectsAcceptance: true, nativeTimestamp: 999 }, content: { type: 'text', text: 'Own input' } };
        reducer(state, [optimistic], null, { holdUserMessagesUntilAccepted: true });
        const current = window(); current.rows = [{ ...current.rows[0], id: 'native-user-row', role: 'user', text: 'Own input', at: 100,
            replaceIds: ['server-user', 'phone-local'] }];
        reducer(state, nativeRecentMessages(current));
        current.rows[0].snapshotRevision++;
        reducer(state, nativeRecentMessages(current));
        const rows = [...state.messages.values()].filter(row => row.role === 'user');
        expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ text: 'Own input', pending: false, localId: 'phone-local', createdAt: 120, meta: { nativeTimestamp: 100 } });
    });
    it('native fragment identity survives the real encrypted-record normalization contract', () => {
        const state = createReducer();
        for (const [index, text, offset] of [[0, 'Hello', 0], [1, ' world', 5]] as const) {
            const record = RawRecordSchema.parse({ role: 'session', content: { id: `fragment-${index}`, time: 100 + index, role: 'agent', turn: 'original-turn', ev: { t: 'text', text } },
                meta: { sentFrom: 'noninvasive-observer', nativeRow: { id: 'native-original-row', offset, revision: 0 } } });
            const normalized = normalizeRawMessage(`wire-${index}`, null, 100 + index, record);
            expect(normalized?.meta?.nativeRow?.id).toBe('native-original-row');
            reducer(state, [normalized!]);
        }
        expect([...state.messages.values()].filter(row => row.text !== null).map(row => row.text)).toEqual(['Hello world']);
    });
    it('keeps one canonical row across old fragments, repeated full windows and late history', () => {
        const state = createReducer();
        const part: NormalizedMessage = { id: 'wire-part-one', localId: null, createdAt: 90, role: 'agent', isSidechain: false, turn: 'original-turn',
            content: [{ type: 'text', text: 'old prefix', uuid: 'wire-part-one', parentUUID: null }] };
        reducer(state, [part]);
        reducer(state, nativeRecentMessages(window()));
        const next = window(); next.rows[0].snapshotRevision++;
        reducer(state, nativeRecentMessages(next));
        reducer(state, [part]);
        expect([...state.messages.values()].filter(row => row.text !== null && !row.tool)).toHaveLength(1);
    });

    it('joins streamed prefixes to the native row and a fresh full window without duplicating text', () => {
        const state = createReducer();
        const part = (id: string, text: string, offset: number): NormalizedMessage => ({ id, localId: null, createdAt: 100 + offset,
            role: 'agent', isSidechain: false, turn: 'original-turn', meta: { sentFrom: 'noninvasive-observer', nativeRow: { id: 'original-text', offset, revision: 0 } },
            content: [{ type: 'text', text, uuid: id, parentUUID: null }] });
        reducer(state, [part('stream-a', 'Hello', 0)]);
        reducer(state, [part('stream-c', '!', 11)]); // A gap is not a separate message.
        reducer(state, [part('stream-b', ' world', 5)]);
        expect([...state.messages.values()].filter(row => row.text !== null).map(row => row.text)).toEqual(['Hello world!']);
        const fresh = window(); fresh.rows = [{ ...fresh.rows[0], text: 'Hello world!', replaceIds: ['stream-a', 'stream-b', 'stream-c'] }];
        reducer(state, nativeRecentMessages(fresh));
        reducer(state, [part('stream-d', ' Again', 12)]);
        expect([...state.messages.values()].filter(row => row.text !== null).map(row => row.text)).toEqual(['Hello world! Again']);
    });
    it('renders full text and completed tool results with no earlier protocol seed', () => {
        const result = reducer(createReducer(), nativeRecentMessages(window()));
        expect(result.messages.find(message => message.kind === 'agent-text')).toMatchObject({ text: 'complete original text, not a suffix', createdAt: 100 });
        expect(result.messages.find(message => message.kind === 'tool-call')).toMatchObject({ tool: { callId: 'original-call', state: 'completed', result: 'complete result' } });
        const ordered = [...result.messages].sort((a, b) => messageSortKey(b) - messageSortKey(a));
        expect(ordered[0].kind).toBe('tool-call');
        expect(ordered.every(message => message.createdAt !== 10000)).toBe(true);
    });

    it('snapshot revisions cannot suppress a later lower-numbered stream correction or roll it back', () => {
        const state = createReducer();
        reducer(state, nativeRecentMessages(window()));
        const correction: NormalizedMessage = { id: 'wire-correction', localId: null, createdAt: 120, role: 'event', isSidechain: false, turn: 'original-turn', content: {
            type: 'native-row-upsert', sourceRowId: 'original-text', role: 'assistant', text: 'corrected by later native stream', revision: 1, replaceIds: [],
        } };
        const changed = reducer(state, [correction]);
        expect(changed.messages.find(message => message.kind === 'agent-text')).toMatchObject({ text: 'corrected by later native stream' });
        const stale = window(); stale.rows[0].snapshotRevision = 101;
        reducer(state, nativeRecentMessages(stale));
        expect(state.messages.get('native:original-text')?.text).toBe('corrected by later native stream');
        const fresh = window(); fresh.rows[0] = { ...fresh.rows[0], snapshotRevision: 102, streamRevision: 1, text: 'complete current corrected text' };
        reducer(state, nativeRecentMessages(fresh));
        expect(state.messages.get('native:original-text')?.text).toBe('complete current corrected text');
    });
    it('an older running tool snapshot cannot reopen a completed approved tool', () => {
        const source = window(); source.rows = [source.rows[1]]; source.rows[0].tools![0].status = 'running';
        const state = createReducer(); reducer(state, nativeRecentMessages(source));
        const id = state.toolIdToMessageId.get('original-call')!;
        state.messages.get(id)!.tool!.permission = { id: 'approved-request', status: 'approved' };
        const completed: NormalizedMessage = { id: 'newer-native-end', localId: null, createdAt: 200, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-result', tool_use_id: 'original-call', content: 'latest complete result', is_error: false, uuid: 'newer-native-end', parentUUID: null }] };
        reducer(state, [completed]);
        source.rows[0].snapshotRevision++;
        reducer(state, nativeRecentMessages(source));
        expect(state.messages.get(id)!.tool).toMatchObject({ state: 'completed', result: 'latest complete result' });
    });

    it('catalog native time replaces mirror provisioning time without deriving running from recency', () => {
        const descriptor = window().session;
        const session = peerDescriptorSession({ ...descriptor, nativeUpdatedAt: 50, basicOnly: true, active: false });
        expect(session.updatedAt).toBe(50); expect(session.thinking).toBe(false);
    });
    it('late descriptors keep newer owner fields and local cleared drafts while basic records retain already-opened cache', () => {
        const descriptor = window().session;
        const previous = peerDescriptorSession(descriptor); previous.metadataVersion = 8; previous.agentStateVersion = 9; previous.draft = null;
        previous.metadata = { ...previous.metadata, bridge: { source: { runtimeGeneration: 'new-owner' } }, nativeControls: { preserved: true } } as any;
        previous.agentState = { communications: { latest: { kind: 'form', form: { questions: [] } } } } as any;
        const late = peerDescriptorSession(descriptor, previous);
        expect(late.metadata).toBe(previous.metadata); expect(late.agentState).toBe(previous.agentState); expect(late.draft).toBeNull();
        expect(isCurrentNativeRecent(window(), previous)).toBe(false);
        const basic = peerDescriptorSession({ ...descriptor, basicOnly: true, metadataVersion: 8, metadata: { path: '/fixture', host: 'fixture' } as any }, previous);
        expect(basic.metadata?.nativeControls).toEqual({ preserved: true });
    });
});
