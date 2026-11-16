import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeDesktopBackend } from '../src/adapters/claude-backend.mjs';
import { claudeDesktopHostId } from '../src/adapters/claude-desktop-rpc.mjs';
import { sourceNativeTasks } from '../src/adapters/source-native-tasks.mjs';
import { BridgeError } from '../src/errors.mjs';

/** @typedef {Record<string,any>} Value */
function fixture() {
  const runtime = { generation: 'native-main', storagePath: '/fixture/capture', profileNamespace: 'capture' };
  const source = { app: 'claude-desktop', id: 'native-parent', hostId: claudeDesktopHostId(runtime, 'claude-code-sessions'), nativeCollection: 'claude-code-sessions' };
  /** @type {Value} */ const state = { query: 'query-a', reads: 0, failure: false, beforeRead: null };
  const scope = () => ({ ...source, parentConversationId: source.id, ownerGeneration: 'native-owner', runtimeGeneration: runtime.generation,
    queryToken: state.query, cliSessionId: 'native-cli' });
  const rpc = /** @type {any} */ ({ latestRuntime: runtime, generation: () => runtime.generation, dispose: async () => {},
    call: async (/** @type {string} */ method) => {
      if (method === 'code.snapshot') return { sessionId: source.id, ownerGeneration: 'native-owner', executionToken: state.query,
        header: { sessionId: source.id, sessionType: 'code', queryPresent: true, isRunning: false }, messages: [], hasMore: false };
      if (method !== 'code.taskFeed') throw Error('No app/model operation in fixture');
      state.reads++; await state.beforeRead?.();
      if (state.failure) throw new BridgeError('unsupported-native-action', 'Fixture task feed unavailable.');
      return { version: 1, scope: scope(), sessionId: source.id, ownerGeneration: 'native-owner', runtimeGeneration: runtime.generation,
        executionToken: state.query, cliSessionId: 'native-cli', queryPresent: true, cursor: 0, events: [],
        level: { type: 'system', subtype: 'background_tasks_changed', session_id: 'native-cli', tasks: [] },
        foregroundLevel: { available: true, complete: true, tasks: [{ task_id: 'native-task', task_type: 'local_agent' }] },
        coverage: { available: true, foregroundComplete: true, levelComplete: true, dispatchAvailable: true, dispatchComplete: true }, dispatchChildren: [] };
    } });
  return { source, state, scope, runtime, backend: new ClaudeDesktopBackend({ rpc }) };
}

test('successful capture advances independently from semantic digest and cannot be mutated through a returned frame', async () => {
  const { backend, source } = fixture();
  const first = await backend.taskSnapshot(source.id), second = await backend.taskSnapshot(source.id);
  assert.match(first.capture.epoch, /^[a-f0-9]{32}$/);
  assert.equal(second.capture.epoch, first.capture.epoch);
  assert.ok(second.capture.seq > first.capture.seq);
  const compact = (/** @type {Value} */ frame) => sourceNativeTasks(frame, source, frame.scope.ownerGeneration,
    { runtimeGeneration: frame.scope.runtimeGeneration, queryToken: frame.scope.queryToken, current: true });
  assert.equal(compact(first)?.digest, compact(second)?.digest);
  assert.equal(compact(first)?.capture, undefined);
  const saved = { ...backend.taskStates.get(source.id)?.capture };
  second.capture.seq = -1;
  assert.deepEqual(backend.taskStates.get(source.id)?.capture, saved);
});

test('source views carry capture while unchanged task semantics keep the same content stamp', async () => {
  const { backend, source } = fixture();
  const first = await backend.snapshot(source.id), second = await backend.snapshot(source.id);
  assert.deepEqual(first.nativeTaskCapture, first.nativeTasks.capture);
  assert.deepEqual(second.nativeTaskCapture, second.nativeTasks.capture);
  assert.ok(second.nativeTaskCapture.seq > first.nativeTaskCapture.seq);
  assert.equal(second.contentStamp, first.contentStamp);
});

test('failed or unavailable reads never mint fresh capture proof or move old capture to a new query', async () => {
  const { backend, source, state, scope } = fixture();
  const first = await backend.taskSnapshot(source.id);
  state.failure = true;
  await assert.rejects(backend.taskSnapshot(source.id), { code: 'unsupported-native-action' });
  assert.equal(backend.taskCaptureSequence, first.capture.seq);
  const unavailable = backend.unavailableTasks(source.id);
  assert.equal(unavailable.tasksAvailable, false);
  assert.deepEqual(unavailable.capture, first.capture);
  state.query = 'query-b';
  assert.equal(backend.unavailableTasks(source.id, scope()).capture, null);
});

test('parent capture sequence remains monotonic across query change and task-state eviction', async () => {
  const { backend, source, state } = fixture();
  const first = await backend.taskSnapshot(source.id);
  state.query = 'query-b';
  const changed = await backend.taskSnapshot(source.id);
  assert.ok(changed.capture.seq > first.capture.seq);
  assert.equal(changed.capture.epoch, first.capture.epoch);
  backend.taskStates.delete(source.id);
  const recovered = await backend.taskSnapshot(source.id);
  assert.ok(recovered.capture.seq > changed.capture.seq);
  assert.equal(recovered.capture.epoch, first.capture.epoch);
});

test('forty coalesced reads share one capture and one successful native metadata read', async () => {
  const { backend, source, state } = fixture();
  /** @type {()=>void} */ let release = () => {};
  const gate = new Promise(resolve => { release = () => resolve(undefined); });
  state.beforeRead = () => gate;
  const reads = Array.from({ length: 40 }, () => backend.taskSnapshot(source.id));
  release();
  const frames = await Promise.all(reads);
  assert.equal(state.reads, 1);
  assert.equal(backend.taskCaptureSequence, 1);
  assert.ok(frames.every(frame => frame.capture.seq === frames[0].capture.seq && frame.capture.epoch === frames[0].capture.epoch));
});
