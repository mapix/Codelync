import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeCatalogDeltas } from '../src/happy/recent-data.mjs';

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
