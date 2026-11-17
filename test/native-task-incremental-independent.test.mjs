import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { nativeTaskDigestText, nativeTaskSignal, nativeTaskTransfer, nativeTaskTransferApply, nativeTaskScopesEqual, nativeTaskDispatchKey } from '@codelync/wire/native-tasks';
import { decodeCompactPeerPlaintext } from '@codelync/wire/peer-codec';
import { NativeTaskTransfers } from '../src/codelync/native-task-transfers.mjs';
import { sealPeerResponse } from '../src/codelync/peer-response-codec.mjs';

/** @typedef {Record<string,any>} Value */
const FLAGS = ['tasksAvailable', 'tasksComplete', 'backgroundTasksComplete', 'tasksTruncated', 'dispatchChildrenAvailable', 'dispatchChildrenComplete', 'dispatchChildrenTruncated', 'partial'];
const scope = { app: 'claude-desktop', nativeCollection: 'claude-code-sessions', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
  parentConversationId: 'native-parent', ownerGeneration: 'b'.repeat(64), runtimeGeneration: 'claude-desktop:' + 'c'.repeat(64), queryToken: 'd'.repeat(64), cliSessionId: 'native-cli' };
/** Independent canonical SHA input specified by the contract. @param {unknown} value @returns {unknown} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** @param {Value} value */
function digest(value) {
  const body = { version: value.version, scope: value.scope, tasks: value.tasks, dispatchChildren: value.dispatchChildren,
    ...Object.fromEntries(FLAGS.map(key => [key, value[key]])) };
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}
/** @param {Value} value @returns {Value} */
const signed = value => ({ ...value, digest: digest(value) });
/** @param {number} [count] @param {Value} [extra] @returns {Value} */
function snapshot(count = 128, extra = {}) {
  return signed({ version: 1, scope, tasks: Array.from({ length: count }, (_, i) => ({ nativeTaskId: `task-${String(i).padStart(3, '0')}`, name: `Worker ${i}`,
    taskType: 'local_agent', kind: 'agent', status: 'running', isBackgrounded: true, statusSource: 'native-lifecycle' })),
  dispatchChildren: [], tasksAvailable: true, tasksComplete: true, backgroundTasksComplete: true, tasksTruncated: false,
  dispatchChildrenAvailable: true, dispatchChildrenComplete: true, dispatchChildrenTruncated: false, partial: false, ...extra });
}
/** @param {string} collection @param {string} host @param {string} [id] */
function child(collection, host, id = 'same-child') {
  return { nativeCollection: collection, hostId: host, nativeConversationId: id, ownerGeneration: 'child-owner', name: 'Native child', status: 'idle', statusSource: 'native-header' };
}
/** A separate array-based reference receiver; no production patch algorithm.
 * @param {Value|null} base @param {Value} packet @returns {Value} */
function referenceApply(base, packet) {
  if (!packet.kind) return structuredClone(packet);
  assert.ok(base); assert.equal(digest(base), base.digest);
  assert.deepEqual(packet.scope, base.scope);
  if (packet.kind === 'native-task-unchanged') { assert.equal(packet.digest, base.digest); return structuredClone(base); }
  assert.equal(packet.kind, 'native-task-delta'); assert.equal(packet.baseDigest, base.digest);
  /** @param {Value[]} rows @param {Value[]} upserts @param {string[]} removed @param {string[]|undefined} order @param {(row:Value)=>string} key */
  function patch(rows, upserts, removed, order, key) {
    const next = rows.filter(row => !removed.includes(key(row))).map(row => ({ ...row }));
    for (const row of upserts) { const index = next.findIndex(previous => key(previous) === key(row)); if (index < 0) next.push({ ...row }); else next[index] = { ...row }; }
    return order ? order.map(id => { const row = next.find(row => key(row) === id); assert.ok(row); return row; }) : next;
  }
  return { version: 1, scope: packet.scope, digest: packet.digest,
    tasks: patch(base.tasks, packet.taskUpserts, packet.taskRemovedIds, packet.taskOrder, row => row.nativeTaskId),
    dispatchChildren: patch(base.dispatchChildren, packet.dispatchUpserts, packet.dispatchRemovedKeys, packet.dispatchOrder,
      row => JSON.stringify([row.nativeCollection, row.hostId, row.nativeConversationId])),
    ...Object.fromEntries(FLAGS.map(key => [key, packet[key]])) };
}
/** @param {Value|null} base @param {Value} packet */
function verifiedApply(base, packet) { const result = nativeTaskTransferApply(base, packet); assert.equal(digest(result), result.digest); return result; }

test('ongoing signal remains a constant small metadata packet with no rows, labels or task identities', () => {
  const small = nativeTaskSignal(snapshot(1)), large = nativeTaskSignal(snapshot(128));
  assert.equal(large.tasks, undefined); assert.equal(large.dispatchChildren, undefined);
  assert.equal(JSON.stringify(large).includes('Worker'), false); assert.equal(JSON.stringify(large).includes('task-127'), false);
  assert.equal(large.taskCount, 128);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 1500);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) - Buffer.byteLength(JSON.stringify(small)) < 10);
});

test('single-status delta and unchanged replies are small and match an independent materialization', () => {
  const base = snapshot(), target = structuredClone(base); target.tasks[63].status = 'stopped'; target.digest = digest(target);
  const cache = new NativeTaskTransfers(); cache.remember(base);
  const packet = cache.response(target, base.digest);
  assert.equal(packet.kind, 'native-task-delta'); assert.equal(packet.taskUpserts.length, 1);
  assert.deepEqual(referenceApply(base, packet), target); assert.deepEqual(verifiedApply(base, packet), target);
  const bytes = Buffer.byteLength(JSON.stringify(packet)), fullBytes = Buffer.byteLength(JSON.stringify(target));
  assert.ok(bytes < fullBytes / 10, `${bytes}/${fullBytes}`); assert.ok(bytes < 2500);
  const unchanged = cache.response(target, target.digest);
  assert.equal(unchanged.kind, 'native-task-unchanged'); assert.ok(Buffer.byteLength(JSON.stringify(unchanged)) < 1500);
  assert.deepEqual(verifiedApply(target, unchanged), target);
});

test('flag-only partial coverage changes are explicit and never inherit a former complete roster', () => {
  const base = snapshot(), target = signed({ ...base, tasksComplete: false, backgroundTasksComplete: false, partial: true });
  const packet = nativeTaskTransfer(base, target);
  assert.equal(packet.kind, 'native-task-delta'); assert.deepEqual(packet.taskUpserts, []);
  assert.equal(packet.tasksComplete, false); assert.equal(packet.partial, true);
  assert.notEqual(target.digest, base.digest); assert.deepEqual(referenceApply(base, packet), target);
  assert.deepEqual(verifiedApply(base, packet), target);
});

test('order-only task and child changes are explicit even when no row content changes', () => {
  const base = snapshot(64, { dispatchChildren: [child('claude-code-sessions', scope.hostId, 'child-a'), child('local-agent-mode-sessions', 'host-lam', 'child-b')] });
  const target = structuredClone(base); target.tasks = [...target.tasks.slice(1), target.tasks[0]]; target.dispatchChildren.reverse(); target.digest = digest(target);
  const packet = nativeTaskTransfer(base, target);
  assert.equal(packet.kind, 'native-task-delta'); assert.deepEqual(packet.taskUpserts, []); assert.deepEqual(packet.dispatchUpserts, []);
  assert.deepEqual(packet.taskOrder, target.tasks.map((/** @type {Value} */ row) => row.nativeTaskId));
  assert.deepEqual(packet.dispatchOrder, target.dispatchChildren.map(nativeTaskDispatchKey));
  assert.deepEqual(referenceApply(base, packet), target); assert.deepEqual(verifiedApply(base, packet), target);
});

test('remove, replacement, addition and reordering round-trip without collapsing child composite identities', () => {
  const base = snapshot(64, { dispatchChildren: [child('claude-code-sessions', scope.hostId), child('local-agent-mode-sessions', 'host-lam')] });
  const target = structuredClone(base); target.tasks = target.tasks.slice(2).reverse(); target.tasks[0].name = 'Changed';
  target.tasks.push({ ...target.tasks[0], nativeTaskId: 'new-task', name: 'New' });
  target.dispatchChildren[1].status = 'waiting'; target.digest = digest(target);
  const packet = nativeTaskTransfer(base, target);
  assert.equal(packet.kind, 'native-task-delta'); assert.equal(packet.dispatchUpserts.length, 1);
  assert.notEqual(nativeTaskDispatchKey(base.dispatchChildren[0]), nativeTaskDispatchKey(base.dispatchChildren[1]));
  assert.deepEqual(referenceApply(base, packet), target); assert.deepEqual(verifiedApply(base, packet), target);
});

test('missing, forged or evicted cache baselines return full snapshots; digest hints cannot materialize rows', () => {
  const current = snapshot(), cache = new NativeTaskTransfers();
  assert.equal(cache.response(current, current.digest).kind, undefined);
  assert.equal(cache.response(current, 'f'.repeat(64)).kind, undefined);
  assert.throws(() => nativeTaskTransferApply(null, cache.response(current, current.digest)), /invalid-native-task-transfer/);
  const versions = Array.from({ length: 10 }, (_, i) => { const value = snapshot(); value.tasks[0].name = `version-${i}`; value.digest = digest(value); return value; });
  cache.clear(); for (const value of versions.slice(0, 8)) cache.remember(value);
  const lastUsable = cache.response(versions[8], versions[0].digest);
  assert.equal(lastUsable.kind, 'native-task-delta'); assert.deepEqual(verifiedApply(versions[0], lastUsable), versions[8]);
  assert.equal(cache.snapshots.has(versions[0].digest), false); assert.equal(cache.snapshots.size, 8);
  assert.equal(cache.response(versions[9], versions[0].digest).kind, undefined);
});

test('cache byte cap counts real UTF8 and rejects a single oversized snapshot without trimming its proof', () => {
  const value = snapshot(64); value.tasks.forEach((/** @type {Value} */ row) => { row.name = '界'.repeat(160); }); value.digest = digest(value);
  const utf8 = Buffer.byteLength(JSON.stringify(value)), utf16 = JSON.stringify(value).length;
  assert.ok(utf8 > utf16);
  const cache = new NativeTaskTransfers({ maxBytes: Math.floor((utf8 + utf16) / 2) });
  const before = structuredClone(value);
  assert.throws(() => cache.remember(value), { code: 'native-task-response-too-large' });
  assert.equal(cache.snapshots.size, 0); assert.equal(cache.bytes, 0); assert.deepEqual(value, before);
});

test('total cache bytes evict historical baselines independently of the eight-entry count', () => {
  const versions = Array.from({ length: 4 }, (_, i) => { const value = snapshot(4); value.tasks[0].name = `rev-${i}`; value.digest = digest(value); return value; });
  const one = Buffer.byteLength(JSON.stringify(versions[0])), cache = new NativeTaskTransfers({ maxBytes: one * 2 + 8 });
  for (const value of versions.slice(0, 3)) cache.remember(value);
  assert.ok(cache.bytes <= one * 2 + 8); assert.ok(cache.snapshots.size <= 2);
  assert.equal(cache.snapshots.has(versions[0].digest), false);
  assert.equal(cache.response(versions[3], versions[0].digest).kind, undefined);
});

test('malformed self-digested baselines and getter payloads cannot enter or poison the materialized cache', () => {
  const healthy = snapshot(4), cache = new NativeTaskTransfers(); cache.remember(healthy);
  const malformed = signed({ ...healthy, tasks: null });
  assert.throws(() => cache.remember(malformed), { code: 'invalid-native-task-snapshot' });
  let invoked = 0;
  const getter = { ...healthy };
  Object.defineProperty(getter, 'tasks', { enumerable: true, get() { invoked++; return healthy.tasks; } });
  assert.throws(() => cache.remember(getter), { code: 'invalid-native-task-snapshot' });
  assert.equal(invoked, 0); assert.equal(cache.snapshots.size, 1);
  assert.equal(cache.response(healthy, healthy.digest).kind, 'native-task-unchanged');
});

test('canonical digest ignores property construction order but preserves array order and omits capture', () => {
  const value = snapshot(4), shuffled = Object.fromEntries(Object.entries(value).reverse());
  shuffled.scope = Object.fromEntries(Object.entries(value.scope).reverse()); shuffled.capture = { epoch: 'a'.repeat(32), seq: 9 };
  assert.equal(nativeTaskDigestText(value), nativeTaskDigestText(shuffled));
  assert.equal(digest(value), digest(shuffled));
  const reordered = structuredClone(value); reordered.tasks.reverse();
  assert.notEqual(nativeTaskDigestText(value), nativeTaskDigestText(reordered));
});

test('delta baselines cannot be taken from a different source, main or query and every result needs verified SHA', () => {
  const base = snapshot(), target = structuredClone(base); target.tasks[0].status = 'completed'; target.digest = digest(target);
  const packet = nativeTaskTransfer(base, target);
  for (const key of ['hostId', 'parentConversationId', 'ownerGeneration', 'runtimeGeneration', 'queryToken', 'cliSessionId']) {
    const other = signed({ ...base, scope: { ...base.scope, [key]: 'foreign' } });
    assert.equal(nativeTaskScopesEqual(other.scope, base.scope), false);
    assert.equal(nativeTaskTransfer(other, target).kind, undefined);
    assert.throws(() => nativeTaskTransferApply(other, packet), /invalid-native-task-transfer/);
  }
  const corrupted = structuredClone(packet); corrupted.taskUpserts[0].name = 'Forged';
  assert.throws(() => verifiedApply(base, corrupted));
  assert.throws(() => new NativeTaskTransfers().response({ ...target, digest: '0'.repeat(64) }, base.digest), { code: 'invalid-native-task-snapshot' });
});

test('duplicate patches, contradictory removals, forged counts and invalid order cannot promote a complete result', () => {
  const base = snapshot(), target = structuredClone(base); target.tasks[0].status = 'stopped'; target.digest = digest(target);
  const valid = nativeTaskTransfer(base, target);
  for (const patch of [
    { taskUpserts: [valid.taskUpserts[0], valid.taskUpserts[0]] },
    { taskRemovedIds: ['task-000'] }, { taskRemovedIds: ['not-in-baseline'] },
    { taskOrder: Array(128).fill('task-000') }, { taskCount: 0 },
    { tasksAvailable: false, tasksComplete: true }, { partial: true },
  ]) assert.throws(() => nativeTaskTransferApply(base, { ...valid, ...patch }), /invalid-native-task-transfer/);
});

test('a late D0-to-D1 delta cannot apply to the already materialized D2 baseline', () => {
  const d0 = snapshot(), d1 = structuredClone(d0), d2 = structuredClone(d0);
  d1.tasks[0].status = 'paused'; d1.digest = digest(d1);
  d2.tasks[0].status = 'completed'; d2.digest = digest(d2);
  const old = nativeTaskTransfer(d0, d1), newer = nativeTaskTransfer(d0, d2), materialized = verifiedApply(d0, newer);
  assert.throws(() => nativeTaskTransferApply(materialized, old), /invalid-native-task-transfer/);
  assert.deepEqual(materialized, d2);
});

test('sealed task packets retain peer identity fencing before any materialization', () => {
  const peer = 'ab'.repeat(32), mac = nacl.box.keyPair(), phone = nacl.box.keyPair();
  const base = snapshot(), target = structuredClone(base); target.tasks[0].status = 'stopped'; target.digest = digest(target);
  const transfer = nativeTaskTransfer(base, target), sealed = sealPeerResponse(peer, transfer, phone.publicKey, mac.secretKey, '3');
  assert.ok(Array.isArray(sealed));
  const packet = /** @type {[number,string,string]} */ (sealed);
  const plain = nacl.box.open(Buffer.from(packet[2], 'base64url'), Buffer.from(packet[1], 'base64url'), mac.publicKey, phone.secretKey); assert.ok(plain);
  assert.throws(() => decodeCompactPeerPlaintext(plain, 'cd'.repeat(32)), /foreign-peer/);
  assert.deepEqual(verifiedApply(base, /** @type {Value} */ (decodeCompactPeerPlaintext(plain, peer))), target);
  const otherPhone = nacl.box.keyPair();
  assert.equal(nacl.box.open(Buffer.from(packet[2], 'base64url'), Buffer.from(packet[1], 'base64url'), mac.publicKey, otherPhone.secretKey), null);
});
