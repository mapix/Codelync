import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { installClaudeOwnerBridge } from '../src/adapters/claude-owner-bridge.mjs';

/** @param {(f:Record<string,any>)=>Promise<void>} run */
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-task-feed-')), artifact = join(dir, 'app.asar'), metadata = join(dir, 'meta.json'), runtimePath = join(dir, 'runtime.json');
  await writeFile(artifact, 'native fixture'); await writeFile(metadata, JSON.stringify({ appliedId: 'fixture' }));
  const parent = /** @type {Record<string,any>} */ ({ sessionId: 'native-parent', createdAt: 1, query: {}, cliSessionId: 'cli-parent', foregroundTasks: new Map() });
  const manager = (/** @type {Record<string,any>[]} */ records) => {
    const result = /** @type {any} */ (new EventEmitter()); result.sessions = new Map(records.map(record => [record.sessionId, record])); result.permissionBroker = { pendingPermissions: new Map() };
    result.reads = 0; result.getSessionList = async () => { result.reads++; await result.onRead?.(); return { restPending: result.restPending === true,
      sessions: [...result.sessions.values()].map(record => ({ sessionId: record.sessionId, title: 'native fixture', isRunning: record.isRunning === true })) }; };
    return result;
  };
  const code = manager([parent]), lam = manager([]), app = /** @type {any} */ (new EventEmitter());
  app.getVersion = () => '4.16336.0'; app.getAppPath = () => artifact; app.getPath = () => dir;
  const main = { Hft: () => ({ type: '3p', getProvider: () => ({ creds: { provider: 'gateway' } }), managesProviderRouting: () => true }),
    Lut: () => ({ inference: { provider: 'gateway', baseUrl: 'https://fixture.invalid', credential: { kind: 'static' } }, codeSurface: { enabled: true }, chatSurface: { enabled: true } }),
    Fut: () => ({ type: 'local' }), Wdt: () => metadata, bdt: () => true, r3: () => 'allowed' };
  const nativeRequire = createRequire(import.meta.url), hostRequire = (/** @type {string} */ path) => {
    if (/index.chunk-(yo8W6L7k|DzkpfKOD)/.test(path)) throw Error('Native factory must not run');
    return path === 'original-fs' ? fs : path.includes('index.chunk-Du-Wqi0E') ? main : path.includes('index.chunk-CqaSnEfn') ? { claudeCodeSessionManager: code }
      : path.includes('index.chunk-vuRwhTdh') ? { n: lam } : nativeRequire(path);
  };
  const bridge = await installClaudeOwnerBridge({ electron: { app }, hostRequire, runtimePath,
    expectedAsarSha256: createHash('sha256').update('native fixture').digest('hex') });
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  const call = async (/** @type {Record<string,any>} */ params = {}) => (await fetch(runtime.origin + '/rpc', { method: 'POST', headers: {
    Authorization: 'Bearer ' + runtime.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, method: 'code.taskFeed', params: { sessionId: parent.sessionId, ...params } }) })).json();
  const emit = (/** @type {Record<string,any>} */ message) => code.emit('event', { type: 'message', sessionId: parent.sessionId,
    message: message.type === 'system' && message.session_id === parent.cliSessionId ? message : { type: 'system', session_id: parent.cliSessionId, ...message } });
  try { await run({ code, lam, parent, call, emit }); } finally { await bridge.deactivate(); await rm(dir, { recursive: true, force: true }); }
}

test('pre-install maps/levels do not gain current proof and null absent query accepts its public fence', async () => fixture(async f => {
  f.parent.foregroundTasks.set('old-task', 'local_agent'); f.parent.lastBackgroundTasksLevel = { type: 'system', subtype: 'background_tasks_changed', session_id: 'cli-parent', tasks: [] };
  let reply = await f.call(); assert.equal(reply.ok, true); assert.equal(reply.result.foregroundLevel.available, false); assert.equal(reply.result.level, null);
  f.parent.query = null; reply = await f.call({ expectedExecutionToken: null }); assert.equal(reply.ok, true); assert.equal(reply.result.queryPresent, false); assert.equal(reply.result.scope.queryToken, null);
  assert.equal(reply.result.capabilities.taskStopVerified, false); assert.equal(reply.result.capabilities.taskOutputVerified, false);
}));

test('native event proof enables bounded current metadata without bodies, definitions or transcripts', async () => fixture(async f => {
  await f.call(); f.parent.foregroundTasks.set('native-task', 'local_agent');
  f.emit({ subtype: 'task_started', uuid: 'native-event', task_id: 'native-task', task_type: 'local_agent', output_file: '/private/output', credentials: 'synthetic-secret' });
  const level = { type: 'system', subtype: 'background_tasks_changed', session_id: f.parent.cliSessionId, uuid: 'level-event', tasks: [{ task_id: 'bg-task', task_type: 'local_bash', status: 'running', credentials: 'synthetic-secret' }] };
  f.parent.lastBackgroundTasksLevel = level; f.emit(level);
  const reply = await f.call(); assert.equal(reply.ok, true); assert.equal(reply.result.foregroundLevel.available, true); assert.equal(reply.result.coverage.foregroundComplete, true);
  assert.equal(reply.result.coverage.levelComplete, true); assert.equal(reply.result.scope.ownerGeneration, reply.result.ownerGeneration); assert.equal(reply.result.scope.queryToken, reply.result.executionToken);
  assert.equal(reply.result.events.length, 2); assert.ok(reply.result.events.every((/** @type {any} */ row) => row.sequence < reply.result.cursor));
  assert.equal(JSON.stringify(reply).includes('synthetic-secret'), false); assert.equal(JSON.stringify(reply).includes('/private/output'), false);
  assert.equal(f.code.reads, 1); assert.equal(f.lam.reads, 1);
}));

test('in-place level mutation cannot use an old event digest to publish fresh running status', async () => fixture(async f => {
  await f.call(); const level = { type: 'system', subtype: 'background_tasks_changed', session_id: f.parent.cliSessionId, tasks: [{ task_id: 'bg-task', task_type: 'local_agent', status: 'running' }] };
  f.parent.lastBackgroundTasksLevel = level; f.emit(level); assert.equal((await f.call()).result.coverage.levelComplete, true);
  level.tasks[0].status = 'paused'; const after = await f.call(); assert.equal(after.result.coverage.levelComplete, false); assert.equal(after.result.level.tasks[0].status, 'unknown');
}));

test('foreground snapshot is captured after awaited reads and pending dispatch inventory is partial', async () => fixture(async f => {
  f.code.onRead = () => { f.parent.foregroundTasks.set('during-read', 'local_agent'); f.emit({ subtype: 'task_started', task_id: 'during-read', task_type: 'local_agent' }); };
  f.lam.onRead = () => { f.parent.foregroundTasks.clear(); }; f.lam.restPending = true;
  const result = await f.call(); assert.equal(result.ok, true); assert.equal(result.result.foregroundLevel.available, true); assert.deepEqual(result.result.foregroundLevel.tasks, []);
  assert.equal(result.result.coverage.dispatchAvailable, true); assert.equal(result.result.coverage.dispatchComplete, false);
}));

test('child owner replacement during the other collection read cannot attach old header status to its new owner', async () => fixture(async f => {
  const child = { sessionId: 'native-child', createdAt: 1, query: {}, dispatchParentId: f.parent.sessionId, isRunning: true };
  f.code.sessions.set(child.sessionId, child); f.lam.onRead = () => { f.code.sessions.set(child.sessionId, { ...child, createdAt: 2, query: {} }); };
  const reply = await f.call(); assert.equal(reply.ok, true); assert.deepEqual(reply.result.dispatchChildren, []); assert.equal(reply.result.coverage.dispatchComplete, false);
}));

test('query replacement during header read rejects the entire old scope rather than adopting new tasks', async () => fixture(async f => {
  f.lam.onRead = () => { f.parent.query = {}; f.parent.cliSessionId = 'new-cli'; };
  const reply = await f.call(); assert.equal(reply.ok, false); assert.equal(reply.error.code, 'stale-query');
}));

test('same child owner/query preserves native current status changes across awaited collection reads', async () => fixture(async f => {
  const child = { sessionId: 'native-child', createdAt: 1, query: {}, dispatchParentId: f.parent.sessionId, isRunning: true };
  f.code.sessions.set(child.sessionId, child); f.lam.onRead = () => { child.isRunning = false; };
  const reply = await f.call(); assert.equal(reply.ok, true); assert.equal(reply.result.dispatchChildren.length, 1);
  assert.equal(reply.result.dispatchChildren[0].nativeRecord.isRunning, false);
}));

test('background/progress on a new query cannot loan provenance to reused old foreground IDs', async () => fixture(async f => {
  await f.call(); f.parent.foregroundTasks.set('old-task', 'local_agent');
  f.emit({ subtype: 'task_started', task_id: 'old-task', task_type: 'local_agent', is_backgrounded: false });
  assert.equal((await f.call()).result.foregroundLevel.available, true);
  f.parent.query = {};
  const level = { type: 'system', subtype: 'background_tasks_changed', session_id: f.parent.cliSessionId, tasks: [] };
  f.parent.lastBackgroundTasksLevel = level; f.emit(level);
  let reply = await f.call(); assert.equal(reply.result.foregroundLevel.available, false); assert.deepEqual(reply.result.foregroundLevel.tasks, []);
  f.emit({ subtype: 'task_progress', task_id: 'old-task', task_type: 'local_agent' });
  reply = await f.call(); assert.equal(reply.result.foregroundLevel.available, false);
  f.parent.foregroundTasks.set('new-task', 'local_agent'); f.emit({ subtype: 'task_started', task_id: 'new-task', task_type: 'local_agent', is_backgrounded: false });
  reply = await f.call(); assert.equal(reply.result.foregroundLevel.available, true); assert.equal(reply.result.foregroundLevel.complete, false);
  assert.deepEqual(reply.result.foregroundLevel.tasks, [{ task_id: 'new-task', task_type: 'local_agent' }]);
}));

test('a child lost before the first resident lookup cannot become complete empty dispatch inventory', async () => fixture(async f => {
  const child = { sessionId: 'native-child', createdAt: 1, query: {}, dispatchParentId: f.parent.sessionId, isRunning: true };
  f.code.sessions.set(child.sessionId, child);
  f.code.getSessionList = async () => { const sessions = [...f.code.sessions.values()].map(record => ({ sessionId: record.sessionId, title: 'native fixture', isRunning: record.isRunning === true }));
    f.code.sessions.delete(child.sessionId); return { sessions, restPending: false }; };
  const reply = await f.call(); assert.equal(reply.ok, true); assert.deepEqual(reply.result.dispatchChildren, []); assert.equal(reply.result.coverage.dispatchComplete, false);
}));

test('a new dispatch resident absent from cached native inventory removes completeness', async () => fixture(async f => {
  await f.call(); f.code.sessions.set('new-child', { sessionId: 'new-child', createdAt: 1, query: {}, dispatchParentId: f.parent.sessionId, isRunning: true });
  const reply = await f.call(); assert.equal(reply.ok, true); assert.equal(reply.result.coverage.dispatchComplete, false);
}));
