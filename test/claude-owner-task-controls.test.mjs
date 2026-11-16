import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { installClaudeOwnerBridge } from '../src/adapters/claude-owner-bridge.mjs';

/** @typedef {Record<string,any>} Value */
/** Native control fixture; no app/model/keyboard is run. @param {Value} options @param {(f:Value)=>Promise<void>} run */
async function fixture(options, run) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-task-control-')), artifact = join(dir, 'app.asar'), meta = join(dir, 'meta.json'), runtimePath = join(dir, 'runtime.json');
  await writeFile(artifact, 'fixture artifact'); await writeFile(meta, JSON.stringify({ appliedId: 'fixture' }));
  const parent = /** @type {Value} */ ({ sessionId: 'native-parent', createdAt: 1, query: {}, cliSessionId: 'native-cli', foregroundTasks: new Map() });
  const code = /** @type {Value} */ (new EventEmitter()), lam = /** @type {Value} */ (new EventEmitter());
  code.sessions = new Map([[parent.sessionId, parent]]); lam.sessions = new Map(); code.permissionBroker = { pendingPermissions: new Map() };
  code.getSessionList = async () => ({ sessions: [{ sessionId: parent.sessionId, isRunning: true }] }); lam.getSessionList = async () => ({ sessions: [] });
  const f = /** @type {Value} */ ({ parent, code, calls: [], output: { output: 'complete native marker', truncated: true }, beforeIpc: null, onStop: null });
  code.cliTaskControls = { deps: { getSession: () => f.parked ?? parent, held: () => f.parked ?? parent } };
  code.getTaskOutputTail = async (/** @type {string} */ id, /** @type {string} */ taskId) => { f.calls.push({ operation: 'output', id, taskId }); return f.output; };
  code.stopBackgroundTask = async (/** @type {string} */ id, /** @type {string} */ taskId) => { f.calls.push({ operation: 'stop', id, taskId }); await f.onStop?.(taskId); };
  const originalOutput = code.getTaskOutputTail, originalStop = code.stopBackgroundTask;
  const wc = /** @type {Value} */ (new EventEmitter()); wc.isDestroyed = () => false; wc.getURL = () => 'app://localhost/new';
  const native = { LocalSessions: { getTaskOutput: (/** @type {string} */ id, /** @type {string} */ taskId) => code.getTaskOutputTail(id, taskId),
    stopTask: (/** @type {string} */ id, /** @type {string} */ taskId) => code.stopBackgroundTask(id, taskId) } };
  wc.mainFrame = { executeJavaScript: (/** @type {string} */ script) => { f.beforeIpc?.(); return runInNewContext(script, { location: new URL(wc.getURL()), window: { 'claude.web': native } }); } };
  const app = /** @type {Value} */ (new EventEmitter()); app.getVersion = () => '4.16336.0'; app.getAppPath = () => artifact; app.getPath = () => dir;
  const main = { Hft: () => ({ type: '3p', getProvider: () => ({ creds: { provider: 'gateway' } }), managesProviderRouting: () => true }),
    Lut: () => ({ inference: { provider: 'gateway', baseUrl: 'https://fixture.invalid', credential: { kind: 'static' } }, codeSurface: { enabled: true } }),
    Fut: () => ({ type: 'local' }), Wdt: () => meta, bdt: () => true, r3: () => 'allowed' };
  const require = createRequire(import.meta.url), hostRequire = (/** @type {string} */ path) => {
    if (/index.chunk-(yo8W6L7k|DzkpfKOD)/.test(path)) throw Error('API factory prohibited');
    return path === 'original-fs' ? fs : path.includes('index.chunk-Du-Wqi0E') ? main : path.includes('index.chunk-CqaSnEfn') ? { claudeCodeSessionManager: code }
      : path.includes('index.chunk-vuRwhTdh') ? { n: lam } : require(path);
  };
  const bridge = await installClaudeOwnerBridge({ electron: { app, webContents: { getAllWebContents: () => [wc] } }, hostRequire, runtimePath,
    expectedAsarSha256: createHash('sha256').update('fixture artifact').digest('hex'), ...options });
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  f.call = async (/** @type {string} */ method, /** @type {Value} */ params = {}, commandId = 'stable-task-stop') => (await fetch(runtime.origin + '/rpc', {
    method: 'POST', headers: { Authorization: 'Bearer ' + runtime.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, method, ...(method.endsWith('.stopTask') ? { commandId } : {}), params: { sessionId: parent.sessionId, ...params } }) })).json();
  f.emit = (/** @type {Value} */ message) => code.emit('event', { type: 'message', sessionId: parent.sessionId, message: { type: 'system', session_id: parent.cliSessionId, ...message } });
  f.start = (taskId = 'task-a', taskType = 'local_bash') => { parent.foregroundTasks.set(taskId, taskType); f.emit({ subtype: 'task_started', task_id: taskId, task_type: taskType, is_backgrounded: false }); };
  f.params = async (taskId = 'task-a') => { const reply = await f.call('code.taskFeed'); return { taskId, expectedOwnerGeneration: reply.result.scope.ownerGeneration, expectedExecutionToken: reply.result.scope.queryToken }; };
  f.assertRestored = () => { assert.equal(code.getTaskOutputTail, originalOutput); assert.equal(code.stopBackgroundTask, originalStop); assert.equal(code.listenerCount('event'), 1); };
  try { await f.call('code.taskFeed'); await run(f); } finally { await bridge.deactivate(); await rm(dir, { recursive: true, force: true }); }
}

test('task controls default to unadvertised and native output keeps original text/truncation with restored method', async () => fixture({}, async f => {
  f.start(); const params = await f.params(), before = await f.call('code.taskFeed');
  assert.deepEqual(before.result.capabilities.outputTaskTypes, []); assert.deepEqual(before.result.capabilities.stopTaskTypes, []);
  const reply = await f.call('code.taskOutput', params); assert.equal(reply.ok, true); assert.equal(reply.result.output, 'complete native marker'); assert.equal(reply.result.truncated, true);
  assert.equal(f.calls.length, 1); f.assertRestored();
}));

test('unproved/foreign/type/parked/query contexts fail before native calls', async () => fixture({}, async f => {
  const params = await f.params(); let reply = await f.call('code.taskOutput', params); assert.equal(reply.error.code, 'native-task-birth-unproven');
  f.start('task-a', 'local_agent'); reply = await f.call('code.taskOutput', params); assert.equal(reply.error.code, 'unsupported-task-type');
  f.start(); f.parked = { ...f.parent }; reply = await f.call('code.taskOutput', params); assert.equal(reply.error.code, 'native-task-owner-unproven');
  delete f.parked; reply = await f.call('code.taskOutput', { ...params, expectedExecutionToken: 'old-query' }); assert.equal(reply.error.code, 'stale-query');
  assert.equal(reply.effectMayHaveOccurred, false); assert.equal(f.calls.length, 0); f.assertRestored();
}));

test('readonly stop rejects before receipt admission and output/stop verification types stay separate', async () => fixture({ readOnly: true, verifiedCodeTaskOutputTypes: ['local_bash'], verifiedCodeTaskStopTypes: ['local_bash'] }, async f => {
  f.start(); const params = await f.params(), feed = await f.call('code.taskFeed');
  assert.deepEqual(feed.result.capabilities.outputTaskTypes, ['local_bash']); assert.deepEqual(feed.result.capabilities.stopTaskTypes, []);
  const reply = await f.call('code.stopTask', params, 'bad'); assert.equal(reply.error.code, 'native-read-only'); assert.equal(reply.effectMayHaveOccurred, false); assert.equal(f.calls.length, 0);
  assert.equal((await f.call('code.taskOutput', params)).ok, true); f.assertRestored();
}));

test('query or task birth change in the renderer IPC gap is fenced at native manager entry', async () => fixture({}, async f => {
  f.start(); const params = await f.params(); f.beforeIpc = () => { f.parent.query = {}; };
  const reply = await f.call('code.stopTask', params); assert.equal(reply.ok, false); assert.equal(reply.error.code, 'stale-query');
  assert.equal(reply.effectMayHaveOccurred, false); assert.equal(f.calls.length, 0); f.assertRestored();
}));

test('same-query task ID replacement cannot reuse the captured native birth in an in-flight invocation', async () => fixture({}, async f => {
  f.start(); const params = await f.params(), query = f.parent.query; f.beforeIpc = () => { f.start(); };
  const reply = await f.call('code.taskOutput', params); assert.equal(reply.error.code, 'stale-task-scope'); assert.equal(reply.effectMayHaveOccurred, false);
  assert.equal(f.parent.query, query); assert.equal(f.calls.length, 0); f.assertRestored();
}));

test('void and roster disappearance cannot prove stop, and receipt reuse never dispatches twice', async () => fixture({}, async f => {
  f.start(); const params = await f.params(); f.onStop = () => { f.parent.foregroundTasks.clear();
    f.emit({ subtype: 'task_notification', task_id: 'task-a', status: 'stopped', uuid: 'foreign-stop-event', session_id: 'foreign-cli' }); };
  const first = await f.call('code.stopTask', params); assert.equal(first.ok, true); assert.equal(first.result.stopped, false); assert.equal(first.result.readbackConfirmed, false);
  assert.equal(first.result.terminalProof, null); const again = await f.call('code.stopTask', params); assert.deepEqual(again.result, first.result); assert.equal(f.calls.length, 1); f.assertRestored();
}));

test('only exact later native notification confirms target stop while sibling and query survive', async () => fixture({}, async f => {
  f.start(); f.start('task-b'); const params = await f.params(), query = f.parent.query;
  f.onStop = (/** @type {string} */ taskId) => { f.parent.foregroundTasks.delete(taskId); f.emit({ subtype: 'task_notification', task_id: taskId, status: 'stopped', uuid: 'actual-stop-event' }); };
  const reply = await f.call('code.stopTask', params); assert.equal(reply.ok, true); assert.equal(reply.result.stopped, true); assert.equal(reply.result.readbackConfirmed, true);
  assert.equal(reply.result.terminalProof.nativeEventId, 'actual-stop-event'); assert.equal(f.parent.foregroundTasks.has('task-b'), true); assert.equal(f.parent.query, query);
  await f.call('code.stopTask', params); assert.equal(f.calls.length, 1); f.assertRestored();
}));

test('natural completed status remains completed and output null/oversize stays unavailable', async () => fixture({}, async f => {
  f.start(); let params = await f.params(); f.output = null; let reply = await f.call('code.taskOutput', params); assert.equal(reply.error.code, 'native-task-output-unavailable');
  f.output = { output: '中'.repeat(22000), truncated: false }; reply = await f.call('code.taskOutput', params); assert.equal(reply.error.code, 'native-task-output-too-large');
  f.onStop = (/** @type {string} */ taskId) => { f.emit({ subtype: 'task_notification', task_id: taskId, status: 'completed', uuid: 'actual-completion' }); };
  params = await f.params(); reply = await f.call('code.stopTask', params); assert.equal(reply.result.stopped, false); assert.equal(reply.result.observedStatus, 'completed'); assert.equal(reply.result.readbackConfirmed, true); f.assertRestored();
}));

test('a same-birth native terminal task keeps readonly output but cannot be stopped again', async () => fixture({}, async f => {
  f.start(); const params = await f.params(); f.onStop = (/** @type {string} */ taskId) => { f.parent.foregroundTasks.delete(taskId);
    f.emit({ subtype: 'task_notification', task_id: taskId, status: 'stopped', uuid: 'actual-terminal' }); };
  assert.equal((await f.call('code.stopTask', params)).result.stopped, true);
  const output = await f.call('code.taskOutput', params); assert.equal(output.ok, true); assert.equal(output.result.output, 'complete native marker');
  const again = await f.call('code.stopTask', params, 'another-stop-id'); assert.equal(again.error.code, 'native-task-birth-unproven'); assert.equal(again.effectMayHaveOccurred, false);
  assert.equal(f.calls.filter((/** @type {Value} */ row) => row.operation === 'stop').length, 1); f.assertRestored();
}));

test('foreign terminal and task ID reuse cannot loan the old terminal output proof', async () => fixture({}, async f => {
  f.start(); const params = await f.params(); f.parent.foregroundTasks.clear();
  f.emit({ subtype: 'task_notification', task_id: 'task-a', status: 'stopped', session_id: 'other-cli' });
  let output = await f.call('code.taskOutput', params); assert.equal(output.error.code, 'native-task-membership-unproven'); assert.equal(f.calls.length, 0);
  f.emit({ subtype: 'task_notification', task_id: 'task-a', status: 'stopped' });
  f.start('task-a', 'local_agent'); output = await f.call('code.taskOutput', params); assert.equal(output.error.code, 'unsupported-task-type'); assert.equal(f.calls.length, 0);
  f.parent.query = {}; output = await f.call('code.taskOutput', params); assert.equal(output.error.code, 'stale-query'); assert.equal(f.calls.length, 0); f.assertRestored();
}));

test('a concurrent foreign manager replacement is never overwritten during guard cleanup', async () => fixture({}, async f => {
  f.start(); const params = await f.params(), foreign = async () => ({ output: 'foreign', truncated: false }); f.beforeIpc = () => { f.code.getTaskOutputTail = foreign; };
  const reply = await f.call('code.taskOutput', params); assert.equal(reply.ok, false); assert.equal(reply.error.code, 'native-task-dispatch-unconfirmed'); assert.equal(f.code.getTaskOutputTail, foreign);
}));

test('native directory preserves background positives and read-start age, but query drift removes activity authority', async () => fixture({}, async f => {
  const header = { sessionId: f.parent.sessionId, isRunning: false, turnRunning: false, hasBackgroundActivity: true, hasBackgroundWork: false };
  let nativeReadStarted = 0;
  f.code.getSessionList = async () => { nativeReadStarted = Date.now(); await new Promise(resolve => setTimeout(resolve, 10)); return { sessions: [header], archivedPending: false, loadGeneration: 1 }; };
  let reply = await f.call('code.list'); const row = reply.result.sessions[0];
  assert.equal(row.hasBackgroundActivity, true); assert.equal(row.turnRunning, false); assert.equal(row.headerIdentityVerified, true); assert.equal(row.headerCollectionComplete, true);
  assert.ok(row.headerReadStartedAt <= nativeReadStarted);
  f.code.getSessionList = async () => ({ sessions: [header] }); reply = await f.call('code.list'); assert.equal(reply.result.sessions[0].headerCollectionComplete, false);
  f.code.getSessionList = async () => { f.parent.query = {}; return { sessions: [header] }; };
  reply = await f.call('code.list'); assert.equal(reply.result.sessions[0].headerIdentityVerified, false); assert.equal(reply.result.sessions[0].hasBackgroundActivity, null); assert.equal(reply.result.sessions[0].ownerGeneration, null);
}));
