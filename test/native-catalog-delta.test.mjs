import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeCatalogDeltas, CodelyncRecentService } from '../src/codelync/recent-data.mjs';

/** @param {string} id @param {number} [version] */
function entry(id, version = 1) {
  const source = { app: 'codex', id: 'native-' + id, hostId: 'local', workspace: '/fixture/project', updatedAt: 100, title: 'Source ' + id };
  return { source, binding: { happySessionId: id, metadataVersion: version, machineId: 'machine',
    metadata: { machineId: 'machine', client: { id: 'noninvasive-bridge' }, bridge: { source, controlMode: 'session' }, nativeSession: { catalogueAvailable: true } } } };
}

test('unchanged native directory returns empty delta under the original source/version watermark', () => {
  const service = new NativeCatalogDeltas(), entries = [entry('a'), entry('b')];
  const full = service.page(entries, {}, 'machine');
  assert.equal(full.mode, 'full'); assert.equal(full.sessions.length, 2);
  const delta = service.page(entries, { since: full.watermark }, 'machine');
  assert.equal(delta.mode, 'delta'); assert.equal(delta.watermark, full.watermark);
  assert.deepEqual(delta.sessions, []); assert.deepEqual(delta.removedIds, []);
  assert.ok(Buffer.byteLength(JSON.stringify(delta)) < 350);
});

test('metadata changes and archive removal send only one changed descriptor and explicit removed ID', () => {
  const service = new NativeCatalogDeltas(), entries = [entry('a'), entry('b')];
  const full = service.page(entries, {}, 'machine');
  entries[0].binding.metadataVersion++;
  entries[1].binding.metadata.nativeSession.catalogueAvailable = false;
  const delta = service.page(entries, { since: full.watermark }, 'machine');
  assert.deepEqual(delta.sessions.map((/** @type {Record<string,any>} */ row) => row.id), ['a']); assert.deepEqual(delta.removedIds, ['b']);
});

test('native identity and archive changes enter a directory delta without message recency or metadata version changes', () => {
  const service = new NativeCatalogDeltas(), entries = [entry('a'), entry('b')];
  const full = service.page(entries, {}, 'machine');
  Object.assign(entries[0].source, { isSubagent: true, parentId: 'native-b', agentName: 'Coordinator' });
  Object.assign(entries[1].source, { archived: true });
  const delta = service.page(entries, { since: full.watermark }, 'machine');
  assert.deepEqual(delta.removedIds, ['b']); assert.equal(delta.sessions.length, 1);
  assert.equal(delta.sessions[0].metadata.nativeSession.isSubagent, true);
  assert.equal(delta.sessions[0].metadata.nativeSession.parentId, 'native-b');
  assert.equal(delta.sessions[0].metadataVersion, 1); assert.equal(delta.sessions[0].nativeUpdatedAt, 100);
});

test('pagination continues a materialized snapshot and service restart or expired cursor cannot borrow its state', () => {
  let now = 1000;
  const service = new NativeCatalogDeltas({ now: () => now, ttlMs: 1000 }), entries = [entry('a'), entry('b'), entry('c')];
  const first = service.page(entries, { limit: 1, since: 'unknown-watermark' }, 'machine');
  entries[1].source.title = 'Changed after snapshot';
  const next = service.page(entries, { limit: 2, since: 'unknown-watermark', cursor: first.nextCursor }, 'machine');
  assert.equal(next.watermark, first.watermark); assert.equal(next.sessions.find((/** @type {Record<string,any>} */ row) => row.id === 'b')?.metadata.nativeSession.title, 'Source b');
  assert.equal(new NativeCatalogDeltas().page(entries, { since: first.watermark }, 'machine').mode, 'full');
  now += 1000;
  assert.throws(() => service.page(entries, { cursor: first.nextCursor, since: 'unknown-watermark' }, 'machine'), { code: 'stale-catalog-cursor' });
});

test('directories above 2000 rows retain all 10000 supported headers before paginated comparison', () => {
  const service = new NativeCatalogDeltas(), entries = Array.from({ length: 10000 }, (_, at) => entry('row-' + String(at).padStart(5, '0')));
  const first = service.page(entries, { limit: 2000 }, 'machine'), ids = first.sessions.map((/** @type {Record<string,any>} */ row) => row.id);
  let cursor = first.nextCursor;
  while (cursor) { const page = service.page(entries, { limit: 2000, cursor }, 'machine'); ids.push(...page.sessions.map((/** @type {Record<string,any>} */ row) => row.id)); cursor = page.nextCursor; }
  assert.equal(ids.length, 10000); assert.equal(new Set(ids).size, 10000);
  const delta = service.page(entries, { since: first.watermark }, 'machine'); assert.deepEqual(delta.sessions, []); assert.deepEqual(delta.removedIds, []);
});

test('empty catalogs invalidate a foreign machine watermark instead of retaining its scope', () => {
  const service = new NativeCatalogDeltas();
  const first = service.page([], {}, 'machine-a');
  const next = service.page([], { since: first.watermark }, 'machine-b');
  assert.equal(next.mode, 'full'); assert.equal(next.baseWatermark, null);
  assert.notEqual(next.watermark, first.watermark); assert.deepEqual(next.machineIds, ['machine-b']);
  const unchanged = service.page([], { since: next.watermark }, 'machine-b');
  assert.equal(unchanged.mode, 'delta'); assert.equal(unchanged.watermark, next.watermark);
});

test('materialized directory continuation cannot cross its emitting machine scope', () => {
  const service = new NativeCatalogDeltas(), entries = [entry('a'), entry('b')];
  const first = service.page(entries, { limit: 1 }, 'machine-a');
  assert.throws(() => service.page(entries, { cursor: first.nextCursor }, 'machine-b'), { code: 'stale-catalog-cursor' });
  const next = service.page(entries, { cursor: first.nextCursor }, 'machine-a');
  assert.equal(next.watermark, first.watermark);
  assert.deepEqual(new Set([...first.sessions, ...next.sessions].map(row => row.id)), new Set(['a', 'b']));
  assert.equal(next.sessions.some((/** @type {Record<string,any>} */ row) => row.id === first.sessions[0].id), false);
});

test('hot unchanged watermarks survive cold scans with bounded least-recently-used retention', () => {
  let now = 1000;
  const service = new NativeCatalogDeltas({ now: () => now, maxSnapshots: 2 }), entries = [entry('a'), entry('b')];
  const active = service.page(entries, { limit: 1 }, 'machine');
  now++; const cold = service.page(entries, { limit: 1 }, 'machine');
  now++; service.page(entries, { since: active.watermark }, 'machine');
  now++; service.page(entries, { limit: 1 }, 'machine');
  const delta = service.page(entries, { since: active.watermark }, 'machine');
  assert.equal(delta.mode, 'delta'); assert.equal(delta.watermark, active.watermark); assert.deepEqual(delta.sessions, []);
  assert.ok(Buffer.byteLength(JSON.stringify(delta)) < 350);
  assert.equal(service.snapshots.size, 2);
  assert.throws(() => service.page(entries, { cursor: cold.nextCursor }, 'machine'), { code: 'stale-catalog-cursor' });
});

test('pagination capture time stays immutable while active access extends retention', () => {
  let now = 1000;
  const service = new NativeCatalogDeltas({ now: () => now, ttlMs: 1000 }), entries = [entry('a'), entry('b')];
  const first = service.page(entries, { limit: 1 }, 'machine');
  now += 900;
  const delta = service.page(entries, { since: first.watermark }, 'machine');
  assert.equal(delta.scannedAt, now);
  now += 900;
  const next = service.page(entries, { cursor: first.nextCursor }, 'machine');
  assert.equal(next.watermark, first.watermark); assert.equal(next.scannedAt, first.scannedAt);
  now += 1000;
  assert.throws(() => service.page(entries, { cursor: first.nextCursor }, 'machine'), { code: 'stale-catalog-cursor' });
});

test('Mac maintains headers before phone arrival and HTTP pages never read source checkpoints', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 1000, sourceReads = 0, checkpoints = 0;
  const entries = Array.from({ length: 1500 }, (_, at) => ({ ...entry(String(at).padStart(4, '0')),
    actor: { transport: { peerSnapshot() { checkpoints++; return {}; } } } }));
  const service = new CodelyncRecentService({ sources: () => { sourceReads++; return entries; }, resolveSource: async () => { throw Error('No native reads'); },
    machineId: () => 'machine', catalogRefreshMs: 5000, now: () => now });
  t.after(() => service.close());
  assert.throws(() => service.catalog({ catalogVersion: 2 }), { code: 'source-unavailable' });
  service.startCatalogMaintenance(); assert.equal(sourceReads, 1); assert.equal(checkpoints, 1500);
  const first = service.catalog({ catalogVersion: 2, limit: 2000 });
  assert.equal(first.sessions.length, 1500); assert.equal(first.scannedAt, 1000);
  for (let i = 0; i < 5; i++) assert.deepEqual(service.catalog({ catalogVersion: 2, since: first.watermark }).sessions, []);
  const legacy = service.catalog({ limit: 1000 });
  assert.equal(legacy.sessions.length, 1000); assert.equal(service.catalog({ cursor: legacy.nextCursor }).sessions.length, 500);
  assert.equal(sourceReads, 1); assert.equal(checkpoints, 1500);
  entries[0].source.title = 'Updated independently'; entries[0].binding.metadataVersion++;
  now += 5000; t.mock.timers.tick(5000);
  assert.equal(sourceReads, 2); assert.equal(checkpoints, 3000);
  const delta = service.catalog({ catalogVersion: 2, since: first.watermark });
  assert.equal(delta.sessions.length, 1); assert.equal(delta.sessions[0].metadata.nativeSession.title, 'Updated independently');
  console.log(JSON.stringify({ fixtureOnly: true, maintainedHeaders: 1500, HTTPReadCheckpointCalls: 0, backgroundCaptureIntervalMs: 5000 }));
});

test('failed background directory capture retains its original time and closes maintenance cleanly', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 1000, available = true, reads = 0;
  const service = new CodelyncRecentService({ sources: () => { reads++; return [entry('a')]; }, resolveSource: async () => { throw Error('No native reads'); },
    available: () => available, machineId: () => 'machine', catalogRefreshMs: 5000, now: () => now });
  t.after(() => service.close()); service.startCatalogMaintenance();
  const first = service.catalog({ catalogVersion: 2 });
  available = false; now += 5000; t.mock.timers.tick(5000);
  assert.throws(() => service.catalog({ catalogVersion: 2, since: first.watermark }), { code: 'source-unavailable' });
  assert.equal(service.catalogDeltas.current?.at, 1000); assert.equal(reads, 1);
  available = true; now += 5000; t.mock.timers.tick(5000);
  assert.equal(service.catalog({ catalogVersion: 2, since: first.watermark }).scannedAt, now);
  service.close(); const before = reads; t.mock.timers.tick(20000);
  assert.equal(reads, before); assert.equal(service.catalogTimer, null); assert.equal(service.catalogDeltas.current, null);
});

test('maintained captures and older page continuations cannot cross machine identity', () => {
  const service = new NativeCatalogDeltas({ maintained: true }), entries = [entry('a'), entry('b')];
  assert.throws(() => service.page(entries, {}, 'machine-a'), { code: 'source-unavailable' });
  service.refresh(entries, 'machine-a'); const first = service.page([], { limit: 1 }, 'machine-a');
  entries[0].source.title = 'Next capture'; service.refresh(entries, 'machine-a');
  const next = service.page([], { cursor: first.nextCursor }, 'machine-a');
  assert.equal(next.sessions[0].metadata.nativeSession.title.startsWith('Source '), true);
  assert.throws(() => service.page([], {}, 'machine-b'), { code: 'source-unavailable' });
  assert.throws(() => service.legacyPage({}, 'machine-b'), { code: 'source-unavailable' });
});

test('closing maintenance cannot admit a deferred revalidation or activate another reader', async () => {
  let nativeReaders = 0;
  const service = new CodelyncRecentService({ sources: () => [], resolveSource: async () => { nativeReaders++; throw Error('Must not activate'); } });
  service.revalidate('phone-a', 20); service.close();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(nativeReaders, 0);
  assert.throws(() => service.recent('phone-a'), { code: 'source-unavailable' });
  assert.throws(() => service.history('phone-a', { cursor: 'old' }), { code: 'source-unavailable' });
});
