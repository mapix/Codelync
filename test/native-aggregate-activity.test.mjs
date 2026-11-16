import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateNativeActivity } from '../src/adapters/native-aggregate-activity.mjs';
import { NativeCatalogDeltas } from '../src/happy/recent-data.mjs';

const source = { app: 'codex', parentConversationId: 'parent', hostId: 'local', ownerGeneration: 'owner', ownStatus: 'idle', rosterAvailable: true, rosterComplete: true };
/** @param {string} status @param {string} [id] */
const child = (status, id = 'child') => ({ relationship: 'native-subagent', app: 'codex', parentConversationId: 'parent', hostId: 'local', ownerGeneration: 'owner', nativeConversationId: id, status });

test('idle parent is aggregate running or waiting while preserving its own status and identity', () => {
  const active = aggregateNativeActivity({ ...source, subagents: [child('running')] });
  assert.equal(active.status, 'running'); assert.equal(active.ownStatus, 'idle'); assert.equal(active.active, true);
  const waiting = aggregateNativeActivity({ ...source, subagents: [child('waiting')] });
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.active, true); assert.equal(waiting.waiting, true);
  assert.equal('currentTurnId' in waiting, false);
  const ownWaiting = aggregateNativeActivity({ ...source, ownWaiting: true, subagents: [] });
  assert.equal(ownWaiting.active, false); assert.equal(ownWaiting.waiting, true); assert.equal(ownWaiting.known, true);
});

test('unknown or incomplete roster cannot turn an idle/completed own invocation into idle aggregate', () => {
  for (const value of [{ rosterAvailable: false, subagents: [] }, { rosterComplete: false, subagents: [] }, { subagents: [child('unknown')] }]) {
    const result = aggregateNativeActivity({ ...source, ...value }); assert.equal(result.status, 'unknown'); assert.equal(result.known, false);
  }
  assert.equal(aggregateNativeActivity({ ...source, ownStatus: 'completed', rosterComplete: false, subagents: [] }).status, 'unknown');
  const positive = aggregateNativeActivity({ ...source, rosterComplete: false, subagents: [child('running'), child('unknown', 'unknown')] });
  assert.equal(positive.status, 'running'); assert.equal(positive.known, true); assert.equal(positive.rosterComplete, false);
});

test('only same-parent, namespace and owner membership contributes; duplicate identities cannot prove complete roster', () => {
  const foreign = aggregateNativeActivity({ ...source, subagents: [{ ...child('running'), ownerGeneration: 'other' }] });
  assert.equal(foreign.status, 'unknown'); assert.equal(foreign.childCount, 0);
  assert.equal(aggregateNativeActivity({ ...source, subagents: [child('running', 'parent')] }).status, 'unknown');
  const duplicate = aggregateNativeActivity({ ...source, subagents: [child('idle'), child('idle')] });
  assert.equal(duplicate.childCount, 1); assert.equal(duplicate.rosterAvailable, false); assert.equal(duplicate.status, 'unknown');
  assert.equal(aggregateNativeActivity({ ...source, subagents: [child('stopped'), child('failed', 'failed')] }).status, 'idle');
});

test('child-only digest change yields one parent directory delta, unchanged aggregate yields no rows', () => {
  let aggregate = aggregateNativeActivity({ ...source, subagents: [child('running')] });
  const entry = { source: { app: 'codex', id: 'parent', hostId: 'local', updatedAt: 100 }, binding: { happySessionId: 'relay-parent', metadataVersion: 1, metadata: { machineId: 'machine', nativeSession: { catalogueAvailable: true } } },
    actor: { transport: { peerSnapshot: () => ({ metadata: { machineId: 'machine', nativeSession: { catalogueAvailable: true } }, agentState: { aggregateActivity: aggregate } }) } } };
  const catalog = new NativeCatalogDeltas({ now: () => 1000 }), full = catalog.page([entry], {}, 'machine');
  assert.equal(full.sessions.length, 1);
  assert.deepEqual(catalog.page([entry], { since: full.watermark }, 'machine').sessions, []);
  aggregate = aggregateNativeActivity({ ...source, subagents: [child('waiting')] });
  const delta = catalog.page([entry], { since: full.watermark }, 'machine'); assert.equal(delta.sessions.length, 1);
  assert.equal(delta.sessions[0].agentState.aggregateActivity.status, 'waiting');
});
