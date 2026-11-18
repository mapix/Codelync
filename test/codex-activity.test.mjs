import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexActivityObserver } from '../src/adapters/codex-activity.mjs';

/** @typedef {Record<string, any>} Value */
class ActivityIpc {
  socket = { destroyed: false };
  clientId = 'fixture-follower';
  owner = /** @type {string|null} */ ('local:original');
  callbacks = /** @type {Set<(frame:Value)=>void>} */ (new Set());
  subscriptions = 0; releases = 0; refreshes = 0; connects = 0; disposals = 0;
  failStart = false;
  /** @param {string} _id */ generation(_id) { return this.owner; }
  async connect() { this.connects++; }
  /** @param {string} _id @param {(frame:Value)=>void} callback */
  async subscribe(_id, callback) {
    this.subscriptions++;
    if (this.failStart) throw Error('Owner unavailable');
    this.callbacks.add(callback);
    return () => { if (this.callbacks.delete(callback)) this.releases++; };
  }
  /** @param {string} _id */ async refreshSnapshot(_id) { this.refreshes++; }
  /** @param {Value} change @param {Value} [overrides] */
  emit(change, overrides = {}) {
    const frame = { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: this.owner?.split(':').at(-1),
      params: { conversationId: 'native-thread', hostId: 'local', change }, ...overrides };
    for (const callback of this.callbacks) callback(frame);
  }
  /** @param {Value} state @param {number} [revision] */ snapshot(state, revision = 1) { this.emit({ type: 'snapshot', revision, conversationState: state }); }
  /** @param {Value[]} patches @param {number} baseRevision @param {number} revision */ patch(patches, baseRevision, revision) { this.emit({ type: 'patches', patches, baseRevision, revision }); }
  dispose() { this.disposals++; }
}
/** @param {Value[]} [items] @returns {Value} */
function state(items = []) { return { threadRuntimeStatus: { type: 'active', activeFlags: [] }, requests: [], turns: [{ turnId: 'turn-1', status: 'inProgress', items }] }; }
/** @param {string} itemId */
function questionId(itemId) { return JSON.stringify(['request_user_input_async', itemId, 0]); }
/** @param {string} itemId */
function reply(itemId) { return `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: questionId(itemId), question: 'Fixture question', answer: 'PRIVATE_ANSWER' }])}\n</send_user_message_question_reply>`; }
/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const ipc = new ActivityIpc();
  const observer = new CodexActivityObserver({ id: 'native-thread', ipc, now: () => 101 });
  t.after(() => observer.close());
  await observer.start();
  return { ipc, observer };
}
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

test('large native content is discarded without reading or cloning tool/text fields', async t => {
  const { ipc, observer } = await fixture(t);
  const large = 'PRIVATE_LARGE_CONTENT'.repeat(200000);
  const native = state([
    { id: 'question-item', type: 'agentMessage', questions: [{ title: large, get options() { throw Error('Options must not be read'); } }], get text() { throw Error('Assistant text must not be read'); } },
    { type: 'mcpToolCall', get result() { throw Error('Tools must not be read'); } },
    { type: 'userMessage', content: [{ type: 'text', text: large }] },
    { type: 'reasoning', get summary() { throw Error('Reasoning must not be read'); } },
  ]);
  native.requests.push({ get params() { throw Error('Request contents must not be read'); } });
  native.getUnused = { get content() { throw Error('Unrelated state must not be read'); } };
  ipc.snapshot(native, 22);
  const { aggregateActivity, ownKnown, ownActive, ownWaiting, ...display } = /** @type {Value} */ (observer.status());
  assert.deepEqual(display, { known: true, active: true, waiting: true, status: 'ready', observedAt: 101, generation: 'local:original', revision: 22 });
  assert.deepEqual([ownKnown, ownActive, ownWaiting], [true, true, true]);
  assert.equal(aggregateActivity.rosterComplete, false);
  const kept = JSON.stringify(observer.replica);
  assert.ok(kept.length < 500);
  assert.ok(!kept.includes('PRIVATE_'));
  native.threadRuntimeStatus.type = 'idle'; native.turns[0].items[0].id = 'modified-by-owner';
  assert.equal(observer.status().active, true);
  assert.ok(kept.includes('question-item'));
  assert.equal(ipc.refreshes, 0);
});

test('current/latest turn scope retires old questions and active/waiting remain independent', async t => {
  const { ipc, observer } = await fixture(t);
  ipc.snapshot(state([{ id: 'question-item', type: 'agentMessage', questions: [{ title: 'Question' }] }]));
  assert.equal(observer.status().waiting, true);
  ipc.patch([
    { op: 'replace', path: ['turns', 0, 'status'], value: 'completed' },
    { op: 'add', path: ['turns', 1], value: { turnId: 'turn-2', status: 'inProgress', items: [] } },
  ], 1, 2);
  assert.equal(observer.status().waiting, false);
  assert.equal(observer.status().active, true);
  ipc.patch([{ op: 'replace', path: ['turns', 1], value: { turnId: 'turn-2', status: 'completed', items: [{ id: 'latest-question', type: 'agentMessage', questions: [{ title: 'Latest' }] }] } },
    { op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' }], 2, 3);
  assert.equal(observer.status().waiting, true);
  assert.equal(observer.status().active, false);
  ipc.snapshot({ ...state(), turns: [] }, 4);
  assert.equal(observer.status().waiting, false);
});

test('only accepted marker evidence answers a question and no answer text is retained', async t => {
  const { ipc, observer } = await fixture(t);
  const native = state([
    { id: 'question-item', type: 'agentMessage', questions: [{ title: 'Question' }] },
    { id: 'pending', type: 'steeringUserMessage', status: 'pending', input: [{ type: 'text', text: reply('question-item') }] },
  ]);
  ipc.snapshot(native);
  assert.equal(observer.status().waiting, true);
  assert.ok(!JSON.stringify(observer.replica).includes(questionId('question-item')));
  ipc.patch([{ op: 'add', path: ['turns', 0, 'items', 2], value: { type: 'userMessage', content: [{ type: 'text', text: reply('question-item') }] } }], 1, 2);
  assert.equal(observer.status().waiting, false);
  assert.ok(!JSON.stringify(observer.replica).includes('PRIVATE_ANSWER'));
  ipc.patch([{ op: 'remove', path: ['turns', 0, 'items', 2] }], 2, 3);
  assert.equal(observer.status().waiting, true);
  ipc.patch([{ op: 'replace', path: ['turns', 0, 'items', 1, 'status'], value: 'accepted' }], 3, 4);
  assert.equal(observer.status().known, false);
  await flush(); assert.equal(ipc.refreshes, 1);
  native.turns[0].items[1].status = 'accepted'; ipc.snapshot(native, 4);
  assert.equal(observer.status().waiting, false);
});

test('canonical island ordering selects native current/latest turn, then legacy empty fallback', async t => {
  const { ipc, observer } = await fixture(t);
  const native = { threadRuntimeStatus: { type: 'idle', activeFlags: [] }, requests: [],
    turnHistory: { history: { entitiesByKey: { tail: { turnId: 'new', status: 'completed', items: [] }, old: { turnId: 'old', status: 'completed', items: [{ type: 'agentMessage', id: 'old-q', questions: [{ title: 'Old question' }] }] } }, islands: [{ entries: [{ value: 'old' }, { value: 'tail' }] }] } },
    turns: [{ turnId: 'fallback', status: 'completed', items: [{ type: 'agentMessage', id: 'fallback-q', questions: [{ title: 'Wrong fallback' }] }] }] };
  ipc.snapshot(native); assert.equal(observer.status().waiting, false);
  ipc.patch([{ op: 'replace', path: ['turnHistory', 'history', 'islands', 0, 'entries', 1, 'value'], value: 'old' }], 1, 2);
  assert.equal(observer.status().known, false); await flush(); assert.equal(ipc.refreshes, 1);
  native.turnHistory.history.islands = []; ipc.snapshot(native, 2); assert.equal(observer.status().waiting, true);
});

test('unrelated large deltas advance revision while flags and request membership update counters', async t => {
  const { ipc, observer } = await fixture(t);
  ipc.snapshot(state([{ type: 'mcpToolCall' }, { type: 'agentMessage', id: 'a' }]));
  ipc.patch([
    { op: 'replace', path: ['turns', 0, 'items', 0, 'result'], get value() { throw Error('Tool delta must not be read'); } },
    { op: 'replace', path: ['turns', 0, 'items', 1, 'text'], get value() { throw Error('Text delta must not be read'); } },
  ], 1, 2);
  assert.equal(observer.status().revision, 2); assert.equal(observer.status().known, true);
  ipc.patch([{ op: 'add', path: ['threadRuntimeStatus', 'activeFlags', 0], value: 'waitingOnApproval' }], 2, 3);
  assert.equal(observer.status().waiting, true);
  ipc.patch([{ op: 'remove', path: ['threadRuntimeStatus', 'activeFlags', 0] }, { op: 'add', path: ['requests', 0], value: { secret: 'PRIVATE_REQUEST' } }], 3, 4);
  assert.equal(observer.status().waiting, true);
  ipc.patch([{ op: 'remove', path: ['requests', 0] }], 4, 5);
  assert.equal(observer.status().waiting, false); assert.equal(ipc.refreshes, 0);
});

test('patch gaps and invalid batches become unknown without publishing partial facts', async t => {
  const { ipc, observer } = await fixture(t);
  ipc.snapshot(state(), 5);
  ipc.patch([{ op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' }], 4, 6);
  assert.equal(observer.status().known, false); await flush(); assert.equal(ipc.refreshes, 1);
  ipc.snapshot(state(), 6);
  ipc.patch([{ op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' }, { op: 'replace', path: ['turns', 99, 'status'], value: 'completed' }], 6, 7);
  assert.equal(observer.status().known, false); assert.equal(observer.replica, null);
  await flush(); assert.equal(ipc.refreshes, 2);
  ipc.snapshot(state(), 7);
  ipc.patch([], 6, 7); assert.equal(observer.status().known, true); assert.equal(observer.status().revision, 7);
});

test('owner generation changes invalidate old cache until a new owner snapshot arrives', async t => {
  const { ipc, observer } = await fixture(t);
  ipc.snapshot(state(), 9);
  ipc.owner = 'local:replacement';
  assert.equal(observer.status().known, false); assert.equal(ipc.releases, 1);
  await observer.refresh(); assert.equal(ipc.subscriptions, 2);
  ipc.patch([], 9, 10); assert.equal(observer.status().known, false);
  ipc.snapshot({ ...state(), threadRuntimeStatus: { type: 'idle', activeFlags: [] }, turns: [],
    turnHistory: { history: { entitiesByKey: {}, islands: [], isComplete: true } } }, 1);
  assert.equal(observer.status().known, true); assert.equal(observer.status().generation, 'local:replacement');
  assert.equal(observer.status().active, false);
});

test('ready requires the same live IPC connection and follower epoch as its native snapshot', async t => {
  const { ipc, observer } = await fixture(t);
  ipc.snapshot(state()); assert.equal(observer.status().known, true);
  ipc.socket.destroyed = true;
  assert.equal(observer.status().known, false); assert.equal(observer.status().status, 'unavailable');
  ipc.socket = { destroyed: false }; ipc.clientId = 'next-follower';
  assert.equal(observer.status().known, false);
  for (const callback of ipc.callbacks) callback({ type: 'bridge/status', status: 'connected' });
  assert.equal(observer.status().known, false);
  ipc.snapshot(state(), 2); assert.equal(observer.status().known, true);
  ipc.clientId = 'another-follower';
  assert.equal(observer.status().known, false);
  ipc.snapshot(state(), 3); assert.equal(observer.status().known, true);
});

test('unsupported runtime/flags, missing owner, wrong version, and resource limits never mean idle', async t => {
  const { ipc, observer } = await fixture(t);
  ipc.snapshot({ ...state(), threadRuntimeStatus: { type: 'new-enum', activeFlags: [] } }); assert.equal(observer.status().known, false);
  ipc.snapshot({ ...state(), threadRuntimeStatus: { type: 'active', activeFlags: ['background'] } }, 2); assert.equal(observer.status().known, false);
  ipc.owner = null; ipc.snapshot(state(), 3); assert.equal(observer.status().known, false);
  ipc.owner = 'local:original'; ipc.emit({ type: 'snapshot', revision: 4, conversationState: state() }, { version: 12 }); assert.equal(observer.status().known, false);
  ipc.emit({ type: 'snapshot', revision: 5, conversationState: state() }, { version: 13 }); assert.equal(observer.status().known, true); assert.equal(observer.status().active, true); assert.equal(observer.status().waiting, false);
  ipc.emit({ type: 'patches', baseRevision: 5, revision: 6, patches: [{ op: 'add', path: ['threadRuntimeStatus', 'activeFlags', 0], value: 'waitingOnApproval' }] }, { version: 13 });
  assert.equal(observer.status().known, true); assert.equal(observer.status().active, true); assert.equal(observer.status().waiting, true);
  ipc.emit({ type: 'snapshot', revision: 7, conversationState: state() }, { version: 12 }); assert.equal(observer.status().known, false);
  ipc.snapshot({ ...state(), turns: Array.from({ length: 2049 }, (_, i) => ({ turnId: String(i), status: 'completed', items: [] })) }, 8);
  assert.equal(observer.status().known, false); assert.equal(observer.replica, null);
  ipc.snapshot({ ...state(), requests: [null] }, 9); assert.equal(observer.status().known, false);
});

test('question title removal preserves other question indices and empty latest identity does not revive history', async t => {
  const { ipc, observer } = await fixture(t);
  const native = state([{ id: 'question-item', type: 'agentMessage', questions: [{ title: 'First' }, { title: 'Second' }] },
    { type: 'userMessage', content: [{ type: 'text', text: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'question-item', 1]), question: 'Second', answer: 'Answered' }])}</send_user_message_question_reply>` }] }]);
  ipc.snapshot(native); assert.equal(observer.status().waiting, true);
  ipc.patch([{ op: 'remove', path: ['turns', 0, 'items', 0, 'questions', 0, 'title'] }], 1, 2);
  assert.equal(observer.status().known, true); assert.equal(observer.status().waiting, false);
  native.turns[0].turnId = ''; ipc.snapshot(native, 3); assert.equal(observer.status().waiting, false);
});

test('native child lifecycle and explicit roster completeness update an idle parent through reduced patches', async t => {
  const { ipc, observer } = await fixture(t);
  const lifecycle = { type: 'subAgentActivity', id: 'native-event', agentThreadId: 'child', agentPath: '/root/child', kind: 'started',
    get prompt() { throw Error('Child prompt must not be read'); }, get text() { throw Error('Child history must not be read'); } };
  ipc.snapshot({ threadRuntimeStatus: { type: 'idle', activeFlags: [] }, requests: [],
    turnHistory: { history: { entitiesByKey: { parent: { turnId: 'parent-turn', status: 'completed', items: [lifecycle] } },
      islands: [{ entries: [{ value: 'parent' }] }], isComplete: true } } });
  const initial = /** @type {Value} */ (observer.status());
  assert.equal(initial.active, true); assert.equal(initial.ownActive, false); assert.equal(initial.aggregateActivity.childCount, 1);
  ipc.patch([{ op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'parent', 'items', 0, 'kind'], value: 'completed' }], 1, 2);
  assert.equal(observer.status().active, false); assert.equal(observer.status().known, true);
  ipc.patch([{ op: 'replace', path: ['turnHistory', 'history', 'isComplete'], value: false }], 2, 3);
  assert.equal(observer.status().known, false); assert.equal(/** @type {Value} */ (observer.status()).ownKnown, true);
  ipc.patch([{ op: 'replace', path: ['turnHistory', 'history', 'isComplete'], value: true }], 3, 4);
  assert.equal(observer.status().known, true);
  assert.equal(ipc.refreshes, 0); assert.equal(ipc.subscriptions, 1);
});

test('idle own status without an explicit complete native roster stays unknown', async t => {
  const { ipc, observer } = await fixture(t);
  ipc.snapshot({ ...state(), threadRuntimeStatus: { type: 'idle', activeFlags: [] }, turns: [] });
  const value = /** @type {Value} */ (observer.status());
  assert.equal(value.ownKnown, true); assert.equal(value.known, false); assert.equal(value.aggregateActivity.status, 'unknown');
});

test('cold owner failures stay unconfirmed and closing before start prevents late subscriptions', async t => {
  const { ipc, observer } = await fixture(t);
  observer.close(); assert.equal(ipc.releases, 1); assert.equal(ipc.disposals, 0);
  const cold = new ActivityIpc(); cold.failStart = true;
  const missing = new CodexActivityObserver({ id: 'native-thread', ipc: cold });
  t.after(() => missing.close()); await missing.start();
  assert.equal(missing.status().known, false); assert.equal(missing.status().status, 'unavailable');
  const lateIpc = new ActivityIpc();
  const late = new CodexActivityObserver({ id: 'native-thread', ipc: lateIpc });
  const pending = late.start(); late.close(); await pending; assert.equal(lateIpc.subscriptions, 0);
});

test('scope-valid own idle with incomplete roster keeps observation health without claiming aggregate idle', async t => {
  const { ipc, observer } = await fixture(t);
  const native = state(); native.threadRuntimeStatus.type = 'idle'; native.turns[0].status = 'completed';
  ipc.snapshot(native);
  const activity = /** @type {Value} */ (observer.status());
  assert.equal(activity.ownKnown, true); assert.equal(activity.known, false);
  assert.equal(activity.aggregateActivity.rosterComplete, false); assert.equal(observer.observationReady(), true); assert.equal(observer.needsRefresh(), false);
  const captured = observer.status().observedAt;
  assert.equal(observer.status().status, 'unavailable'); assert.equal(observer.status().observedAt, captured);
  ipc.owner = 'local:new-owner'; assert.equal(observer.observationReady(), false); assert.equal(observer.needsRefresh(), true);
  await observer.refresh(); assert.equal(ipc.subscriptions, 2);
  ipc.snapshot(native, 2); assert.equal(observer.observationReady(), true); assert.equal(observer.status().known, false);
  observer.close(); assert.equal(observer.observationReady(), false); assert.equal(observer.needsRefresh(), false);
});

test('v13 idle runtime union omitting activeFlags stays known across snapshot and transition patches', async t => {
  const { ipc, observer } = await fixture(t);
  ipc.emit({
    type: 'snapshot',
    revision: 1,
    conversationState: {
      threadRuntimeStatus: { type: 'idle' },
      requests: [],
      turnHistory: { history: { entitiesByKey: {}, islands: [], isComplete: true } },
    },
  }, { version: 13 });
  assert.deepEqual(
    { known: observer.status().known, active: observer.status().active, waiting: observer.status().waiting, status: observer.status().status },
    { known: true, active: false, waiting: false, status: 'ready' },
  );
  assert.equal(ipc.refreshes, 0);

  ipc.emit({
    type: 'patches',
    baseRevision: 1,
    revision: 2,
    patches: [
      { op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'active' },
      { op: 'add', path: ['threadRuntimeStatus', 'activeFlags'], value: ['waitingOnApproval'] },
    ],
  }, { version: 13 });
  assert.equal(observer.status().known, true);
  assert.equal(observer.status().active, true);
  assert.equal(observer.status().waiting, true);
  assert.equal(ipc.refreshes, 0);

  ipc.emit({
    type: 'patches',
    baseRevision: 2,
    revision: 3,
    patches: [
      { op: 'replace', path: ['threadRuntimeStatus', 'type'], value: 'idle' },
      { op: 'remove', path: ['threadRuntimeStatus', 'activeFlags'] },
    ],
  }, { version: 13 });
  assert.equal(observer.status().known, true);
  assert.equal(observer.status().active, false);
  assert.equal(observer.status().waiting, false);
  assert.equal(ipc.refreshes, 0);

  ipc.emit({
    type: 'snapshot',
    revision: 4,
    conversationState: {
      threadRuntimeStatus: { type: 'active' },
      requests: [],
      turnHistory: { history: { entitiesByKey: {}, islands: [], isComplete: true } },
    },
  }, { version: 13 });
  assert.equal(observer.status().known, false);
});
