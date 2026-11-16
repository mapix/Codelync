import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_TASK_LIMITS, claudeTaskKind, projectClaudeTasks, readClaudeTaskLogPage } from '../src/adapters/claude-tasks.mjs';
import { projectClaudeNativeMessage } from '../src/adapters/claude-history.mjs';

/** @typedef {Record<string,any>} Value */
const scope = { app: 'claude-desktop', nativeCollection: 'claude-code-sessions', parentConversationId: 'desktop-parent',
  hostId: 'code-host', ownerGeneration: 'parent-owner', runtimeGeneration: 'desktop-runtime', queryToken: 'query-a', cliSessionId: 'cli-parent' };
/** @param {string} subtype @param {Value} [extra] */
const event = (subtype, extra = {}) => ({ type: 'system', subtype, uuid: 'event-' + subtype, session_id: 'cli-parent',
  task_id: 'task-a', task_type: 'local_agent', timestamp: '2026-11-14T12:00:00Z', ...extra });
/** @param {Value} [extra] */
const input = (extra = {}) => ({ scope, observedScope: scope, connected: true, fresh: true, events: [],
  coverage: { available: true, lifecycleComplete: false, levelComplete: false }, ...extra });
/** @param {unknown[]} tasks @param {Value} [extra] */
const level = (tasks, extra = {}) => ({ type: 'system', subtype: 'background_tasks_changed', uuid: 'level-a', session_id: 'cli-parent', tasks, ...extra });
/** @param {Value} [extra] */
function child(extra = {}) {
  return { nativeCollectionVerified: true, parentScope: scope,
    source: { app: scope.app, id: 'child-a', nativeCollection: 'claude-code-sessions', hostId: 'code-host', ownerGeneration: 'child-owner', runtimeGeneration: scope.runtimeGeneration },
    nativeRecord: { sessionId: 'child-a', dispatchParentId: scope.parentConversationId, dispatchParentOrigin: 'local', title: 'Native child', lifecycleState: 'running' }, ...extra };
}

test('named definitions and generic tool completion never become running tasks or session sources', () => {
  const result = projectClaudeTasks(input({ events: [{ name: 'researcher', description: 'definition' },
    { type: 'assistant', tool_use_id: 'fake', task_id: 'fake', status: 'completed' },
    event('task_started', { agent_id: 'agent-a', tool_use_id: 'tool-a', parent_tool_use_id: 'parent-tool' })] }));
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].relationship, 'native-sdk-task');
  assert.equal(result.tasks[0].nativeConversationId, undefined);
  assert.equal(result.tasks[0].agentId, 'agent-a');
  assert.equal(result.tasks[0].toolUseId, 'tool-a');
  assert.equal(result.tasks[0].nativeTaskId, 'task-a');
  assert.deepEqual(result.dispatchChildren, []);
  assert.equal(result.tasksComplete, false);
});

test('agent, shell, workflow, remote agent and unknown native kinds stay separate', () => {
  assert.equal(claudeTaskKind('local_agent'), 'agent');
  assert.equal(claudeTaskKind('local_bash'), 'shell');
  assert.equal(claudeTaskKind('local_workflow'), 'workflow');
  assert.equal(claudeTaskKind('remote_agent'), 'remote-agent');
  assert.equal(claudeTaskKind('mcp_task'), 'other');
  assert.equal(claudeTaskKind('new_kind'), 'other');
  const result = projectClaudeTasks(input({ events: [event('task_started', { ambient: true }), event('task_started', { task_type: 'dream' })] }));
  assert.deepEqual(result.tasks, []);
});

test('native lifecycle readback alone confirms terminal state; progress cannot complete a task', () => {
  const started = projectClaudeTasks(input({ events: [event('task_started'), event('task_progress', { uuid: 'progress', summary: 'not lifecycle' })] }));
  assert.equal(started.tasks[0].status, 'running');
  const statuses = ['completed', 'failed', 'stopped'];
  for (const status of statuses) {
    const result = projectClaudeTasks(input({ events: [event('task_notification', { status })] }), started.state);
    assert.equal(result.tasks[0].status, status);
    assert.equal(result.tasks[0].canStop, undefined);
    assert.equal(result.tasks[0].canContinue, undefined);
  }
  const orphan = projectClaudeTasks(input({ events: [event('task_progress')] }));
  assert.equal(orphan.tasks[0].status, 'unknown');
  assert.equal(projectClaudeTasks(input({ events: [event('task_notification', { status: 'future' })] })).tasks[0].status, 'unknown');
});

test('native patches preserve pending/paused states and refuse unknown state guesses', () => {
  for (const [native, expected] of [['pending', 'pending'], ['running', 'running'], ['paused', 'paused'], ['killed', 'stopped'], ['future', 'unknown']]) {
    const result = projectClaudeTasks(input({ events: [event('task_updated', { patch: { status: native, is_backgrounded: true } })] }));
    assert.equal(result.tasks[0].status, expected);
    assert.equal(result.tasks[0].isBackgrounded, true);
  }
});

test('background levels establish positive activity but do not establish foreground coverage or completion on disappearance', () => {
  const first = projectClaudeTasks(input({ level: level([{ task_id: 'task-a', task_type: 'local_agent' }]),
    coverage: { available: true, levelComplete: true } }));
  assert.equal(first.tasks[0].status, 'running');
  assert.equal(first.backgroundTasksComplete, true);
  assert.equal(first.tasksComplete, false);
  const absent = projectClaudeTasks(input({ level: level([]), coverage: { available: true, levelComplete: true } }), first.state);
  assert.equal(absent.tasks[0].status, 'unknown');
  assert.equal(absent.tasks[0].isBackgrounded, null);
  assert.equal(absent.tasksComplete, false);
  assert.equal(absent.backgroundTasksComplete, true);
});

test('real history projector preserves absent background status while explicit null/unknown remain unknown', () => {
  const raw = level([{ task_id: 'task-a', task_type: 'local_agent' }]);
  const projected = projectClaudeNativeMessage(raw);
  const result = projectClaudeTasks(input({ level: projected, coverage: { available: true, levelComplete: true } }));
  assert.equal(result.tasks[0].status, 'running');
  assert.equal(result.backgroundTasksComplete, true);
  for (const status of [null, 'unknown']) {
    const unavailable = projectClaudeNativeMessage(level([{ task_id: 'task-a', task_type: 'local_agent', status }]));
    const view = projectClaudeTasks(input({ level: unavailable, coverage: { available: true, levelComplete: false } }));
    assert.equal(view.tasks[0].status, 'unknown');
    assert.equal(view.backgroundTasksComplete, false);
  }
});

test('malformed or overflowing levels keep positive known activity and remove completeness', () => {
  const first = projectClaudeTasks(input({ level: level([{ task_id: 'old', task_type: 'local_agent' }]) }));
  const next = projectClaudeTasks(input({ level: level([{ task_id: 'new', task_type: 'local_bash' }, null]), coverage: { available: true, levelComplete: true, lifecycleComplete: true } }), first.state);
  assert.equal(next.tasks.find((/** @type {Value} */ row) => row.id === 'old').status, 'unknown');
  assert.equal(next.tasks.find((/** @type {Value} */ row) => row.id === 'new').kind, 'shell');
  assert.equal(next.tasksComplete, false);
  assert.equal(next.backgroundTasksComplete, false);
  const many = Array.from({ length: 129 }, (_, i) => ({ task_id: `task-${i}`, task_type: 'local_agent' }));
  const overflowing = projectClaudeTasks(input({ level: level(many), coverage: { available: true, levelComplete: true, lifecycleComplete: true } }));
  assert.equal(overflowing.tasks.length, CLAUDE_TASK_LIMITS.tasks);
  assert.equal(overflowing.tasksTruncated, true);
  assert.equal(overflowing.tasksComplete, false);
});

test('unavailable, stale and disconnected observations retain identities with unknown current execution', () => {
  const first = projectClaudeTasks(input({ events: [event('task_started')] }));
  for (const patch of [{ fresh: false }, { connected: false }, { coverage: {} }, { events: 'malformed' }]) {
    const result = projectClaudeTasks(input(patch), first.state);
    assert.equal(result.tasksAvailable, false);
    assert.equal(result.tasks[0].id, 'task-a');
    assert.equal(result.tasks[0].status, 'unknown');
    assert.equal(result.tasksComplete, false);
  }
  assert.equal(projectClaudeTasks({}).tasksAvailable, false);
  assert.equal(projectClaudeTasks(input({ scope: { ...scope, queryToken: null }, observedScope: { ...scope, queryToken: null } })).tasksAvailable, false);
});

test('application, collection, host, parent, CLI and query identity fence current events', () => {
  for (const patch of [{ app: 'codex' }, { nativeCollection: 'local-agent-mode-sessions' }, { hostId: 'foreign' },
    { parentConversationId: 'other-parent' }, { ownerGeneration: 'other-owner' }, { runtimeGeneration: 'other-runtime' },
    { queryToken: 'query-b' }, { cliSessionId: 'other-cli' }]) {
    const result = projectClaudeTasks(input({ observedScope: { ...scope, ...patch }, events: [event('task_started')] }));
    assert.equal(result.tasksAvailable, false);
    assert.deepEqual(result.tasks, []);
  }
  const foreignCli = projectClaudeTasks(input({ events: [event('task_started', { session_id: 'foreign-cli' })], coverage: { available: true, lifecycleComplete: true } }));
  assert.deepEqual(foreignCli.tasks, []);
  assert.equal(foreignCli.tasksComplete, false);
});

test('owner/query changes reset retained task and log state instead of attributing old execution to a new query', () => {
  const first = projectClaudeTasks(input({ events: [event('task_started')] }));
  const nextScope = { ...scope, queryToken: 'query-b' };
  const result = projectClaudeTasks(input({ scope: nextScope, observedScope: nextScope }), first.state);
  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.logs, []);
  assert.notEqual(result.state.scopeKey, first.state.scopeKey);
});

test('original event bridge sequence and duplicate native UUID protect newer lifecycle observations', () => {
  const first = projectClaudeTasks(input({ observationSequence: 1, events: [event('task_started')] }));
  const stopped = projectClaudeTasks(input({ observationSequence: 2, events: [event('task_notification', { status: 'stopped' })] }), first.state);
  const replay = projectClaudeTasks(input({ observationSequence: 1, events: [event('task_started', { uuid: 'old-start' })] }), stopped.state);
  assert.equal(replay.observationRejected, true);
  assert.equal(replay.tasks[0].status, 'unknown');
  assert.equal(replay.state.tasks[0].status, 'stopped');
  assert.equal(replay.logs.length, 2);
  const duplicate = projectClaudeTasks(input({ observationSequence: 3, events: [event('task_notification', { status: 'stopped' })] }), stopped.state);
  assert.equal(duplicate.logs.length, 2);
  const sameBatch = projectClaudeTasks(input({ observationSequence: 2, events: [event('task_started', { uuid: 'same-cursor-invented' })] }), stopped.state);
  assert.equal(sameBatch.tasks[0].status, 'stopped');
  assert.equal(sameBatch.logs.length, 2);
});

test('a reused native event UUID with different lifecycle data is partial and cannot reverse status', () => {
  const first = projectClaudeTasks(input({ events: [event('task_notification', { status: 'stopped' })] }));
  const conflict = projectClaudeTasks(input({ events: [event('task_notification', { status: 'completed' })], coverage: { available: true, lifecycleComplete: true } }), first.state);
  assert.equal(conflict.tasks[0].status, 'unknown');
  assert.equal(conflict.tasksComplete, false);
  assert.equal(conflict.logs.length, 1);
});

test('dispatch children require native collection proof and exact parent/source ownership; ordinary forks are excluded', () => {
  const good = child();
  const result = projectClaudeTasks(input({ dispatchChildren: [good], coverage: { available: true, dispatchAvailable: true, dispatchComplete: true } }));
  assert.equal(result.dispatchChildren.length, 1);
  assert.equal(result.dispatchChildren[0].nativeConversationId, 'child-a');
  assert.equal(result.dispatchChildren[0].ownerGeneration, 'child-owner');
  assert.equal(result.dispatchChildren[0].parentOwnerGeneration, scope.ownerGeneration);
  for (const bad of [child({ nativeCollectionVerified: false }), child({ parentScope: { ...scope, ownerGeneration: 'old-owner' } }),
    child({ nativeRecord: { sessionId: 'child-a', forkedFromSessionId: scope.parentConversationId, lifecycleState: 'running' } }),
    child({ source: { ...good.source, runtimeGeneration: 'other-runtime' } }),
    child({ source: { ...good.source, hostId: 'foreign-same-collection-host' } }),
    child({ nativeRecord: { ...good.nativeRecord, dispatchParentOrigin: 'remote' } })]) {
    const rejected = projectClaudeTasks(input({ dispatchChildren: [bad], coverage: { available: true, dispatchAvailable: true, dispatchComplete: true } }));
    assert.deepEqual(rejected.dispatchChildren, []);
    assert.equal(rejected.dispatchChildrenComplete, false);
  }
});

test('cross-collection LAM dispatch sources retain their own namespace and cannot be inferred from an ordinary parent string', () => {
  const lam = child({ source: { app: scope.app, id: 'lam-child', nativeCollection: 'local-agent-mode-sessions', hostId: 'lam-host', ownerGeneration: 'lam-owner', runtimeGeneration: scope.runtimeGeneration },
    nativeRecord: { sessionId: 'lam-child', sessionType: 'dispatch_child', parentSessionId: scope.parentConversationId, lifecycleState: 'idle' } });
  const result = projectClaudeTasks(input({ dispatchChildren: [lam], coverage: { available: true, dispatchAvailable: true, dispatchComplete: true } }));
  assert.equal(result.dispatchChildren[0].hostId, 'lam-host');
  assert.equal(result.dispatchChildren[0].parentHostId, 'code-host');
  assert.equal(result.dispatchChildren[0].nativeCollection, 'local-agent-mode-sessions');
  assert.equal(result.dispatchChildren[0].status, 'idle');
  const plain = { ...lam, nativeRecord: { ...lam.nativeRecord, sessionType: 'chat' } };
  assert.deepEqual(projectClaudeTasks(input({ dispatchChildren: [plain], coverage: { dispatchAvailable: true } })).dispatchChildren, []);
});

test('partial child reads retain formerly proven membership as unknown and complete empty reads alone remove it', () => {
  const first = projectClaudeTasks(input({ dispatchChildren: [child()], coverage: { available: true, dispatchAvailable: true, dispatchComplete: true } }));
  const partial = projectClaudeTasks(input({ dispatchChildren: [], coverage: { available: true, dispatchAvailable: true, dispatchComplete: false } }), first.state);
  assert.equal(partial.dispatchChildren[0].status, 'unknown');
  const missing = projectClaudeTasks(input(), first.state);
  assert.equal(missing.dispatchChildren[0].status, 'unknown');
  const empty = projectClaudeTasks(input({ dispatchChildren: [], coverage: { available: true, dispatchAvailable: true, dispatchComplete: true } }), first.state);
  assert.deepEqual(empty.dispatchChildren, []);
  assert.equal(empty.dispatchChildrenComplete, true);
  const nextScope = { ...scope, queryToken: 'query-b' };
  const afterQuery = projectClaudeTasks(input({ scope: nextScope, observedScope: nextScope }), first.state);
  assert.equal(afterQuery.dispatchChildren[0].nativeConversationId, 'child-a');
  assert.equal(afterQuery.dispatchChildren[0].status, 'unknown');
  assert.deepEqual(afterQuery.tasks, []);
});

test('projection does not mutate input/state and lifecycle logs exclude task bodies, output paths and operation controls', () => {
  const native = event('task_started', { description: 'Native task label', prompt: 'PRIVATE_PROMPT', summary: 'PRIVATE_SUMMARY',
    output_file: 'PRIVATE_FILE', credentials: 'PRIVATE_KEY', input: { text: 'PRIVATE_TOOL_INPUT' }, canStop: true });
  const before = JSON.stringify(native);
  const first = projectClaudeTasks(input({ events: [native] }));
  const previous = JSON.stringify(first.state);
  const next = projectClaudeTasks(input({ events: [event('task_progress')] }), first.state);
  assert.equal(JSON.stringify(native), before);
  assert.equal(JSON.stringify(first.state), previous);
  assert.equal(JSON.stringify(next).includes('PRIVATE_'), false);
  assert.equal(next.logs[0].description, undefined);
  assert.equal(next.logs[0].identity, 'local-log');
  assert.equal(next.logs[0].nativeEventId, native.uuid);
});

test('log pages are bounded, ordered, task-scoped and fail foreign/evicted cursors explicitly', () => {
  const events = Array.from({ length: 9 }, (_, i) => event('task_progress', { uuid: 'progress-' + i, task_id: i % 2 ? 'task-b' : 'task-a' }));
  const result = projectClaudeTasks(input({ events }));
  const newest = readClaudeTaskLogPage(result.state, { scope, taskId: 'task-a', limit: 2 });
  assert.deepEqual(newest.logs.map((/** @type {Value} */ row) => row.sequence), [7, 9]);
  assert.equal(newest.hasMore, true);
  const older = readClaudeTaskLogPage(result.state, { scope, taskId: 'task-a', limit: 2, before: newest.nextCursor });
  assert.deepEqual(older.logs.map((/** @type {Value} */ row) => row.sequence), [3, 5]);
  assert.equal(readClaudeTaskLogPage(result.state, { scope, taskId: 'task-b', before: newest.nextCursor }).status, 'scope-mismatch');
  assert.equal(readClaudeTaskLogPage(result.state, { scope: { ...scope, hostId: 'foreign' } }).status, 'scope-mismatch');
  assert.equal(readClaudeTaskLogPage(result.state, { scope, before: 'invented' }).status, 'invalid-cursor');
  const added = Array.from({ length: 512 }, (_, i) => event('task_progress', { uuid: 'later-' + i }));
  const next = projectClaudeTasks(input({ events: added }), result.state);
  assert.equal(next.logs.length, CLAUDE_TASK_LIMITS.logs);
  assert.equal(next.logsTruncated, true);
  assert.equal(readClaudeTaskLogPage(next.state, { scope, before: newest.nextCursor, taskId: 'task-a' }).status, 'cursor-not-found');
  assert.equal(readClaudeTaskLogPage(next.state, { scope, limit: 999 }).logs.length, CLAUDE_TASK_LIMITS.page);
});
