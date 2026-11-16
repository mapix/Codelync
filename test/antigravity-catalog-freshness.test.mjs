import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityBackend } from '../src/adapters/antigravity-backend.mjs';
import { antigravityCatalogueSemanticStamp } from '../src/adapters/antigravity-history.mjs';

/** @typedef {Record<string,any>} Value */
function fixture() {
  let now = 1000, archivedSearch = false, hold = false;
  let release = () => {}, entered = () => {};
  let started = Promise.resolve();
  const calls = /** @type {string[]} */ ([]), summaries = /** @type {Value} */ ({ root: {}, child: { trajectoryMetadata: { parentConversationId: 'root' } }, nested: { trajectoryMetadata: { parentConversationId: 'child' } } });
  const rpc = { latestRuntime: { binary: '/fixture/Antigravity.app/Contents/Resources/bin/language_server', home: '/fixture/home', appDataDir: 'antigravity' }, generation: () => 'owner', dispose: async () => {},
    call: async (/** @type {string} */ method, /** @type {Value} */ body = {}) => {
      calls.push(method);
      if (method === 'GetAllCascadeTrajectories') {
        if (hold) { hold = false; entered(); await new Promise(resolve => { release = () => resolve(undefined); }); }
        return { trajectorySummaries: structuredClone(summaries) };
      }
      if (method === 'SearchConversations') return { results: archivedSearch && body.filters.archivedOnly ? [{ cascadeId: 'root', archived: true }] : [] };
      throw Error('The directory must not read conversation steps or mutate a native session.');
    } };
  const backend = new AntigravityBackend({ rpc, now: () => now });
  return { backend, summaries, calls, setNow: (/** @type {number} */ value) => { now = value; }, archiveSearch: () => { archivedSearch = true; },
    holdNext: () => { hold = true; started = new Promise(resolve => { entered = () => resolve(); }); }, started: () => started, release: () => release() };
}

test('a status-only native header change invalidates the cached directory without a recency change', async () => {
  const f = fixture();
  try {
    const first = await f.backend.list({ fresh: true }); assert.equal(first.find(row => row.id === 'child')?.isSubagent, false);
    const stamp = f.backend.catalogueStamp;
    f.setNow(1100); f.summaries.child.trajectoryMetadata.subagentSpec = { role: 'Coordinator', typeName: 'Worker' };
    await f.backend.list({ fresh: true, history: false });
    const current = await f.backend.list(); assert.equal(current.find(row => row.id === 'child')?.isSubagent, true);
    assert.notEqual(f.backend.catalogueStamp, stamp);
    assert.equal(f.calls.filter(method => method === 'SearchConversations').length, 2);
  } finally { await f.backend.dispose(); }
});

test('a fresh directory waiting on a status read hides the whole newly archived ancestor tree', async () => {
  const f = fixture();
  try {
    assert.equal((await f.backend.list({ fresh: true })).length, 3);
    f.setNow(2100); f.summaries.root.annotations = { archived: true }; f.holdNext();
    const status = f.backend.list({ fresh: true, history: false }); await f.started();
    const directory = f.backend.list({ fresh: true }); f.release(); await status;
    assert.deepEqual(await directory, []);
    assert.deepEqual(f.backend.excludedSources.map(row => row.id).sort(), ['child', 'nested', 'root']);
  } finally { await f.backend.dispose(); }
});

test('resident polling cannot renew an expired durable search snapshot with unchanged resident metadata', async () => {
  const f = fixture();
  try {
    assert.equal((await f.backend.list({ fresh: true })).length, 3);
    const stamp = f.backend.indexSemanticStamp;
    f.setNow(22000); f.archiveSearch(); f.holdNext();
    const status = f.backend.list({ fresh: true, history: false }); await f.started();
    const directory = f.backend.list({ fresh: true }); f.release(); await status;
    assert.equal(f.backend.indexSemanticStamp, stamp);
    assert.deepEqual(await directory, []);
    assert.equal(f.calls.filter(method => method === 'SearchConversations').length, 4);
  } finally { await f.backend.dispose(); }
});

test('catalogue semantic stamps cover original identity/spec, parent/fork, archive and pin fields', () => {
  const original = { child: { lastModifiedTime: 'unchanged', trajectoryMetadata: { parentConversationId: 'parent' } } };
  const before = antigravityCatalogueSemanticStamp(original, 'scope');
  for (const patch of [{ source: 16 }, { trajectoryMetadata: { parentConversationId: 'other' } }, { forkParentConversationId: 'fork' },
    { trajectoryMetadata: { parentConversationId: 'parent', subagentSpec: { typeName: 'Worker', role: 'Coordinator' } } },
    { annotations: { archived: true } }, { annotations: { starred: true } }]) {
    assert.notEqual(antigravityCatalogueSemanticStamp({ child: { ...original.child, ...patch } }, 'scope'), before);
  }
});
