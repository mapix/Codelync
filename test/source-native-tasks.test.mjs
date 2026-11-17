import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceNativeTasks, sourceNativeTaskControls, nativeTaskActivity } from '../src/adapters/source-native-tasks.mjs';
import { aggregateNativeActivity } from '../src/adapters/native-aggregate-activity.mjs';
import { recentDescriptor } from '../src/codelync/recent-data.mjs';

/** @typedef {Record<string,any>} Value */
const source = { app: 'claude-desktop', id: 'parent', nativeCollection: 'claude-code-sessions', hostId: 'host-code' };
const scope = { app: source.app, parentConversationId: source.id, nativeCollection: source.nativeCollection, hostId: source.hostId,
  ownerGeneration: 'session-owner', runtimeGeneration: 'desktop-owner', queryToken: 'query', cliSessionId: 'cli-parent' };
const context = { runtimeGeneration: scope.runtimeGeneration, queryToken: scope.queryToken, current: true };
/** @param {Value} [change] */
const task = (change = {}) => ({ ...scope, id: 'task-1', nativeTaskId: 'task-1', relationship: 'native-sdk-task', name: 'Review', taskType: 'local_agent',
  kind: 'agent', status: 'running', isBackgrounded: false, statusSource: 'native-task-lifecycle', ...change });
/** @param {Value} [change] */
const child = (change = {}) => ({ app: source.app, nativeConversationId: 'child', name: 'Dispatch', relationship: 'native-subagent',
  nativeCollection: 'local-agent-mode-sessions', hostId: 'host-lam', ownerGeneration: 'child-owner', runtimeGeneration: scope.runtimeGeneration,
  parentConversationId: scope.parentConversationId, parentHostId: scope.hostId, parentOwnerGeneration: scope.ownerGeneration,
  parentNativeCollection: scope.nativeCollection, status: 'pending', ...change });
/** @param {Value} [change] */
const envelope = (change = {}) => ({ version: 1, scope, tasks: [task()], tasksAvailable: true, tasksComplete: true, backgroundTasksComplete: true,
  tasksTruncated: false, dispatchChildren: [child()], dispatchChildrenAvailable: true, dispatchChildrenComplete: true, dispatchChildrenTruncated: false, ...change });
/** @param {Value} input */
const project = input => sourceNativeTasks(input, source, scope.ownerGeneration, context);
/** @param {Value} input */
const compact = input => { const value = project(input); assert.ok(value); return value; };

test('verified task-type controls require the selected scope and bounded unique native types', () => {
  const tasks = compact(envelope()), controls = { version: 1, scope, outputTaskTypes: ['local_bash'], stopTaskTypes: [] };
  assert.deepEqual(sourceNativeTaskControls(controls, tasks), { version: 1, outputTaskTypes: ['local_bash'], stopTaskTypes: [] });
  assert.equal(sourceNativeTaskControls({ ...controls, scope: { ...scope, queryToken: 'other' } }, tasks), null);
  assert.equal(sourceNativeTaskControls(controls, { ...tasks, tasksAvailable: false }), null);
  assert.equal(sourceNativeTaskControls({ ...controls, outputTaskTypes: ['local_bash', 'local_bash'] }, tasks), null);
  assert.equal(sourceNativeTaskControls({ ...controls, stopTaskTypes: Array(9).fill('local_bash') }, tasks), null);
});

test('wire sends one parent scope, keeps child-owned collection identity and omits private task buffers', () => {
  const value = compact(envelope({ logs: ['private'], state: { private: true }, tasks: [task({ output: 'private', toolInput: 'private' })] }));
  assert.ok(value); assert.deepEqual(value.scope, scope); assert.equal(value.tasks.length, 1);
  assert.equal('id' in value.tasks[0], false); assert.equal('hostId' in value.tasks[0], false); assert.equal('output' in value.tasks[0], false);
  assert.equal('logs' in value, false); assert.equal('state' in value, false);
  assert.equal(value.dispatchChildren[0].hostId, 'host-lam'); assert.equal(value.dispatchChildren[0].ownerGeneration, 'child-owner');
  assert.equal('parentOwnerGeneration' in value.dispatchChildren[0], false);
  assert.equal(compact(envelope()).digest, value.digest);
});

test('every selected source/runtime/query boundary rejects a foreign envelope', () => {
  for (const key of ['app', 'nativeCollection', 'parentConversationId', 'hostId', 'ownerGeneration', 'runtimeGeneration', 'queryToken']) {
    assert.equal(project(envelope({ scope: { ...scope, [key]: 'foreign' } })), null, key);
  }
  assert.equal(sourceNativeTasks(envelope(), { ...source, app: 'codex' }, scope.ownerGeneration, context), null);
  assert.equal(sourceNativeTasks(envelope(), source, null, context), null);
  assert.equal(project(envelope({ scope: { ...scope, cliSessionId: undefined } })), null);
});

test('invalid, duplicate, unknown and overflowing rows cannot prove complete or cross-source activity', () => {
  const malformed = compact(envelope({ tasks: [task(), task({ nativeTaskId: 'foreign', hostId: 'other' })],
    dispatchChildren: [child(), child({ nativeConversationId: 'foreign', parentOwnerGeneration: 'foreign' })] }));
  assert.equal(malformed.tasks.length, 1); assert.equal(malformed.tasksComplete, false); assert.equal(malformed.dispatchChildrenComplete, false);
  const duplicate = compact(envelope({ tasks: [task(), task()], dispatchChildren: [child(), child()] }));
  assert.equal(duplicate.tasksComplete, false); assert.equal(duplicate.dispatchChildren.length, 1);
  const overflow = compact(envelope({ tasks: Array.from({ length: 129 }, (_, i) => task({ nativeTaskId: `task-${i}` })) }));
  assert.equal(overflow.tasks.length, 128); assert.equal(overflow.tasksTruncated, true); assert.equal(overflow.tasksComplete, false);
  assert.equal(compact(envelope({ tasks: [task({ status: 'future' })] })).tasks[0].status, 'unknown');
  assert.equal(compact(envelope({ tasks: [task({ status: 'future' })] })).tasksComplete, false);
});

test('lease loss and partial foreground coverage preserve unknown membership without inventing idle', () => {
  const stale = sourceNativeTasks(envelope(), source, scope.ownerGeneration, { ...context, current: false });
  assert.ok(stale);
  assert.equal(stale.tasks[0].status, 'unknown'); assert.equal(stale.dispatchChildren[0].status, 'unknown'); assert.equal(stale.tasksAvailable, false);
  const base = { app: source.app, parentConversationId: source.id, hostId: source.hostId, ownerGeneration: scope.ownerGeneration,
    ownStatus: 'idle', rosterAvailable: false, rosterComplete: false };
  const partial = compact(envelope({ tasks: [task({ status: 'completed' })], tasksComplete: false, dispatchChildren: [] }));
  assert.equal(partial.backgroundTasksComplete, true);
  assert.equal(aggregateNativeActivity({ ...base, taskActivity: nativeTaskActivity(partial) }).status, 'unknown');
  const busy = aggregateNativeActivity({ ...base, taskActivity: nativeTaskActivity(compact(envelope({ tasksComplete: false }))) });
  assert.equal(busy.status, 'running'); assert.equal(busy.taskCount, 1); assert.equal(busy.childCount, 1); assert.equal(busy.ownStatus, 'idle');
  assert.equal('currentTurnId' in busy, false);
  const paused = compact(envelope({ tasks: [task({ status: 'paused' })], dispatchChildren: [] }));
  assert.equal(aggregateNativeActivity({ ...base, taskActivity: nativeTaskActivity(paused) }).status, 'running');
  assert.equal(aggregateNativeActivity({ ...base, taskActivity: nativeTaskActivity(paused) }).waiting, false);
  const terminal = compact(envelope({ tasks: [task({ status: 'completed' })], dispatchChildren: [] }));
  assert.equal(aggregateNativeActivity({ ...base, taskActivity: nativeTaskActivity(terminal) }).status, 'idle');
});

test('128-task wire budget avoids repeated source scope while stable updates keep their digest', () => {
  const full = envelope({ tasks: Array.from({ length: 128 }, (_, i) => task({ id: `task-${i}`, nativeTaskId: `task-${i}` })), dispatchChildren: [] });
  const value = compact(full);
  const fullBytes = Buffer.byteLength(JSON.stringify(full)), compactBytes = Buffer.byteLength(JSON.stringify(value));
  assert.ok(compactBytes < fullBytes * 0.55, `${compactBytes}/${fullBytes}`);
  assert.equal(compact(structuredClone(full)).digest, value.digest);
  const changed = structuredClone(full); changed.tasks[0].status = 'completed';
  assert.notEqual(compact(changed).digest, value.digest);
});

test('progress-only native timestamps do not replace the ongoing task snapshot', () => {
  const first = compact(envelope({ tasks: [task({ observedEventAt: '2026-11-15T00:00:00Z' })] }));
  const next = compact(envelope({ tasks: [task({ observedEventAt: '2026-11-15T00:00:01Z' })] }));
  assert.equal(first.digest, next.digest); assert.equal('observedEventAt' in next.tasks[0], false);
});

test('directory descriptors omit task lists while selected reads preserve them and aggregate attention', () => {
  const nativeTasks = compact(envelope()), aggregateActivity = nativeTaskActivity(nativeTasks);
  const entry = { source: { ...source, title: 'Parent', updatedAt: 1000 }, binding: { happySessionId: 'relay-parent', metadata: {}, metadataVersion: 1 },
    actor: { transport: { peerSnapshot: () => ({ metadata: {}, agentState: { aggregateActivity, nativeTasks, requests: {} } }) } } };
  const directory = recentDescriptor(entry, 1000), selected = recentDescriptor(entry, 1000, true);
  assert.equal('nativeTasks' in directory.agentState, false); assert.deepEqual(directory.agentState.aggregateActivity, aggregateActivity);
  assert.deepEqual(selected.agentState.nativeTasks, nativeTasks);
});

test('cold directory descriptors retain canonical project metadata without promoting an owner', () => {
  const entry = { source: { app: 'antigravity', id: 'current', hostId: 'host', workspace: '/fixture/worktrees/task', updatedAt: 0 },
    binding: { happySessionId: 'relay', metadata: { nativeSession: { projectKey: 'main-project', projectPath: '/fixture/main', projectLabel: 'Main' } } } };
  const cold = recentDescriptor(entry, Date.now());
  assert.equal(cold.metadata.nativeSession.projectKey, 'main-project'); assert.equal(cold.metadata.nativeSession.projectPath, '/fixture/main');
  assert.equal(cold.active, false); assert.equal(cold.agentState, null);
  const fresh = recentDescriptor({ ...entry, source: { ...entry.source, project: { key: 'verified-new', path: '/fixture/new', label: 'New' } } }, Date.now());
  assert.equal(fresh.metadata.nativeSession.projectKey, 'verified-new');
});
