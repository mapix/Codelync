import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeDesktopBackend } from '../src/adapters/claude-backend.mjs';
import { claudeDesktopHostId } from '../src/adapters/claude-desktop-rpc.mjs';
import { BridgeError } from '../src/errors.mjs';

/** @typedef {Record<string,any>} Value */
/** Strongly scoped native task feed fixture, with no model or app execution. */
function taskFixture() {
  const runtime = { generation: 'main-task', storagePath: '/fixture/task-profile', profileNamespace: 'fixture' };
  /** @type {Value} */ const state = { query: 'query-task', owner: 'owner-task', cursor: 1, calls: [], foreground: [{ task_id: 'task-one', task_type: 'local_agent' }], levelTasks: [],
    events: [{ sequence: 0, message: { type: 'system', subtype: 'task_started', task_id: 'task-one', task_type: 'local_agent', uuid: 'native-task-start', session_id: 'cli-task' } }],
    unsupported: false, capabilities: {}, bodyPatch: {}, snapshots: 0 };
  const hostId = claudeDesktopHostId(runtime, 'claude-code-sessions');
  const scope = () => ({ app: 'claude-desktop', nativeCollection: 'claude-code-sessions', hostId, parentConversationId: 'parent-task',
    ownerGeneration: state.owner, runtimeGeneration: runtime.generation, queryToken: state.query, cliSessionId: 'cli-task' });
  const rpc = /** @type {any} */ ({ latestRuntime: runtime, generation: () => runtime.generation, dispose: async () => {},
    call: async (/** @type {string} */ method, /** @type {Value} */ params) => {
      state.calls.push({ method, params });
      if (method === 'code.taskFeed') {
        if (state.unsupported) throw new BridgeError('unsupported-native-action', 'Native task feed unavailable.');
        if (params.cursor > state.cursor) throw new BridgeError('invalid-task-cursor', 'The native event cursor is unavailable.');
        return { version: 1, scope: scope(), sessionId: 'parent-task', ownerGeneration: state.owner, executionToken: state.query,
          runtimeGeneration: runtime.generation, cliSessionId: 'cli-task', queryPresent: state.query !== null,
          cursor: state.cursor, events: state.events, coverage: { available: true, levelComplete: true, foregroundComplete: true, dispatchAvailable: true, dispatchComplete: true },
          foregroundLevel: { available: true, complete: true, tasks: state.foreground },
          level: { type: 'system', subtype: 'background_tasks_changed', session_id: 'cli-task', uuid: 'level-task', tasks: state.levelTasks },
          dispatchChildren: state.children ?? [], capabilities: state.capabilities, ...state.bodyPatch };
      }
      if (method === 'code.snapshot') { state.snapshots++; return { sessionId: 'parent-task', ownerGeneration: state.owner, executionToken: state.query ?? 'idle-execution',
        header: { sessionId: 'parent-task', sessionType: 'code', isRunning: false, turnRunning: false, queryPresent: state.query !== null }, messages: [{ type: 'assistant', uuid: 'parent-answer', message: { content: 'parent text' } }], hasMore: false }; }
      if (method === 'code.events') return { ownerGeneration: state.owner, executionToken: state.query, cursor: state.messageCursor ?? 0, events: state.messageEvents ?? [] };
      if (method === 'code.stopTask') { const before = scope(); if (state.stopReadback) { state.foreground = []; state.events = [{ sequence: state.cursor, message: { type: 'system', subtype: 'task_notification', task_id: 'task-one', task_type: 'local_bash', uuid: 'native-stop', status: 'stopped', session_id: 'cli-task' } }]; state.cursor++; }
        return { scope: before, sessionId: 'parent-task', taskId: params.taskId, stopRequested: true,
          terminalProof: state.stopReadback ? { kind: 'native-task-notification', nativeEventId: 'native-stop', sequence: state.cursor - 1, status: 'stopped' } : null }; }
      if (method === 'code.taskOutput') return { scope: scope(), sessionId: 'parent-task', taskId: 'task-one', output: state.output ?? 'native output', truncated: true };
      return {};
    } });
  return { rpc, state, scope, runtime };
}

/** @param {Record<string,any>[]} calls */
function fixture(calls) {
  return /** @type {any} */ ({ generation: () => 'main-one', hostId: () => 'profile-one', dispose: async () => {},
    call: async (/** @type {string} */ method, /** @type {Record<string,any>} */ params, /** @type {Record<string,any>} */ options) => { calls.push({ method, params, options });
      if (method === 'code.list') return { sessions: [{ sessionId: 'local_probe', isRunning: null }] };
      if (method === 'code.snapshot') return { sessionId: 'local_probe', sessionGeneration: 'query-one', header: { sessionId: 'local_probe', sessionType: 'code', isRunning: false, turnRunning: false }, hasMore: true,
        messages: [{ type: 'user', uuid: 'native-person', message: { content: 'hi' } }] };
      if (method === 'code.page') return { sessionId: 'local_probe', sessionGeneration: 'query-one', header: { isRunning: true }, hasMore: false, found: true, source: 'full', messages: [] };
      return {};
    } });
}

test('directory uses only owner headers and preserves unknown native state', async () => {
  /** @type {Record<string,any>[]} */ const calls = [];
  const backend = new ClaudeDesktopBackend({ rpc: fixture(calls) });
  const rows = await backend.list(); assert.equal(rows[0].nativeStatus, 'unknown'); assert.deepEqual(calls.map(call => call.method), ['code.list']);
});

test('Code directory activity includes verified background work without changing selected turn/input status', async () => {
  const { rpc, state } = taskFixture(), original = rpc.call;
  const base = { ownerGeneration: 'owner-task', isRunning: false, turnRunning: false, hasBackgroundActivity: false, hasBackgroundWork: false,
    headerIdentityVerified: true, headerCollectionComplete: true, headerReadStartedAt: 10000, pendingPermissionCount: 0 };
  rpc.call = async (/** @type {string} */ method, /** @type {Value} */ params) => method === 'code.list' ? { sessions: [
    { ...base, sessionId: 'background', hasBackgroundActivity: true }, { ...base, sessionId: 'idle' },
    { ...base, sessionId: 'missing', hasBackgroundActivity: null }, { ...base, sessionId: 'partial', headerCollectionComplete: false },
    { ...base, sessionId: 'changed', hasBackgroundActivity: true, headerIdentityVerified: false }] } : original(method, params);
  const backend = new ClaudeDesktopBackend({ rpc }), rows = await backend.list();
  assert.deepEqual(rows.map((/** @type {Value} */ row) => row.nativeStatus), ['running', 'idle', 'unknown', 'unknown', 'unknown']);
  assert.equal(rows[0].turnRunning, false); assert.equal(rows[0].nativeActivityObservedAt, 10000);
  const nativeSnapshot = rpc.call; rpc.call = async (/** @type {string} */ method, /** @type {Value} */ params) => {
    const value = await nativeSnapshot(method, params); if (method === 'code.snapshot') value.header.hasBackgroundActivity = true; return value;
  };
  const view = await backend.snapshot('parent-task'); assert.equal(view.status, 'idle'); assert.equal(view.currentTurnId, null); assert.equal(view.nativeInput.canSend, true); assert.equal(view.nativeCancel.available, false);
  assert.equal(state.calls.some((/** @type {Value} */ call) => call.method === 'code.taskOutput'), false);
});

test('Chat controls cannot survive a native record conversion to an unverified Cowork mode', async () => {
  let mutated = false;
  const rpc = /** @type {any} */ ({ generation: () => 'main', latestRuntime: { storagePath: '/fixture' }, call: async (/** @type {string} */ method) => {
    if (method === 'cowork.snapshot') return { sessionId: 'native_chat', ownerGeneration: 'owner', executionToken: 'query', header: { sessionId: 'native_chat', sessionType: 'cowork', isRunning: false }, messages: [], hasMore: null };
    mutated = true; return {};
  } });
  const backend = new ClaudeDesktopBackend({ rpc, appMode: 'chat' });
  const view = await backend.snapshot('native_chat'); assert.equal(view.nativeInput.canSend, false); assert.equal(view.nativeQuery.canSend, false);
  await assert.rejects(backend.command('native_chat', 'send', { text: 'hello' }, 'operation-one'), { code: 'unsupported-native-mode' });
  assert.equal(mutated, false);
});

test('explicit old cursor remains owner-bound and data-only; absent cursor cannot trigger full owner reads', async () => {
  /** @type {Record<string,any>[]} */ const calls = [];
  const backend = new ClaudeDesktopBackend({ rpc: fixture(calls) });
  await assert.rejects(backend.completeSnapshot('local_probe'), { code: 'stale-history-cursor' }); assert.equal(calls.length, 0);
  const view = await backend.snapshot('local_probe');
  await assert.rejects(backend.completeSnapshot('local_probe', { historyBoundary: { id: view.rows[0].id, ownerGeneration: 'old-query' } }), { code: 'stale-history-cursor' });
  const old = await backend.completeSnapshot('local_probe', { historyBoundary: { id: view.rows[0].id, ownerGeneration: 'query-one' } });
  assert.equal(old.historyDataOnly, true); assert.equal(old.status, 'unknown'); assert.equal(old.currentTurnId, null); assert.deepEqual(old.requests, []);
  assert.equal(calls.at(-1)?.params.expectedOwnerGeneration, 'query-one');
});

test('old pages contain no live controller fields and query cancel stays separate from native Turn ID', async () => {
  /** @type {Record<string,any>[]} */ const calls = [];
  const backend = new ClaudeDesktopBackend({ rpc: fixture(calls) });
  const view = await backend.snapshot('local_probe');
  assert.equal(view.currentTurnId, null); assert.equal(view.nativeCancel.scope, 'session-query');
  assert.equal(view.nativeInput.canSend, true); assert.equal(view.nativeInput.canSteer, false);
  const page = await backend.historyPage('local_probe', { historyBoundary: { id: view.rows[0].id, ownerGeneration: view.ownerGeneration } });
  for (const field of ['status', 'currentTurnId', 'requests', 'nativeInput', 'nativeCancel', 'nativeModel']) assert.equal(field in page, false, field);
});

test('stale query and idle interruption are rejected before native mutation', async () => {
  /** @type {Record<string,any>[]} */ const calls = [];
  const backend = new ClaudeDesktopBackend({ rpc: fixture(calls) });
  await assert.rejects(backend.command('local_probe', 'send', { text: 'hi' }, 'operation-one', { expectedGeneration: 'old-query' }), { code: 'source-epoch-changed' });
  await assert.rejects(backend.command('local_probe', 'interrupt', {}, 'operation-two'), { code: 'stale-turn' });
  assert.equal(calls.some(call => call.method === 'code.send' || call.method === 'code.interrupt'), false);
});

test('taskSnapshot reads only bounded native metadata and public nativeTasks never retain logs or task output', async () => {
  const { rpc, state, scope } = taskFixture(), backend = new ClaudeDesktopBackend({ rpc });
  const tasks = await backend.taskSnapshot('parent-task', { scope: scope(), expectedGeneration: 'owner-task', expectedQueryToken: 'query-task' });
  assert.equal(tasks.tasks[0].nativeTaskId, 'task-one');
  assert.equal(tasks.tasks[0].nativeConversationId, undefined);
  assert.equal(tasks.tasks[0].status, 'running');
  assert.equal(tasks.scope.runtimeGeneration, 'main-task');
  assert.equal(tasks.logs, undefined); assert.equal(tasks.state, undefined);
  assert.deepEqual(state.calls.map((/** @type {Value} */ call) => call.method), ['code.taskFeed']);
  assert.equal(state.calls[0].params.limit, 128);
});

test('equal event cursor still refreshes current foreground/background maps and dispatch headers', async () => {
  const { rpc, state, scope } = taskFixture(), backend = new ClaudeDesktopBackend({ rpc });
  state.events = [];
  state.foreground = [{ task_id: 'foreground', task_type: 'local_bash' }];
  state.levelTasks = [{ task_id: 'background', task_type: 'local_agent' }];
  const first = await backend.taskSnapshot('parent-task');
  assert.equal(first.tasksComplete, true);
  state.foreground = [{ task_id: 'foreground', task_type: 'local_bash', status: 'paused' }];
  state.levelTasks = [{ task_id: 'background', task_type: 'local_agent', status: 'failed' }];
  state.children = [{ nativeCollectionVerified: true, parentScope: scope(),
    source: { app: 'claude-desktop', id: 'native-child', nativeCollection: 'claude-code-sessions', hostId: scope().hostId, ownerGeneration: 'child-owner', runtimeGeneration: 'main-task' },
    nativeRecord: { sessionId: 'native-child', dispatchParentId: 'parent-task', lifecycleState: 'idle' } }];
  const second = await backend.taskSnapshot('parent-task');
  assert.equal(second.tasks.find((/** @type {Value} */ row) => row.id === 'foreground').status, 'paused');
  assert.equal(second.tasks.find((/** @type {Value} */ row) => row.id === 'background').status, 'failed');
  assert.equal(second.dispatchChildren[0].status, 'idle');
  assert.equal(second.tasksComplete, true);
  state.bodyPatch = { foregroundLevel: { available: false, complete: false, tasks: [] }, level: null };
  const lostLevels = await backend.taskSnapshot('parent-task');
  assert.equal(lostLevels.tasksComplete, false);
  assert.equal(lostLevels.tasks.find((/** @type {Value} */ row) => row.id === 'foreground').status, 'unknown');
});

test('task scope fences same-owner query changes, CLI/collection mismatch and late metadata reads', async () => {
  const { rpc, state, scope } = taskFixture(); let now = 100;
  const backend = new ClaudeDesktopBackend({ rpc, now: () => now, taskFreshMs: 10 });
  const old = scope(); await backend.taskSnapshot('parent-task'); state.query = 'query-new';
  await assert.rejects(backend.taskSnapshot('parent-task', { scope: old, expectedGeneration: old.ownerGeneration, expectedQueryToken: old.queryToken }), { code: 'stale-turn' });
  state.bodyPatch = { scope: { ...scope(), cliSessionId: 'foreign-cli' } };
  await assert.rejects(backend.taskSnapshot('parent-task'), { code: 'claude-invalid-task-feed' });
  state.bodyPatch = { scope: { ...scope(), nativeCollection: 'local-agent-mode-sessions' } };
  await assert.rejects(backend.taskSnapshot('parent-task'), { code: 'claude-invalid-task-feed' });
  state.bodyPatch = {};
  const call = rpc.call; rpc.call = async (/** @type {any[]} */ ...args) => { const result = await call(...args); now += 11; return result; };
  await assert.rejects(backend.taskSnapshot('parent-task'), { code: 'stale-task-feed' });
});

test('unsupported task feed uses a short negative cache, retains parent input and recovers under the same desktop generation', async () => {
  const { rpc, state } = taskFixture(); let now = 0;
  const backend = new ClaudeDesktopBackend({ rpc, now: () => now, taskFeedNegativeTtlMs: 20 });
  state.unsupported = true;
  const first = await backend.snapshot('parent-task');
  const second = await backend.snapshot('parent-task');
  assert.equal(first.nativeInput.canSend, true); assert.equal(second.rows[0].text, 'parent text');
  assert.equal(second.nativeTasks.tasksAvailable, false);
  assert.equal(state.calls.filter((/** @type {Value} */ row) => row.method === 'code.taskFeed').length, 1);
  state.unsupported = false; now = 21;
  const recovered = await backend.snapshot('parent-task');
  assert.equal(recovered.nativeTasks.tasksAvailable, true);
  assert.equal(recovered.nativeDesktopRuntimeGeneration, 'main-task');
  assert.equal(state.calls.filter((/** @type {Value} */ row) => row.method === 'code.taskFeed').length, 2);
});

test('task-only changes notify the subscribed native view without re-reading the parent transcript', async () => {
  const { rpc, state } = taskFixture(), backend = new ClaudeDesktopBackend({ rpc, pollMs: 5 });
  state.events = []; state.foreground = [{ task_id: 'foreground', task_type: 'local_agent' }];
  /** @type {Value[]} */ const views = [];
  /** @type {()=>void} */ let updated;
  const changed = new Promise(resolve => { updated = () => resolve(undefined); });
  const unsubscribe = await backend.subscribe('parent-task', view => { views.push(view); if (views.length > 1) updated(); });
  try {
    state.foreground = [{ task_id: 'foreground', task_type: 'local_agent', status: 'paused' }];
    await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(Error('No task-only notification')), 100))]);
    assert.equal(views.at(-1)?.nativeTasks.tasks[0].status, 'paused');
    assert.equal(state.snapshots, 1);
    assert.equal(views.at(-1)?.nativeTasks.logs, undefined);
  } finally { unsubscribe(); await backend.dispose(); }
});

test('progress-only event IDs and timestamps update private logs without source notification or transcript reads', async () => {
  const { rpc, state } = taskFixture(), backend = new ClaudeDesktopBackend({ rpc, pollMs: 5 });
  state.foreground = []; state.bodyPatch = { foregroundLevel: { available: false, complete: false, tasks: [] } };
  /** @type {Value[]} */ const views = [];
  /** @type {()=>void} */ let stopped = () => {};
  const updated = new Promise(resolve => { stopped = () => resolve(undefined); });
  const unsubscribe = await backend.subscribe('parent-task', view => { views.push(view); if (view.nativeTasks.tasks[0]?.status === 'stopped') stopped(); });
  try {
    const progress = { type: 'system', subtype: 'task_progress', uuid: 'log-only-progress', task_id: 'task-one', task_type: 'local_agent', session_id: 'cli-task', timestamp: '2026-11-15T00:00:01Z' };
    state.events = [{ sequence: 1, message: progress }]; state.cursor = 2; state.messageCursor = 1;
    state.messageEvents = [{ type: 'message', message: progress }];
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(views.length, 1); assert.equal(state.snapshots, 1);
    assert.equal(backend.taskStates.get('parent-task')?.state.logs.length, 2);
    const notification = { ...progress, subtype: 'task_notification', uuid: 'status-stop', timestamp: '2026-11-15T00:00:02Z', status: 'stopped' };
    state.events = [{ sequence: 2, message: notification }]; state.cursor = 3; state.messageCursor = 2;
    state.messageEvents = [{ type: 'message', message: notification }];
    await Promise.race([updated, new Promise((_, reject) => setTimeout(() => reject(Error('Semantic task stop was not published')), 100))]);
    assert.equal(views.length, 2); assert.equal(state.snapshots, 1);
  } finally { unsubscribe(); await backend.dispose(); }
});

test('task log pages use exact current query scope, default to twelve metadata rows and never load history', async () => {
  const { rpc, state, scope } = taskFixture(), backend = new ClaudeDesktopBackend({ rpc });
  state.events = Array.from({ length: 20 }, (_, i) => ({ sequence: i, message: { type: 'system', subtype: 'task_progress', uuid: `progress-${i}`, task_id: 'task-one', task_type: 'local_agent', session_id: 'cli-task', summary: 'PRIVATE_BODY' } }));
  state.cursor = 20;
  await backend.taskSnapshot('parent-task');
  const page = await backend.taskLogPage('parent-task', { scope: scope(), taskId: 'task-one' });
  assert.equal(page.logs.length, 12); assert.deepEqual(page.scope, scope()); assert.equal(page.hasMore, true);
  assert.equal(JSON.stringify(page).includes('PRIVATE_BODY'), false);
  assert.equal(state.calls.some((/** @type {Value} */ row) => /snapshot|page|Transcript/.test(row.method)), false);
  const old = scope(); state.query = 'query-new';
  await assert.rejects(backend.taskLogPage('parent-task', { scope: old, taskId: 'task-one', before: page.nextCursor }), { code: 'stale-turn' });
});

test('task output and stop remain unavailable without owner verification; a stop receipt alone is delivery-unknown', async () => {
  const { rpc, state, scope } = taskFixture(), backend = new ClaudeDesktopBackend({ rpc });
  await backend.taskSnapshot('parent-task');
  await assert.rejects(backend.getTaskOutput('parent-task', 'task-one', { scope: scope() }), { code: 'unsupported-action' });
  await assert.rejects(backend.stopTask('parent-task', 'task-one', 'stable-task-op', { scope: scope() }), { code: 'unsupported-action' });
  assert.equal(state.calls.some((/** @type {Value} */ row) => /taskOutput|stopTask/.test(row.method)), false);
  state.foreground[0].task_type = 'local_bash'; state.events[0].message.task_type = 'local_bash';
  state.capabilities = { taskStopVerified: true, stopTaskTypes: ['local_bash'] };
  await assert.rejects(backend.stopTask('parent-task', 'task-one', 'stable-task-op', { scope: scope() }), { code: 'delivery-unknown' });
  state.stopReadback = true;
  const confirmed = await backend.stopTask('parent-task', 'task-one', 'another-task-op', { scope: scope() });
  assert.equal(confirmed.stopped, true); assert.equal(confirmed.readbackConfirmed, true);
  assert.equal(backend.supportedActions.includes('stopTask'), false);
});

test('verified task output remains bounded and separate from resident nativeTasks/log metadata', async () => {
  const { rpc, state, scope } = taskFixture(), backend = new ClaudeDesktopBackend({ rpc });
  state.foreground[0].task_type = 'local_bash'; state.events[0].message.task_type = 'local_bash';
  state.capabilities = { taskOutputVerified: true, outputTaskTypes: ['local_bash'] };
  const output = await backend.getTaskOutput('parent-task', 'task-one', { scope: scope() });
  assert.equal(output.output, 'native output'); assert.equal(output.truncated, true);
  assert.equal(JSON.stringify(await backend.taskSnapshot('parent-task')).includes('native output'), false);
  state.output = 'x'.repeat(65537);
  await assert.rejects(backend.getTaskOutput('parent-task', 'task-one', { scope: scope() }), { code: 'claude-invalid-task-output' });
});

test('selected native task controls require verified type arrays and readonly always removes stop types', async () => {
  const { rpc, state, scope } = taskFixture(), backend = new ClaudeDesktopBackend({ rpc });
  state.capabilities = { taskOutputVerified: true, taskStopVerified: true };
  let view = await backend.snapshot('parent-task'); assert.deepEqual(view.nativeTaskControls.outputTaskTypes, []); assert.deepEqual(view.nativeTaskControls.stopTaskTypes, []);
  state.capabilities = { taskOutputVerified: true, taskStopVerified: true, outputTaskTypes: ['local_bash'], stopTaskTypes: ['local_bash'] };
  view = await backend.snapshot('parent-task'); assert.deepEqual(view.nativeTaskControls.scope, scope());
  assert.deepEqual(view.nativeTaskControls.outputTaskTypes, ['local_bash']); assert.deepEqual(view.nativeTaskControls.stopTaskTypes, ['local_bash']);
  rpc.latestRuntime.readOnly = true; rpc.latestRuntime.mutationAllowed = false;
  view = await backend.snapshot('parent-task'); assert.deepEqual(view.nativeTaskControls.outputTaskTypes, ['local_bash']); assert.deepEqual(view.nativeTaskControls.stopTaskTypes, []);
});

test('task stop known pre-invocation rejections are effect-free and native RPC failures retain uncertainty', async () => {
  const { rpc, state, scope } = taskFixture(), backend = new ClaudeDesktopBackend({ rpc });
  const safelyRejected = (/** @type {any} */ error) => error.effectMayHaveOccurred === false;
  await assert.rejects(backend.stopTask('parent-task', 'task-one', 'valid-task-op', { scope: {} }), safelyRejected);
  await assert.rejects(backend.stopTask('parent-task', 'task-one', 'valid-task-op', { scope: scope() }), safelyRejected);
  state.foreground[0].task_type = 'local_bash'; state.events[0].message.task_type = 'local_bash';
  state.capabilities = { taskStopVerified: true, stopTaskTypes: ['local_bash'] };
  await assert.rejects(backend.stopTask('parent-task', 'task-one', 'bad', { scope: scope() }), safelyRejected);
  const original = rpc.call; rpc.call = async (/** @type {string} */ method, /** @type {Value} */ params) => {
    if (method === 'code.stopTask') throw new BridgeError('source-epoch-changed', 'Native operation boundary changed.');
    return original(method, params);
  };
  await assert.rejects(backend.stopTask('parent-task', 'task-one', 'valid-task-op', { scope: scope() }), (/** @type {any} */ error) => error.code === 'source-epoch-changed' && error.effectMayHaveOccurred !== false);
  rpc.call = original;
  await assert.rejects(backend.stopTask('parent-task', 'task-one', 'valid-task-op', { scope: scope() }), (/** @type {any} */ error) => error.code === 'delivery-unknown' && error.effectMayHaveOccurred === true);
});

test('different-context same-cursor parent task reads are serialized so a late older level cannot overwrite new status', async () => {
  const { rpc, state, scope } = taskFixture(), backend = new ClaudeDesktopBackend({ rpc });
  state.events = [];
  let calls = 0;
  /** @type {()=>void} */ let release = () => {};
  /** @type {()=>void} */ let started = () => {};
  const gate = new Promise(resolve => { release = () => resolve(undefined); });
  const firstStarted = new Promise(resolve => { started = () => resolve(undefined); });
  const native = rpc.call;
  rpc.call = async (/** @type {string} */ method, /** @type {Value} */ params) => {
    const result = structuredClone(await native(method, params));
    if (method === 'code.taskFeed' && ++calls === 1) { started(); await gate; }
    return result;
  };
  const first = backend.taskSnapshot('parent-task'); await firstStarted;
  state.foreground = [{ task_id: 'task-one', task_type: 'local_agent', status: 'paused' }];
  const second = backend.taskSnapshot('parent-task', { scope: scope() });
  await Promise.resolve(); assert.equal(calls, 1);
  release();
  assert.equal((await first).tasks[0].status, 'running');
  assert.equal((await second).tasks[0].status, 'paused');
  assert.equal(backend.taskStates.get('parent-task')?.state.tasks[0].status, 'paused');
  assert.equal(calls, 2);
});

test('same-context task metadata reads coalesce and distinct pending reads have a strict bound', async () => {
  const { rpc, scope } = taskFixture(), backend = new ClaudeDesktopBackend({ rpc });
  let calls = 0;
  /** @type {()=>void} */ let release = () => {};
  /** @type {()=>void} */ let started = () => {};
  const gate = new Promise(resolve => { release = () => resolve(undefined); });
  const firstStarted = new Promise(resolve => { started = () => resolve(undefined); });
  const native = rpc.call;
  rpc.call = async (/** @type {string} */ method, /** @type {Value} */ params) => {
    if (method === 'code.taskFeed' && ++calls === 1) { started(); await gate; }
    return native(method, params);
  };
  const first = backend.taskSnapshot('parent-task', { scope: scope() }); await firstStarted;
  const shared = Array.from({ length: 40 }, () => backend.taskSnapshot('parent-task', { scope: scope() }));
  const queued = backend.taskSnapshot('parent-task', {});
  await assert.rejects(backend.taskSnapshot('parent-task', { expectedGeneration: scope().ownerGeneration }), { code: 'native-task-read-busy' });
  assert.equal(calls, 1); assert.equal(backend.taskPending.get('parent-task'), 2);
  release(); await Promise.all([first, queued, ...shared]);
  assert.equal(calls, 2); assert.equal(backend.taskPending.size, 0); assert.equal(backend.taskReads.size, 0);
});

test('an owner restart with the same native session resets the old task cursor before the first new feed read', async () => {
  const { rpc, state, runtime, scope } = taskFixture(), backend = new ClaudeDesktopBackend({ rpc });
  await backend.taskSnapshot('parent-task');
  runtime.generation = 'main-new'; state.owner = 'owner-new'; state.cursor = 0; state.events = [];
  const next = await backend.taskSnapshot('parent-task', { expectedGeneration: 'owner-new', expectedQueryToken: scope().queryToken });
  assert.equal(next.scope.runtimeGeneration, 'main-new');
  assert.equal(state.calls.at(-1).params.cursor, 0);
  assert.deepEqual(next.logs, undefined);
});
