import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexSavedHistoryReader } from '../src/adapters/codex-history.mjs';
import { CodexBackend } from '../src/adapters/codex-backend.mjs';
import { DatabaseSync } from 'node:sqlite';

/** @typedef {Record<string,any>} Value */
const CHILD = '11111111-1111-4111-8111-111111111111', PARENT = '22222222-2222-4222-8222-222222222222', OTHER = '33333333-3333-4333-8333-333333333333';
const encoded = (/** @type {Value} */ value) => JSON.stringify(value) + '\n';
const message = (/** @type {string} */ id, /** @type {string} */ role, /** @type {string} */ value) => ({ type: 'response_item', timestamp: '2026-11-14T00:00:00Z', payload: { type: 'message', id, role, content: [{ type: 'output_text', text: value }], internal_chat_message_metadata_passthrough: { secret: 'private-metadata' } } });
/** @param {string} id @param {boolean} [child] @param {string} [originator] */
function header(id, child = false, originator = 'Codex Desktop') {
  return { type: 'session_meta', payload: { id, originator, cli_version: 'fixture-desktop', base_instructions: { text: 'private-base-instructions' },
    source: child ? { subagent: { thread_spawn: { parent_thread_id: PARENT, agent_path: '/root/synthetic_child' } } } : 'vscode' } };
}
/** @param {import('node:test').TestContext} t @param {Value[]} [records] @param {number} [maxPageBytes] */
async function fixture(t, records = [message('native-message', 'assistant', 'Original visible text')], maxPageBytes = 8192) {
  const root = await mkdtemp(join(tmpdir(), 'codelync-codex-saved-')); await mkdir(join(root, 'sessions'));
  const parentPath = join(root, 'sessions', PARENT + '.jsonl'), childPath = join(root, 'sessions', CHILD + '.jsonl');
  await writeFile(parentPath, encoded(header(PARENT)), { mode: 0o600 });
  await writeFile(childPath, [header(CHILD, true), ...records].map(encoded).join(''), { mode: 0o600 });
  const metadata = new Map([
    [PARENT, { nativeId: PARENT, rolloutPath: parentPath, parentNativeId: null, isSubagent: false, indexStamp: 'initial-parent' }],
    [CHILD, { nativeId: CHILD, rolloutPath: childPath, parentNativeId: PARENT, isSubagent: true, agentPath: '/root/synthetic_child', indexStamp: 'initial-child' }]
  ]);
  const reader = new CodexSavedHistoryReader({ root, maxPageBytes, loadMetadata: async id => structuredClone(metadata.get(id) ?? null) });
  t.after(async () => { reader.close(); await rm(root, { recursive: true, force: true }); });
  return { root, reader, metadata, childPath, parentPath };
}

test('[S01] original Desktop child/parent proof yields conditional read-only backend capability without native owner requests', async t => {
  const f = await fixture(t), ipc = { dispose() {}, generation: () => null, subscribe: async () => { throw Error('native owner lookup must not run'); } };
  const backend = new CodexBackend({ ipc: /** @type {any} */ (ipc), savedHistoryReader: f.reader });
  t.after(() => backend.dispose());
  assert.equal(backend.supportsNativeSavedHistory, true);
  const view = await backend.readHistoricalPage(CHILD, { expectedParentNativeId: PARENT });
  assert.equal(view.status, 'history-only'); assert.equal(view.ownerGeneration, null); assert.equal(view.currentTurnId, null); assert.deepEqual(view.requests, []);
  assert.equal(view.historicalRead.app, 'codex'); assert.equal(view.historicalRead.parentNativeId, PARENT); assert.equal(view.historicalRead.hostId, 'local');
  assert.equal(view.rows[0].id, 'native-message'); assert.equal(view.rows[0].turnId, null); assert.ok(view.rows[0].displayTurnId);
  assert.equal(backend.sessions.size, 0); assert.equal(backend.generation(CHILD), null);
  const disabled = new CodexBackend({ ipc: /** @type {any} */ (ipc) }); t.after(() => disabled.dispose());
  assert.equal(disabled.supportsNativeSavedHistory, false); await assert.rejects(disabled.readHistoricalPage(CHILD), { code: 'codex-history-unavailable' });
});

test('[S01] CLI origin, foreign native ID and wrong parent cannot enter saved Desktop history', async t => {
  const f = await fixture(t);
  await writeFile(f.parentPath, encoded(header(PARENT, false, 'codex_cli_rs')));
  await assert.rejects(f.reader.readPage(CHILD), { code: 'codex-history-desktop-membership-unverified' });
  await writeFile(f.parentPath, encoded(header(PARENT)));
  await writeFile(f.childPath, encoded(header(OTHER, true)));
  await assert.rejects(f.reader.readPage(CHILD), { code: 'codex-history-desktop-membership-unverified' });
  await writeFile(f.childPath, encoded(header(CHILD, true)));
  await assert.rejects(f.reader.readPage(CHILD, { expectedParentNativeId: OTHER }), { code: 'codex-history-parent-mismatch' });
  await assert.rejects(f.reader.readPage(PARENT), { code: 'codex-history-subagent-unverified' });
});

test('[S02] public saved rows retain native IDs/turn evidence and exclude instructions, developer text and raw reasoning', async t => {
  const records = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'native-turn' } },
    message('user-native', 'user', 'Visible user'), message('private-developer', 'developer', 'private-developer-text'), message('private-system', 'system', 'private-system-text'),
    { type: 'response_item', payload: { type: 'reasoning', id: 'reason-native', summary: [{ type: 'summary_text', text: 'Public summary' }], content: [{ text: 'private-raw-reasoning' }] } },
    { type: 'response_item', payload: { type: 'function_call', id: 'original-call-item', call_id: 'native-call', name: 'synthetic_tool', arguments: '{"secret":"private-arguments"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', id: 'original-output-item', call_id: 'native-call', output: 'Original visible tool output' } },
    message('assistant-native', 'assistant', 'Visible assistant'),
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'native-turn' } }
  ];
  const f = await fixture(t, records), view = await f.reader.readPage(CHILD);
  assert.deepEqual(view.rows.map(row => row.id), ['user-native', 'reason-native', 'native-call', 'assistant-native']);
  assert.ok(view.rows.every(row => row.turnId === 'native-turn')); assert.equal(view.currentTurnId, null);
  const tool = view.rows.find(row => row.role === 'tool'); assert.equal(tool?.tools[0].output, 'Original visible tool output'); assert.equal(tool?.tools[0].status, 'completed');
  assert.ok(!JSON.stringify(view).includes('private-')); assert.equal(view.rows.find(row => row.role === 'reasoning')?.text, 'Public summary');
});

test('[S02] malformed headers and records return content-free reason codes', async t => {
  const f = await fixture(t); await writeFile(f.childPath, '{"secret":"private-header-value\n');
  await assert.rejects(f.reader.readPage(CHILD), error => { assert.ok(!String(error).includes('private-header-value')); return /** @type {Value} */ (error).code === 'codex-history-header-invalid'; });
  await writeFile(f.childPath, encoded(header(CHILD, true)) + '{"secret":"private-record-value\n');
  await assert.rejects(f.reader.readPage(CHILD), error => { assert.ok(!String(error).includes('private-record-value')); return /** @type {Value} */ (error).code === 'codex-history-record-invalid'; });
});

test('[S03] bounded tails and explicit older byte pages preserve anchors across harmless append', async t => {
  const records = Array.from({ length: 80 }, (_, index) => message('native-' + index, 'assistant', 'Visible ' + index + ' '.repeat(120)));
  const f = await fixture(t, records, 1024), recent = await f.reader.readPage(CHILD, { limit: 2 });
  assert.deepEqual(recent.rows.map(row => row.id), ['native-78', 'native-79']);
  assert.equal(recent.historyComplete, false); assert.ok(recent.historicalRead.byteBoundary.start > 0);
  await appendFile(f.childPath, encoded(message('native-80', 'assistant', 'New appended message')));
  const child = f.metadata.get(CHILD); assert.ok(child); child.indexStamp = 'native-activity-timestamp-advanced';
  const older = await f.reader.readPage(CHILD, { beforeByte: recent.historicalRead.byteBoundary.start, sourceStamp: recent.historicalRead.sourceStamp, limit: 2 });
  assert.deepEqual(older.rows.map(row => row.id), ['native-76', 'native-77']);
  assert.equal(older.historicalRead.sourceStamp, recent.historicalRead.sourceStamp);
  const latest = await f.reader.readPage(CHILD, { limit: 2 }); assert.equal(latest.rows.at(-1)?.id, 'native-80');
  await assert.rejects(f.reader.readPage(CHILD, { beforeByte: recent.historicalRead.byteBoundary.start }), { code: 'codex-history-boundary-invalid' });
});

test('[S03] rewind, overwrite and file replacement reject stale saved-history cursors', async t => {
  const f = await fixture(t, [message('first', 'assistant', 'Before'), message('second', 'assistant', 'After')]);
  const recent = await f.reader.readPage(CHILD, { limit: 1 }), boundary = { beforeByte: recent.historicalRead.byteBoundary.start, sourceStamp: recent.historicalRead.sourceStamp };
  await writeFile(f.childPath, encoded(header(CHILD, true)) + encoded(message('rewritten', 'assistant', 'Changed')));
  await assert.rejects(f.reader.readPage(CHILD, boundary), { code: 'codex-history-source-changed' });
  const refreshed = await f.reader.readPage(CHILD, { limit: 1 });
  await rename(f.childPath, f.childPath + '.before'); await writeFile(f.childPath, encoded(header(CHILD, true)) + encoded(message('replacement', 'assistant', 'Replacement')), { mode: 0o600 });
  await assert.rejects(f.reader.readPage(CHILD, { beforeByte: refreshed.historicalRead.byteBoundary.start, sourceStamp: refreshed.historicalRead.sourceStamp }), { code: 'codex-history-source-changed' });
});

test('[S03] incomplete newly appended record stays outside the committed saved byte boundary', async t => {
  const f = await fixture(t); await appendFile(f.childPath, '{"type":"response_item","payload":');
  const view = await f.reader.readPage(CHILD); assert.equal(view.rows[0].id, 'native-message');
  assert.equal(view.historicalRead.trailingIncomplete, true); assert.ok(view.historicalRead.byteBoundary.end < view.historicalRead.byteBoundary.total);
});

test('[S03] append during a capture retains its committed prefix and the next read sees the new item', async t => {
  const f = await fixture(t); let reads = 0;
  f.reader.options.loadMetadata = async id => {
    if (id === CHILD && ++reads === 2) await appendFile(f.childPath, encoded(message('appended-during-read', 'assistant', 'New item')));
    return structuredClone(f.metadata.get(id) ?? null);
  };
  const capture = await f.reader.readPage(CHILD), next = await f.reader.readPage(CHILD);
  assert.equal(capture.rows[0].id, 'native-message'); assert.equal(next.rows.at(-1)?.id, 'appended-during-read');
  assert.equal(capture.historicalRead.sourceStamp, next.historicalRead.sourceStamp);
});

test('[S03] overwrite plus growth cannot masquerade as harmless append of captured bytes', async t => {
  const f = await fixture(t), previous = await f.reader.readPage(CHILD);
  await writeFile(f.childPath, encoded(header(CHILD, true)) + encoded(message('overwritten', 'assistant', 'Changed previous content')) + encoded(message('grown', 'assistant', 'Additional content')));
  await assert.rejects(f.reader.readPage(CHILD, { beforeByte: previous.historicalRead.byteBoundary.start, sourceStamp: previous.historicalRead.sourceStamp }), { code: 'codex-history-source-changed' });
});

test('[S03] terminal fast preflight uses the latest native lifecycle and a new task invalidates it', async t => {
  const f = await fixture(t, [message('answer', 'assistant', 'Visible'), { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'original-turn' } }]);
  const terminal = await f.reader.readPage(CHILD); assert.equal(terminal.historicalRead.lastLifecycle?.type, 'turn_aborted');
  assert.equal(terminal.historicalRead.lastLifecycle?.terminalObserved, true);
  await appendFile(f.childPath, encoded({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-original-turn', thread_id: CHILD } }));
  const started = await f.reader.readPage(CHILD); assert.equal(started.historicalRead.sourceStamp, terminal.historicalRead.sourceStamp);
  assert.equal(started.historicalRead.lastLifecycle?.type, 'task_started'); assert.equal(started.historicalRead.lastLifecycle?.terminalObserved, false);
});

test('[S03] tool completion, unknown lifecycle and incomplete tail cannot imply a terminal child', async t => {
  const f = await fixture(t, [{ type: 'event_msg', payload: { type: 'item_completed', item: { id: 'tool' }, turn_id: 'tool-turn' } }]);
  assert.equal((await f.reader.readPage(CHILD)).historicalRead.lastLifecycle, null);
  await appendFile(f.childPath, encoded({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'original-turn' } }));
  await appendFile(f.childPath, '{"type":"event_msg","payload":');
  assert.equal((await f.reader.readPage(CHILD)).historicalRead.lastLifecycle?.terminalObserved, false);
  await writeFile(f.childPath, encoded(header(CHILD, true)) + encoded({ type: 'event_msg', payload: { type: 'task_future_state', turn_id: 'future-turn' } }));
  assert.equal((await f.reader.readPage(CHILD)).historicalRead.lastLifecycle?.terminalObserved, false);
});

test('[S04] release fences an in-flight historical read and a new scope can re-enter', async t => {
  const f = await fixture(t); let resume = /** @type {()=>void} */ (() => {});
  const waiting = new Promise(resolve => { resume = () => resolve(undefined); }); let blocked = false;
  f.reader.options.loadMetadata = async id => { if (id === CHILD && !blocked) { blocked = true; await waiting; } return structuredClone(f.metadata.get(id) ?? null); };
  const read = f.reader.readPage(CHILD); read.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 5)); f.reader.release(CHILD); resume();
  await assert.rejects(read, { code: 'codex-history-read-released' });
  assert.equal((await f.reader.readPage(CHILD)).rows[0].id, 'native-message');
});

test('[S04] native index/path changes during a read cannot publish into the old scope', async t => {
  const f = await fixture(t); let reads = 0;
  f.reader.options.loadMetadata = async id => {
    const value = structuredClone(f.metadata.get(id) ?? null);
    if (id === CHILD && ++reads > 1 && value) value.agentPath = '/root/replaced_child';
    return value;
  };
  await assert.rejects(f.reader.readPage(CHILD), { code: 'codex-history-source-changed' });
});

test('[S01] the original-shaped read-only SQLite index supplies only selected child membership', async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,source TEXT,agent_path TEXT,archived INTEGER,updated_at_ms INTEGER)');
  const insert = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)');
  insert.run(PARENT, f.parentPath, 'vscode', null, 0, 1);
  insert.run(CHILD, f.childPath, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: PARENT, agent_path: '/root/synthetic_child' } } }), '/root/synthetic_child', 0, 2);
  db.close();
  const reader = new CodexSavedHistoryReader({ root: f.root }); t.after(() => reader.close());
  const view = await reader.readPage(CHILD); assert.equal(view.historicalRead.parentNativeId, PARENT); assert.equal(view.ownerGeneration, null);
});

test('[S02] foreign canonical paths fail before reading their contents', async t => {
  const f = await fixture(t), child = f.metadata.get(CHILD); assert.ok(child);
  child.rolloutPath = join(f.root, 'foreign.jsonl');
  await writeFile(child.rolloutPath, encoded(header(CHILD, true)) + encoded(message('foreign', 'assistant', 'private-foreign-content')));
  await assert.rejects(f.reader.readPage(CHILD), error => { assert.ok(!String(error).includes('private-foreign-content')); return /** @type {Value} */ (error).code === 'codex-history-foreign-path'; });
});

test('[S04] backend rejects a fabricated historical control owner and still closes IPC if reader cleanup fails', async t => {
  const f = await fixture(t), view = await f.reader.readPage(CHILD); let disposed = false;
  const ipc = { dispose() { disposed = true; } };
  const backend = new CodexBackend({ ipc: /** @type {any} */ (ipc), savedHistoryReader: { readPage: async () => ({ ...view, ownerGeneration: 'fabricated-owner' }), close() { throw Error('synthetic cleanup failure'); } } });
  await assert.rejects(backend.readHistoricalPage(CHILD), { code: 'codex-history-view-unverified' });
  assert.throws(() => backend.dispose(), /synthetic cleanup failure/); assert.equal(disposed, true);
});

test('[S04] backend forwarding allowlists historical fields and returns independent consumer values', async t => {
  const f = await fixture(t), view = await f.reader.readPage(CHILD);
  const supplied = { ...view, privateHeader: 'private-extra-state', historicalRead: { ...view.historicalRead, privateConfig: 'private-extra-proof' },
    rows: view.rows.map(row => ({ ...row, internalMetadata: 'private-extra-row' })) };
  const backend = new CodexBackend({ ipc: /** @type {any} */ ({ dispose() {} }), savedHistoryReader: { readPage: async () => supplied } }); t.after(() => backend.dispose());
  const first = await backend.readHistoricalPage(CHILD); assert.ok(!JSON.stringify(first).includes('private-extra'));
  first.rows[0].text = 'Mutated consumer';
  assert.equal((await backend.readHistoricalPage(CHILD)).rows[0].text, 'Original visible text');
});
