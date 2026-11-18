import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { chmod, copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CLAUDE_TASK_LIMITS, projectClaudeTasks, readClaudeTaskLogPage } from '../src/adapters/claude-tasks.mjs';
import { NativeTaskTransfers } from '../src/codelync/native-task-transfers.mjs';
import { CodexSavedHistoryReader, readCodexSavedMetadata } from '../src/adapters/codex-history.mjs';

/** @typedef {Record<string, any>} Value */

const SCOPE = {
  app: 'claude-desktop',
  nativeCollection: 'claude-code-sessions',
  parentConversationId: 'desktop-parent',
  hostId: 'local:claude-desktop:' + 'a'.repeat(64),
  ownerGeneration: 'owner-a',
  runtimeGeneration: 'runtime-a',
  queryToken: 'query-a',
  cliSessionId: 'cli-a',
};

/** @param {string} subtype @param {Value} [extra] */
const taskEvent = (subtype, extra = {}) => ({
  type: 'system',
  subtype,
  uuid: 'ev-' + subtype,
  session_id: 'cli-a',
  task_id: 'task-a',
  task_type: 'local_agent',
  timestamp: '2026-11-17T00:00:00Z',
  ...extra,
});

/** @param {Value} [extra] */
const taskInput = (extra = {}) => ({
  scope: SCOPE,
  observedScope: SCOPE,
  connected: true,
  fresh: true,
  events: [],
  coverage: { available: true, lifecycleComplete: false, levelComplete: false },
  ...extra,
});

const TRANSFER_FLAGS = [
  'tasksAvailable',
  'tasksComplete',
  'backgroundTasksComplete',
  'tasksTruncated',
  'dispatchChildrenAvailable',
  'dispatchChildrenComplete',
  'dispatchChildrenTruncated',
  'partial',
];

/** @param {unknown} value @returns {unknown} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, item]) => [k, canonical(item)]),
    );
  }
  return value;
}

/** @param {Value} value @returns {Value} */
function signedSnapshot(value) {
  const body = {
    version: value.version,
    scope: value.scope,
    tasks: value.tasks,
    dispatchChildren: value.dispatchChildren,
    ...Object.fromEntries(TRANSFER_FLAGS.map((k) => [k, value[k]])),
  };
  return {
    ...value,
    digest: createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex'),
  };
}

/** @param {Value} [scopePatch] @param {number} [count] @returns {Value} */
function makeSnapshot(scopePatch = {}, count = 4) {
  return signedSnapshot({
    version: 1,
    scope: { ...SCOPE, ...scopePatch },
    tasks: Array.from({ length: count }, (_, i) => ({
      nativeTaskId: `t-${i}`,
      name: `Task ${i}`,
      taskType: 'local_agent',
      kind: 'agent',
      status: 'running',
      isBackgrounded: true,
      statusSource: 'native-lifecycle',
    })),
    dispatchChildren: [],
    tasksAvailable: true,
    tasksComplete: true,
    backgroundTasksComplete: true,
    tasksTruncated: false,
    dispatchChildrenAvailable: true,
    dispatchChildrenComplete: true,
    dispatchChildrenTruncated: false,
    partial: false,
  });
}

test('R092: readClaudeTaskLogPage rejects malformed inputs, invalid limits and zero/leading-zero cursors', () => {
  const events = Array.from({ length: 5 }, (_, i) =>
    taskEvent('task_progress', { uuid: `p-${i}`, task_id: 'task-a' }));
  const projected = projectClaudeTasks(taskInput({ events }));
  const key = projected.state.scopeKey;
  const filter = createHash('sha256').update(JSON.stringify('task-a')).digest('hex').slice(0, 32);

  assert.equal(readClaudeTaskLogPage(/** @type {any} */ (null), { scope: SCOPE }).status, 'scope-mismatch');
  assert.equal(readClaudeTaskLogPage(projected.state, /** @type {any} */ (null)).status, 'scope-mismatch');
  assert.equal(readClaudeTaskLogPage(projected.state, { scope: SCOPE, limit: 0 }).status, 'invalid-limit');
  assert.equal(readClaudeTaskLogPage(projected.state, { scope: SCOPE, limit: -3 }).status, 'invalid-limit');
  assert.equal(readClaudeTaskLogPage(projected.state, { scope: SCOPE, limit: /** @type {any} */ ('10') }).status, 'invalid-limit');
  assert.equal(readClaudeTaskLogPage(projected.state, { scope: SCOPE, limit: 1.5 }).status, 'invalid-limit');
  assert.equal(readClaudeTaskLogPage(projected.state, { scope: SCOPE, limit: 999 }).logs.length, 5);

  assert.equal(readClaudeTaskLogPage(projected.state, { scope: SCOPE, taskId: 'task-a', before: `ct1.${key}.0.${filter}.5` }).status, 'invalid-cursor');
  assert.equal(readClaudeTaskLogPage(projected.state, { scope: SCOPE, taskId: 'task-a', before: `ct1.${key}.03.${filter}.5` }).status, 'invalid-cursor');
  assert.equal(readClaudeTaskLogPage(projected.state, { scope: SCOPE, taskId: 'task-a', before: `ct1.${key}.4.${filter}.05` }).status, 'invalid-cursor');
  const page = readClaudeTaskLogPage(projected.state, { scope: SCOPE, taskId: 'task-a', limit: 2 });
  assert.equal(page.status, 'ok');
  assert.deepEqual(page.logs.map((/** @type {Value} */ r) => r.sequence), [4, 5]);
});

test('R092: projectClaudeTasks preserves active tasks over terminal tasks under 128-cap and enforces restored bounds', () => {
  const activeStart = taskEvent('task_started', { uuid: 'active-0', task_id: 'long-running' });
  const terminalBurst = Array.from({ length: 135 }, (_, i) =>
    taskEvent('task_notification', { uuid: `done-${i}`, task_id: `done-${i}`, status: 'completed' }));
  const result = projectClaudeTasks(taskInput({ events: [activeStart, ...terminalBurst] }));
  assert.equal(result.tasks.length, CLAUDE_TASK_LIMITS.tasks);
  assert.equal(result.tasksTruncated, true);
  assert.equal(result.tasks.some((/** @type {Value} */ t) => t.nativeTaskId === 'long-running' && t.status === 'running'), true);

  // Refreshed level tasks remain retained even after earlier terminal tasks overflow.
  const seeded = projectClaudeTasks(taskInput({
    level: { type: 'system', subtype: 'background_tasks_changed', session_id: 'cli-a', tasks: [{ task_id: 'bg-live', task_type: 'local_agent', status: 'paused' }] },
  }));
  const overflowed = projectClaudeTasks(taskInput({
    events: terminalBurst,
    level: { type: 'system', subtype: 'background_tasks_changed', session_id: 'cli-a', tasks: [{ task_id: 'bg-live', task_type: 'local_agent', status: 'paused' }] },
  }), seeded.state);
  assert.equal(overflowed.tasks.some((/** @type {Value} */ t) => t.nativeTaskId === 'bg-live' && t.status === 'paused'), true);

  // Restored previous state with oversized arrays is strictly clamped.
  const bloatedPrev = structuredClone(seeded.state);
  bloatedPrev.logs = Array.from({ length: 600 }, (_, i) => ({
    id: `l-${i}`, identity: 'local-log', sequence: i + 1, nativeTaskId: 'bg-live', subtype: 'task_progress',
    taskType: 'local_agent', kind: 'agent', status: 'running', nativeStatus: null, isBackgrounded: true,
  }));
  bloatedPrev.logSequence = 600;
  bloatedPrev.seen = Array.from({ length: 1100 }, (_, i) => ({ id: `seen-${i}`, digest: 'd', taskId: 'bg-live' }));
  const reclamped = projectClaudeTasks(taskInput(), bloatedPrev);
  assert.equal(reclamped.logs.length, CLAUDE_TASK_LIMITS.logs);
  assert.equal(reclamped.logsTruncated, true);
  assert.equal(reclamped.state.seen.length, CLAUDE_TASK_LIMITS.seen);
  assert.equal(reclamped.tasksTruncated, true);
});

test('R092: NativeTaskTransfers validates structure before size, ignores non-digest hints and resets on reconnect scope change', () => {
  const small = makeSnapshot({}, 2);
  const tightCache = new NativeTaskTransfers({ maxBytes: 400 });
  const oversizedMalformed = { ...small, tasks: null, padding: 'x'.repeat(800) };
  assert.throws(() => tightCache.remember(oversizedMalformed), { code: 'invalid-native-task-snapshot' });

  const cache = new NativeTaskTransfers();
  const base = makeSnapshot({ queryToken: 'query-a' }, 8);
  const next = makeSnapshot({ queryToken: 'query-a' }, 8);
  next.tasks[0].status = 'stopped';
  const signedNext = signedSnapshot(next);
  cache.remember(base);

  // Non-hex / prototype-named hints never throw or forge deltas.
  assert.equal(cache.response(signedNext, 'constructor').kind, undefined);
  assert.equal(cache.response(signedNext, /** @type {any} */ (123)).kind, undefined);

  // Reconnect with new queryToken clears previous baseline even if pre-reconnect digest is sent.
  const reconnected = makeSnapshot({ queryToken: 'query-reconnected' }, 8);
  const reconnectReply = cache.response(reconnected, signedNext.digest);
  assert.equal(reconnectReply.kind, undefined);
  assert.equal(cache.snapshots.size, 1);
  assert.equal(cache.snapshots.has(signedNext.digest), false);
});

const CHILD = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
/** @param {string} id @param {boolean} [isChild] */
const metaHeader = (id, isChild = false) => JSON.stringify({
  type: 'session_meta',
  payload: {
    id,
    originator: 'Codex Desktop',
    cli_version: 'fixture',
    source: isChild ? { subagent: { thread_spawn: { parent_thread_id: PARENT, agent_path: '/root/agent' } } } : 'vscode',
  },
}) + '\n';

/** @param {string} id @param {string} text */
const msgLine = (id, text) => JSON.stringify({
  type: 'response_item',
  timestamp: '2026-11-17T00:00:00Z',
  payload: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] },
}) + '\n';

/** @param {import('node:test').TestContext} t @param {number} [maxPageBytes] */
async function codexFixture(t, maxPageBytes = 1024) {
  const root = await mkdtemp(join(tmpdir(), 'codelync-codex-b10-'));
  await mkdir(join(root, 'sessions'));
  const parentPath = join(root, 'sessions', `${PARENT}.jsonl`);
  const childPath = join(root, 'sessions', `${CHILD}.jsonl`);
  await writeFile(parentPath, metaHeader(PARENT), { mode: 0o600 });
  const metadata = new Map([
    [PARENT, { nativeId: PARENT, rolloutPath: parentPath, parentNativeId: null, isSubagent: false }],
    [CHILD, { nativeId: CHILD, rolloutPath: childPath, parentNativeId: PARENT, isSubagent: true, agentPath: '/root/agent' }],
  ]);
  const reader = new CodexSavedHistoryReader({ root, maxPageBytes, loadMetadata: async (id) => structuredClone(metadata.get(id) ?? null) });
  t.after(async () => { reader.close(); await rm(root, { recursive: true, force: true }); });
  return { root, reader, childPath, parentPath };
}

test('R097: strict UTF-8 decoding rejects invalid bytes in headers/records while tolerating incomplete EOF tails', async (t) => {
  const f = await codexFixture(t);

  // Short unterminated header -> codex-history-header-invalid (not header-too-large)
  await writeFile(f.childPath, Buffer.from('{"type":"session_meta"', 'utf8'));
  await assert.rejects(f.reader.readPage(CHILD), { code: 'codex-history-header-invalid' });

  // Invalid UTF-8 in header
  await writeFile(f.childPath, Buffer.concat([Buffer.from('{"type":"session_meta","x":"'), Buffer.from([0xe4, 0xb8]), Buffer.from('"}\n')]));
  await assert.rejects(f.reader.readPage(CHILD), { code: 'codex-history-header-invalid' });

  // Valid header + invalid UTF-8 inside committed record line
  await writeFile(f.childPath, Buffer.concat([
    Buffer.from(metaHeader(CHILD, true)),
    Buffer.from('{"type":"response_item","payload":{"type":"message","id":"m1","role":"assistant","content":[{"type":"output_text","text":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}]}}\n'),
  ]));
  await assert.rejects(f.reader.readPage(CHILD), { code: 'codex-history-record-invalid' });

  // Valid header + valid record + truncated UTF-8 in uncommitted EOF tail -> valid record succeeds, tail stays uncommitted
  await writeFile(f.childPath, Buffer.concat([
    Buffer.from(metaHeader(CHILD, true)),
    Buffer.from(msgLine('committed-ok', 'Clean committed line')),
    Buffer.from('{"type":"response_item","partial":"'),
    Buffer.from([0xe4, 0xb8]),
  ]));
  const view = await f.reader.readPage(CHILD);
  assert.deepEqual(view.rows.map((/** @type {Value} */ r) => r.id), ['committed-ok']);
  assert.equal(view.historicalRead.trailingIncomplete, true);
});

test('R097: backward read landing exactly on a maxPageBytes newline boundary does not skip records or emit mid-line byteStart', async (t) => {
  const hdr = Buffer.from(metaHeader(CHILD, true));
  const recA = Buffer.from(msgLine('rec-a', 'A'.repeat(900)));
  const recB = Buffer.from(msgLine('rec-b', 'B'.repeat(400)));
  const pageBytes = recA.length + recB.length; // Exact byte span so start = hdr.length (immediately after hdr's \n)
  const f = await codexFixture(t, pageBytes);
  await writeFile(f.childPath, Buffer.concat([hdr, recA, recB]));

  const page = await f.reader.readPage(CHILD, { limit: 10 });
  assert.deepEqual(page.rows.map((/** @type {Value} */ r) => r.id), ['rec-a', 'rec-b']);
  assert.equal(page.historicalRead.byteBoundary.start, hdr.length);

  // Empty committed slice after start > 0 with trailing incomplete line yields newline-aligned start for prior page.
  const filler = Buffer.from(msgLine('rec-before', 'Prior message'));
  const blankLines = Buffer.from('\n'.repeat(30));
  const incompleteTail = Buffer.from('{"type":"response_item","incomplete":');
  const smallPage = 1024;
  const f2 = await codexFixture(t, smallPage);
  const longPre = Buffer.from(msgLine('rec-mid', 'M'.repeat(800)));
  await writeFile(f2.childPath, Buffer.concat([hdr, filler, longPre, blankLines, incompleteTail]));
  const tailView = await f2.reader.readPage(CHILD, { limit: 10 });
  assert.equal(tailView.rows.length, 0);
  assert.equal(tailView.historicalRead.trailingIncomplete, true);
  assert.equal(tailView.historicalRead.byteBoundary.start, hdr.length + filler.length + longPre.length + blankLines.length);
  const prevView = await f2.reader.readPage(CHILD, {
    beforeByte: tailView.historicalRead.byteBoundary.start,
    sourceStamp: tailView.historicalRead.sourceStamp,
    limit: 10,
  });
  assert.equal(prevView.rows.some((/** @type {Value} */ r) => r.id === 'rec-mid'), true);
});

/** @param {string} root @returns {Promise<Value>} */
function runIndexWorker(root) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../src/codelync/codex-index-worker.mjs', import.meta.url), {
      execArgv: [],
      workerData: { root, offset: 0, now: 1_700_000_000_000 },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

test('R097: SQLite index reader and worker map missing-WAL, busy lock and corrupt DB without mutating store', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-sqlite-b10-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 1. Missing DB
  const missingDir = join(dir, 'missing');
  await mkdir(missingDir);
  await assert.rejects(readCodexSavedMetadata(missingDir, CHILD), { code: 'codex-history-index-unavailable' });
  assert.deepEqual(await runIndexWorker(missingDir), { ok: false, error: 'codex-index-missing' });

  // 2. Corrupt DB
  const corruptDir = join(dir, 'corrupt');
  await mkdir(corruptDir);
  await writeFile(join(corruptDir, 'state_5.sqlite'), 'not a sqlite file');
  await assert.rejects(readCodexSavedMetadata(corruptDir, CHILD), { code: 'codex-history-index-invalid' });
  assert.deepEqual(await runIndexWorker(corruptDir), { ok: false, error: 'codex-index-invalid' });

  // 3. Busy lock (exclusive write transaction)
  const busyDir = join(dir, 'busy');
  await mkdir(busyDir);
  const busyDb = new DatabaseSync(join(busyDir, 'state_5.sqlite'));
  busyDb.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,rollout_path TEXT,source TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,model_provider TEXT,archived INTEGER); INSERT INTO threads VALUES ('1','T','/tmp/x','vscode','/tmp',1,1,'openai',0)");
  busyDb.exec("BEGIN EXCLUSIVE; INSERT INTO threads VALUES ('2','T2','/tmp/y','vscode','/tmp',1,2,'openai',0)");
  try {
    await assert.rejects(readCodexSavedMetadata(busyDir, CHILD), { code: 'codex-history-index-busy' });
    assert.deepEqual(await runIndexWorker(busyDir), { ok: false, error: 'codex-index-busy' });
  } finally {
    busyDb.exec('ROLLBACK');
    busyDb.close();
  }

  // 4. WAL-mode DB without -wal in uncheckpointed / read-only directory -> missing-WAL
  const srcWalDir = join(dir, 'src-wal');
  const roWalDir = join(dir, 'ro-wal');
  await mkdir(srcWalDir);
  await mkdir(roWalDir);
  const walDb = new DatabaseSync(join(srcWalDir, 'state_5.sqlite'));
  walDb.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,rollout_path TEXT,source TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,model_provider TEXT,archived INTEGER); INSERT INTO threads VALUES ('1','T','/tmp/x','vscode','/tmp',1,1,'openai',0)");
  await copyFile(join(srcWalDir, 'state_5.sqlite'), join(roWalDir, 'state_5.sqlite'));
  walDb.close();
  await chmod(roWalDir, 0o555);
  try {
    await assert.rejects(readCodexSavedMetadata(roWalDir, CHILD), { code: 'codex-history-index-wal-missing' });
    assert.deepEqual(await runIndexWorker(roWalDir), { ok: false, error: 'codex-index-wal-missing' });
  } finally {
    await chmod(roWalDir, 0o755);
  }
});
