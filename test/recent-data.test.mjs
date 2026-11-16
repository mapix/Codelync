import test from 'node:test';
import assert from 'node:assert/strict';
import { recentCatalogPage, recentDescriptor, recentRowsPage, CodeLightRecentService } from '../src/happy/recent-data.mjs';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** @typedef {Record<string,any>} Value */
const NOW = 80 * 60 * 60 * 1000;
/** @param {string} id @param {number} updatedAt */
function entry(id, updatedAt) { return { source: { app: 'codex', id: `native-${id}`, title: id, updatedAt, createdAt: 1, workspace: '/fixture', preview: 'heavy preview', project: { key: 'project', path: '/fixture', label: 'Fixture' } },
  binding: { happySessionId: id, sessionKey: 'private-selected-key', machineId: 'machine', metadataVersion: 4, metadata: { client: { id: 'noninvasive-bridge' }, bridge: { source: { app: 'codex', id: `native-${id}` }, sourceKey: id }, nativeSession: { preview: 'cached preview' }, nativeControls: { privateHeavy: true }, updatedAt: NOW } } }; }

test('catalog recency uses native time, publishes recent entries first and strips old bodies/state/keys', () => {
  const old = entry('old', NOW - 73 * 60 * 60 * 1000), recent = entry('recent', NOW - 1000), edge = entry('edge', NOW - 72 * 60 * 60 * 1000);
  const page = recentCatalogPage([old, edge, recent], { now: NOW });
  assert.deepEqual(page.sessions.map(row => row.id), ['recent', 'edge', 'old']);
  assert.equal(page.sessions[2].basicOnly, true); assert.equal(page.sessions[1].basicOnly, false);
  assert.equal(page.sessions[2].updatedAt, old.source.updatedAt);
  assert.equal(page.sessions[2].metadata.nativeSession.preview, undefined); assert.equal(page.sessions[2].metadata.nativeControls, undefined);
  assert.equal(page.sessions[2].agentState, null); assert.equal(page.sessions.some(row => row.sessionKey), false);
  assert.equal(recentDescriptor(old, NOW, true).sessionKey, old.binding.sessionKey);
});

test('catalog exclusive native-time cursor handles tied rows and newly promoted entries without repeating', () => {
  const rows = [entry('a', 10), entry('b', 10), entry('c', 11)];
  const first = recentCatalogPage(rows, { now: NOW, limit: 2 });
  assert.deepEqual(first.sessions.map(row => row.id), ['c', 'b']);
  rows[0].source.updatedAt = 20;
  const second = recentCatalogPage(rows, { now: NOW, limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.sessions, []); // Promoted A is included by the next fresh catalog, never inserted below older B.
  assert.throws(() => recentCatalogPage(rows, { limit: 2001 }));
});

test('latest native rows are complete, tools retain seeds and earlier cursor is session-bound', () => {
  const rows = Array.from({ length: 125 }, (_, index) => ({ id: `row-${index}`, role: 'assistant', turnId: 'original-turn', text: `complete-${index}` }));
  rows[124] = /** @type {any} */ ({ id: 'tool', role: 'tool', turnId: 'original-turn', text: '', tools: [{ id: 'original-call', name: 'fixture', output: 'full-result', status: 'completed' }] });
  const latest = recentRowsPage('mirror-id', rows);
  assert.equal(latest.rows.length, 50); assert.equal(latest.rows[0].text, 'complete-75');
  assert.equal(latest.rows.at(-1)?.tools[0].output, 'full-result');
  const older = recentRowsPage('mirror-id', rows, { cursor: latest.nextCursor });
  assert.equal(older.rows[0].id, 'row-25'); assert.equal(older.rows.at(-1)?.id, 'row-74');
  assert.throws(() => recentRowsPage('other-mirror', rows, { cursor: latest.nextCursor }), /does not match/);
  assert.throws(() => recentRowsPage('mirror-id', rows.slice(76), { cursor: latest.nextCursor }), /no longer present/);
});
test('explicit native incompleteness keeps a history cursor even at the loaded start without claiming completeness on unknown', () => {
  const rows = [{ id: 'latest', role: 'assistant', turnId: 'current', text: 'complete current row' }];
  assert.equal(recentRowsPage('session', rows, { historyComplete: false }).hasMore, true);
  assert.ok(recentRowsPage('session', [], { historyComplete: false }).nextCursor);
  assert.equal(recentRowsPage('session', rows).hasMore, false);
});

test('concurrent recent requests share one source activation/fresh read and expose selected key only after completion', async () => {
  let resolveCalls = 0, reads = 0, complete;
  const gate = new Promise(resolve => { complete = resolve; });
  const selected = entry('selected', NOW);
  const service = new CodeLightRecentService({ sources: () => [selected], now: () => NOW,
    resolveSource: async id => { resolveCalls++; assert.equal(id, 'selected'); await gate; return { ...selected, actor: { connector: { readRecent: async (/** @type {Record<string,any>} */ options) => { reads++; assert.equal(options.fresh, true); return { rows: [{ id: 'full', text: 'current' }] }; } } } }; } });
  const one = service.recent('selected'), two = service.recent('selected');
  await Promise.resolve(); assert.equal(resolveCalls, 1); assert.equal(reads, 0);
  /** @type {any} */ (complete)();
  const [first, second] = await Promise.all([one, two]);
  assert.equal(reads, 1); assert.equal(first.session.sessionKey, selected.binding.sessionKey);
  first.rows[0].text = 'consumer-edit'; assert.equal(second.rows[0].text, 'current');
});

test('failed freshness and unavailable directory never publish cached success or invented empty state', async () => {
  const service = new CodeLightRecentService({ sources: () => [], available: () => false, resolveSource: async () => { throw Error('must not activate'); } });
  assert.throws(() => service.catalog(), /unavailable/);
  assert.throws(() => service.recent('missing'), /unavailable/);
  const failure = new CodeLightRecentService({ sources: () => [], resolveSource: async () => { throw Error('fresh owner unavailable'); } });
  await assert.rejects(failure.recent('missing'), /fresh owner unavailable/); assert.equal(failure.flights.size, 0);
  assert.throws(() => failure.history('missing', {}), /cursor is required/);
});

test('the real read-only index worker orders native millisecond recency and omits old previews', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-recent-index-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT,title TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,updated_at_ms INTEGER,recency_at_ms INTEGER,model_provider TEXT,archived INTEGER,first_user_message TEXT)');
  const write = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?)');
  write.run('old', 'Old title', '/fixture', 1, 999999, NOW - 73 * 60 * 60 * 1000, 0, 'fixture', 0, 'must not appear');
  write.run('recent', 'Recent title', '/fixture', 1, 1, NOW - 2000, NOW - 1000, 'fixture', 0, 'recent preview'); db.close();
  const rows = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../src/happy/codex-index-worker.mjs', import.meta.url), { execArgv: [], workerData: { root: directory, offset: 0, now: NOW } });
    worker.once('message', value => value.ok ? resolve(value.rows) : reject(Error('worker failed'))); worker.once('error', reject);
  });
  assert.deepEqual(/** @type {any[]} */ (rows).map(row => row.id), ['recent', 'old']);
  assert.equal(/** @type {any[]} */ (rows)[0].preview, 'recent preview');
  assert.equal(/** @type {any[]} */ (rows)[1].preview, '');
});

test('cache-first returns readonly data before activation and shares its pinned revalidation with a fresh reader', async () => {
  const selected = /** @type {{source:Value,binding:Value}} */ (entry('cached', NOW)), source = /** @type {Value} */ ({ ...selected.source, hostId: 'local', runtimeGeneration: 'owner', kind: 'session' });
  selected.source = source;
  selected.binding.metadata.bridge.source = source;
  selected.binding.metadata.capabilities = { readOnly: false, send: true, abort: true, modelSelection: true, rpcMethods: ['abort', 'codex-controls-update'] };
  const state = { requests: [{ requestId: 'original-request' }], nativeInput: { available: true, ownerGeneration: 'owner' },
    nativeQuery: { ownerGeneration: 'owner', queryToken: 'original-query', status: 'running', canSend: true, canCancel: true },
    aggregateActivity: { version: 1, app: 'codex', parentConversationId: source.id, hostId: 'local', ownerGeneration: 'owner', ownStatus: 'running', ownKnown: true,
      known: true, active: true, waiting: false, status: 'running', rosterAvailable: true, rosterComplete: true, childCount: 1, unknownChildren: 0, digest: 'original' },
    subagents: [{ nativeConversationId: 'native-child', status: 'running' }], subagentsAvailable: true, subagentsComplete: true };
  const original = JSON.stringify(selected.binding.metadata), originalState = JSON.stringify(state);
  let resolveCalls = 0, nativeReads = 0, pins = 0, release = () => {};
  const gate = new Promise(resolve => { release = () => resolve(undefined); });
  const cached = { rows: [{ id: 'cached-row', turnId: 'original-turn', text: 'cached complete body', ownerGeneration: 'owner' }], ownerGeneration: 'owner', status: 'unknown', currentTurnId: null,
    hasMore: true, nextCursor: null, freshness: { version: 1, mode: 'cached', capturedAt: NOW - 100, ownerGeneration: 'owner', currentControlAuthority: false, revalidationPending: true } };
  const actor = { transport: { peerSnapshot: () => ({ metadata: selected.binding.metadata, agentState: state }) }, status: () => ({ sourceStatus: 'connected' }),
    connector: { readCachedRecent: async () => structuredClone(cached), readRecent: async (/** @type {Value} */ options) => { nativeReads++; assert.equal(options.fresh, true); return { rows: [{ id: 'fresh-row', text: 'revalidated body' }], ownerGeneration: 'owner', status: 'idle', freshness: { mode: 'fresh' } }; } } };
  const service = new CodeLightRecentService({ sources: () => [{ ...selected, actor }], now: () => NOW,
    retainSource: async (_id, execute) => { pins++; try { return await execute(); } finally { pins--; } },
    resolveSource: async () => { resolveCalls++; await gate; return { ...selected, actor }; } });
  const warm = await service.recent('cached', { limit: 1, readPolicy: 'cache-first' });
  assert.equal(warm.rows[0].text, 'cached complete body'); assert.equal(warm.freshness.mode, 'cached');
  assert.equal(warm.session.metadata.capabilities.readOnly, true); assert.equal(warm.session.metadata.capabilities.abort, false);
  assert.deepEqual(warm.session.metadata.capabilities.rpcMethods, ['bridge-receipt']); assert.equal(warm.session.metadata.nativeControls, undefined);
  assert.equal(warm.session.agentState.nativeQuery, undefined); assert.equal(warm.session.agentState.nativeInput.available, false);
  assert.equal(warm.session.agentState.aggregateActivity.known, false); assert.equal(warm.session.agentState.aggregateActivity.status, 'unknown');
  assert.equal(warm.session.agentState.subagents, undefined); assert.equal(warm.session.agentState.requests[0].requestId, 'original-request');
  assert.equal(JSON.stringify(selected.binding.metadata), original); assert.equal(JSON.stringify(state), originalState);
  await Promise.resolve(); assert.equal(pins, 1); assert.equal(resolveCalls, 1); assert.equal(nativeReads, 0);
  const fresh = service.recent('cached', { limit: 1 }); assert.equal(resolveCalls, 1);
  release(); const confirmed = await fresh; assert.equal(confirmed.rows[0].text, 'revalidated body'); assert.equal(nativeReads, 1);
  await Promise.all(service.revalidations.values()); assert.equal(pins, 0); assert.equal(service.revalidations.size, 0);
});

test('cache-first falls back to fresh for cold/missing/foreign-owner caches and rejects history policies', async () => {
  for (const cache of [null, { rows: [{ ownerGeneration: 'foreign' }], ownerGeneration: 'owner', freshness: { mode: 'cached', ownerGeneration: 'owner', currentControlAuthority: false } }]) {
    const selected = entry('cold', NOW); let reads = 0;
    const actor = { connector: { readCachedRecent: async () => cache, readRecent: async (/** @type {Value} */ options) => { reads++; assert.equal(options.fresh, true); return { rows: [{ id: 'current', text: 'fresh' }] }; } } };
    const service = new CodeLightRecentService({ sources: () => [{ ...selected, actor }], resolveSource: async () => ({ ...selected, actor }), now: () => NOW });
    const value = await service.recent('cold', { readPolicy: 'cache-first', limit: 1 }); assert.equal(value.rows[0].text, 'fresh'); assert.equal(reads, 1);
    assert.throws(() => service.recent('cold', { readPolicy: 'foreign' }), { code: 'invalid-recent-policy' });
    assert.throws(() => service.recent('cold', { readPolicy: 'cache-first', cursor: 'history' }), { code: 'invalid-recent-policy' });
  }
});

test('failed background revalidation preserves readonly cached text without turning failure into fresh success', async () => {
  const selected = /** @type {{source:Value,binding:Value}} */ (entry('unconfirmed-cache', NOW)); selected.source.hostId = 'local';
  selected.binding.metadata.bridge.source = { ...selected.source, runtimeGeneration: 'owner' };
  const actor = { transport: { peerSnapshot: () => ({ metadata: selected.binding.metadata }) },
    connector: { readCachedRecent: async () => ({ rows: [{ id: 'retained', text: 'retained text', ownerGeneration: 'owner' }], ownerGeneration: 'owner', status: 'unknown',
      freshness: { version: 1, mode: 'cached', capturedAt: NOW - 100, ownerGeneration: 'owner', currentControlAuthority: false, revalidationPending: true } }), readRecent: async () => { throw Error('Original native read failed'); } } };
  const service = new CodeLightRecentService({ sources: () => [{ ...selected, actor }], resolveSource: async () => ({ ...selected, actor }), now: () => NOW });
  const cached = await service.recent('unconfirmed-cache', { readPolicy: 'cache-first' }); assert.equal(cached.rows[0].text, 'retained text'); assert.equal(cached.freshness.mode, 'cached');
  await Promise.all(service.revalidations.values()); assert.equal(service.revalidations.size, 0); assert.equal(cached.session.metadata.capabilities.readOnly, true);
  await assert.rejects(service.recent('unconfirmed-cache'), /Original native read failed/);
});
