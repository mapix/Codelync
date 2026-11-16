import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityHistoryCatalog, pageAntigravityHistory } from '../src/adapters/antigravity-history.mjs';
import { AntigravityBackend } from '../src/adapters/antigravity-backend.mjs';
import { LocalSourceDiscovery } from '../src/happy/discovery.mjs';

/** @typedef {Record<string,any>} Value */
const runtime = { binary: '/fixture/Antigravity.app/Contents/Resources/bin/language_server', home: '/fixture/home', appDataDir: 'antigravity' };
const scope = { generation: 'native-owner-one', hostId: 'local:antigravity:' + 'a'.repeat(64) };
const normal = [{ cascadeId: 'durable-one', title: 'Native saved history', lastModifiedTime: '2026-11-13T01:00:00Z', needsAttention: true }];
const archived = [{ cascadeId: 'archived-one', title: 'Archived native history', archived: true, lastModifiedTime: '2026-11-12T01:00:00Z' }];

/** @returns {Value} */
function fixture() {
  const calls = /** @type {Value[]} */ ([]);
  let stale = false, full = false, badMetadata = false, residents = /** @type {Value} */ ({}), results = /** @type {Value[]} */ (normal);
  const rpc = { latestRuntime: runtime, generation: () => scope.generation, dispose: async () => {},
    call: async (/** @type {string} */ method, /** @type {Value} */ body = {}) => {
      calls.push({ method, body });
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: residents };
      if (method === 'SearchConversations') return { results: body.filters.archivedOnly ? archived : results, indexStale: stale, diskFull: full };
      if (method === 'GetConversationMetadata') return badMetadata ? {} : { trajectoryId: 'trajectory-' + body.conversationId, numSteps: 5,
        metadata: { workspaces: [{ workspaceFolderAbsoluteUri: 'file:///fixture/saved-project' }], parentConversationId: 'native-parent', createdAt: '2026-11-11T01:00:00Z' } };
      throw Error('History discovery must not read conversation steps or start a runner.');
    } };
  return { rpc, calls, stale: () => { stale = true; }, diskFull: () => { full = true; }, badMetadata: () => { badMetadata = true; },
    residents: (/** @type {Value} */ value) => { residents = value; }, results: (/** @type {Value[]} */ value) => { results = value; } };
}

test('saved native IDs survive empty resident state while archives are exclusion evidence without metadata hydration', async () => {
  const f = fixture(), history = new AntigravityHistoryCatalog({ rpc: f.rpc });
  const merged = await history.merge({}, scope);
  assert.equal(merged.complete, true); assert.equal(merged.indexedCount, 1);
  assert.equal(merged.summaries['durable-one'].trajectoryMetadata.parentConversationId, 'native-parent');
  assert.equal(merged.summaries['archived-one'].annotations.archived, true);
  assert.deepEqual(merged.archivedIds, ['archived-one']);
  assert.deepEqual(f.calls.filter((/** @type {Value} */ c) => c.method === 'GetConversationMetadata').map((/** @type {Value} */ c) => c.body.conversationId), ['durable-one']);
  assert.equal(merged.summaries['durable-one'].status, undefined);
  assert.deepEqual(f.calls.filter((/** @type {Value} */ c) => c.method === 'SearchConversations').map((/** @type {Value} */ c) => c.body.filters.archivedOnly), [false, true]);
  assert.ok(f.calls.every((/** @type {Value} */ c) => ['SearchConversations', 'GetConversationMetadata'].includes(c.method)));
  const count = f.calls.length;
  await history.merge({}, scope); assert.equal(f.calls.length, count);
  await history.merge({}, { ...scope, generation: 'restarted-owner' });
  assert.equal(f.calls.filter((/** @type {Value} */ c) => c.method === 'SearchConversations').length, 4, 'A restarted owner confirms native index identity again.');
});

test('namespace changes do not borrow saved metadata for equal conversation IDs', async () => {
  const f = fixture(), history = new AntigravityHistoryCatalog({ rpc: f.rpc });
  await history.merge({}, scope);
  const before = f.calls.filter((/** @type {Value} */ c) => c.method === 'GetConversationMetadata').length;
  await history.merge({}, { ...scope, hostId: 'local:antigravity:' + 'b'.repeat(64) });
  assert.equal(f.calls.filter((/** @type {Value} */ c) => c.method === 'GetConversationMetadata').length, before + 1);
});

test('stale or disk-full native indices are explicit failures and cannot supply removal evidence', async () => {
  for (const reason of ['stale', 'diskFull']) {
    const f = fixture(), history = new AntigravityHistoryCatalog({ rpc: f.rpc });
    await history.merge({}, scope); f[reason]();
    await assert.rejects(history.merge({}, { ...scope, force: true }), { code: 'antigravity-history-index-unavailable' });
    await assert.rejects(history.merge({}, scope), { code: 'antigravity-history-index-unavailable' });
  }
});

test('saturated prefixes and unconfirmed metadata are incomplete and never invent a source', async () => {
  const f = fixture(), bounded = new AntigravityHistoryCatalog({ rpc: f.rpc, limit: 1 });
  assert.equal((await bounded.merge({}, scope)).complete, false);
  const bad = fixture(); bad.badMetadata();
  const result = await new AntigravityHistoryCatalog({ rpc: bad.rpc }).merge({}, scope);
  assert.equal(result.complete, false); assert.equal(result.summaries['durable-one'], undefined);
  assert.equal(result.summaries['archived-one'].annotations.archived, true);
});

test('metadata read budget progresses without reloading already-confirmed metadata', async () => {
  const f = fixture(), history = new AntigravityHistoryCatalog({ rpc: f.rpc, maxMetadataReads: 1 });
  f.results([...normal, { cascadeId: 'durable-two', title: 'Second saved history', lastModifiedTime: '2026-11-13T01:00:00Z' }]);
  const first = await history.merge({}, scope); assert.equal(first.complete, false); assert.equal(first.indexedCount, 2);
  const second = await history.merge({}, { ...scope, force: true }); assert.equal(second.complete, true); assert.ok(second.summaries['durable-one']); assert.ok(second.summaries['durable-two']);
  assert.equal(f.calls.filter((/** @type {Value} */ c) => c.method === 'GetConversationMetadata').length, 2);
});

test('backend merges native saved history while activity remains unknown rather than inferred from snippets', async () => {
  const f = fixture(), backend = new AntigravityBackend({ rpc: f.rpc });
  try {
    const sources = await backend.list({ fresh: true }); assert.equal(sources.length, 1);
    const source = sources.find(s => s.id === 'durable-one'); assert.ok(source);
    assert.equal(source.workspace, '/fixture/saved-project'); assert.equal(source.parentId, 'native-parent');
    const queries = f.calls.filter((/** @type {Value} */ c) => c.method === 'SearchConversations').length;
    assert.equal(backend.excludedSources[0].id, 'archived-one');
    await backend.list({ fresh: true });
    assert.equal(f.calls.filter((/** @type {Value} */ c) => c.method === 'SearchConversations').length, queries, 'Fresh resident reads retain the durable index read budget.');
    const activity = await backend.activity('durable-one'); assert.equal(activity.known, false); assert.equal(activity.status, 'unavailable');
    assert.equal(f.calls.filter((/** @type {Value} */ c) => c.method === 'SearchConversations').length, queries);
    f.stale();
    await assert.rejects(backend.list({ fresh: true, forceHistory: true }), { code: 'antigravity-history-index-unavailable' });
    assert.equal(backend.inventoryComplete, false);
  } finally { await backend.dispose(); }
});

test('incomplete history can add verified sources without making discovery absence authoritative', async () => {
  const f = fixture(), backend = new AntigravityBackend({ rpc: f.rpc, historyIndex: new AntigravityHistoryCatalog({ rpc: f.rpc, limit: 1 }) });
  const discovery = new LocalSourceDiscovery({ storage: { list: async () => [] }, codexBackend: /** @type {any} */ ({ dispose: async () => {} }), antigravityBackend: backend });
  try { const result = await discovery.discover(); assert.equal(result.sources.length, 1); assert.equal(result.hiddenSources.length, 1); assert.deepEqual(result.errors, ['antigravity-index-unavailable']); }
  finally { await discovery.close(); }
});

test('catalogue paging rejects a stale stamp and maintains bounded contiguous offsets', () => {
  const sources = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
  const first = pageAntigravityHistory(sources, { limit: 2 }, 'native-catalogue-stamp');
  assert.deepEqual(first.sources.map(s => s.id), ['one', 'two']); assert.equal(first.nextOffset, 2);
  assert.deepEqual(pageAntigravityHistory(sources, { offset: first.nextOffset, limit: 2, stamp: first.stamp }, first.stamp).sources.map(s => s.id), ['three']);
  assert.throws(() => pageAntigravityHistory(sources, { stamp: 'another-namespace-stamp' }, first.stamp), { code: 'stale-history-page' });
  assert.throws(() => pageAntigravityHistory(sources, { offset: 2 }, first.stamp), { code: 'stale-history-page' });
  assert.throws(() => pageAntigravityHistory(sources, { limit: 201 }, first.stamp), { code: 'stale-history-page' });
});
