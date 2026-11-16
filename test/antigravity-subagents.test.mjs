import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravitySubagentStatus, projectAntigravitySubagents, projectAntigravitySubagentTree, antigravitySubagentIndex } from '../src/adapters/antigravity-subagents.mjs';

/** @typedef {Record<string,any>} Value */
const host = 'local:antigravity:' + 'a'.repeat(64), generation = 'antigravity:owner-a', parent = 'native-parent';
/** @param {Value} [extra] */
function child(extra = {}) { return { status: 'CASCADE_RUN_STATUS_RUNNING', trajectoryMetadata: { parentConversationId: parent,
  subagentSpec: { typeName: 'Worker', role: 'Protocol worker', initialPrompt: 'private instruction' } },
  nativeSummaryAvailable: true, notFullyIdle: false, hasRunningSubagents: false, backgroundTaskCount: 0, ...extra }; }

test('only explicit native subagent paths qualify; forks and unrelated roots do not', () => {
  const rows = projectAntigravitySubagents({ child: child(), parent: { ...child(), trajectoryMetadata: { parentConversationId: parent, subagentSpec: {} } },
    fork: { status: 'CASCADE_RUN_STATUS_RUNNING', forkParentConversationId: parent, trajectoryMetadata: { parentConversationId: parent } },
    other: child({ trajectoryMetadata: { parentConversationId: 'other-parent', subagentSpec: { typeName: 'Worker' } } }),
    [parent]: child(), sourceChild: { source: 16, status: 1, trajectoryMetadata: { parentConversationId: parent } } }, parent, host, generation);
  assert.deepEqual(rows.map(row => row.id), ['child', 'sourceChild']);
  assert.equal(rows[0].name, 'Protocol worker');
  assert.equal(rows[0].nativeConversationId, 'child');
  assert.equal(rows[0].parentConversationId, parent);
  assert.equal(rows[0].nativeParentConversationId, parent); assert.equal(rows[0].depth, 1);
  assert.equal(rows[0].relationship, 'native-subagent');
  assert.equal(JSON.stringify(rows).includes('private instruction'), false);
});

test('native active, waiting, idle, stopped, failed and future states stay distinct', () => {
  const cases = [
    [child(), 'running'], [child({ status: 4 }), 'running'], [child({ status: 3, killed: true, waitingSteps: [{}] }), 'running'],
    [child({ latestExecutorTerminationReason: 1 }), 'running'],
    [child({ waitingSteps: [{}] }), 'waiting'], [child({ status: 1 }), 'idle'],
    [child({ status: 1, latestExecutorTerminationReason: 'EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL' }), 'idle'],
    [child({ status: 1, latestExecutorTerminationReason: 'EXECUTOR_TERMINATION_REASON_TERMINAL_CUSTOM_HOOK' }), 'idle'],
    [child({ status: 1, killed: true }), 'stopped'], [child({ status: 1, interrupted: true }), 'stopped'],
    [child({ status: 1, latestExecutorTerminationReason: 2 }), 'stopped'],
    [child({ status: 1, latestExecutorTerminationReason: 1 }), 'failed'],
    [child({ status: undefined, waitingSteps: [{}] }), 'unknown'], [child({ status: 99 }), 'unknown'],
  ];
  for (const [summary, expected] of cases) assert.equal(antigravitySubagentStatus(/** @type {Value} */ (summary)), expected);
});

test('identity stamps isolate equal child IDs across native namespaces and owner lifetimes', () => {
  const first = projectAntigravitySubagents({ same: child() }, parent, host, generation);
  const second = projectAntigravitySubagents({ same: child() }, parent, 'local:antigravity:' + 'b'.repeat(64), 'antigravity:owner-b');
  assert.equal(first[0].id, second[0].id);
  assert.notEqual(first[0].hostId, second[0].hostId);
  assert.notEqual(first[0].ownerGeneration, second[0].ownerGeneration);
  assert.throws(() => projectAntigravitySubagents({}, parent, 'local', generation), { code: 'source-epoch-changed' });
  assert.throws(() => projectAntigravitySubagents({}, parent, host, ''), { code: 'source-epoch-changed' });
});

test('unavailable and malformed lists are not manufactured as empty successful observations', () => {
  assert.throws(() => projectAntigravitySubagents(null, parent, host, generation), { code: 'antigravity-invalid-response' });
  assert.throws(() => projectAntigravitySubagents({ child: null }, parent, host, generation), { code: 'antigravity-invalid-response' });
  const many = Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['child-' + i, child()]));
  assert.equal(projectAntigravitySubagents(many, parent, host, generation).length, 128);
  assert.deepEqual(projectAntigravitySubagents({}, parent, host, generation), []);
});

test('native idle cannot hide current background work or manufacture full idle without rich proof', () => {
  for (const patch of [{ notFullyIdle: true }, { hasRunningSubagents: true }, { backgroundTaskCount: 2 }]) {
    assert.equal(antigravitySubagentStatus(child({ status: 1, latestExecutorTerminationReason: 1, ...patch })), 'running');
  }
  assert.equal(antigravitySubagentStatus(child({ status: 1, nativeSummaryAvailable: false })), 'unknown');
  assert.equal(antigravitySubagentStatus(child({ status: 1, notFullyIdle: undefined })), 'unknown');
  assert.equal(antigravitySubagentStatus(child({ status: 2, nativeActivityInvalidated: true })), 'unknown');
});

test('nested descendants retain real parent/depth and cannot cross an ordinary fork', () => {
  const summaries = { child: child(), grand: child({ trajectoryMetadata: { parentConversationId: 'child', subagentSpec: { role: 'Grandchild' } } }),
    fork: { status: 2, forkParentConversationId: parent, trajectoryMetadata: { parentConversationId: parent } },
    forkChild: child({ trajectoryMetadata: { parentConversationId: 'fork', subagentSpec: { role: 'Unrelated branch' } } }),
    other: child({ trajectoryMetadata: { parentConversationId: 'foreign-root', subagentSpec: { role: 'Foreign child' } } }) };
  const projected = projectAntigravitySubagentTree(antigravitySubagentIndex(summaries), parent, host, generation);
  assert.deepEqual(projected.rows.map(row => row.id), ['child', 'grand']);
  assert.equal(projected.rows[1].parentConversationId, parent);
  assert.equal(projected.rows[1].nativeParentConversationId, 'child'); assert.equal(projected.rows[1].depth, 2);
  assert.equal(projected.total, 2); assert.equal(projected.truncated, false);
});

test('a 136-descendant tree keeps active descendants inside the 128-row bound', () => {
  const summaries = Object.fromEntries(Array.from({ length: 136 }, (_, at) => ['historical-' + at, child({ status: 1 })]));
  summaries['historical-135'] = child({ status: 1, hasRunningSubagents: true, notFullyIdle: true });
  summaries['historical-134'] = child({ status: 2 });
  summaries['historical-133'] = child({ status: 2, waitingSteps: [{}] });
  const projected = projectAntigravitySubagentTree(antigravitySubagentIndex(summaries), parent, host, generation);
  assert.equal(projected.rows.length, 128); assert.equal(projected.total, 136);
  assert.equal(projected.truncated, true); assert.equal(projected.complete, false);
  assert.deepEqual(new Set(projected.rows.slice(0, 3).map(row => row.id)), new Set(['historical-133', 'historical-134', 'historical-135']));
});

test('a bounded inactive tree keeps direct parked workers before stopped historical descendants', () => {
  const summaries = /** @type {Value} */ ({ direct: child({ status: 1 }) });
  for (let at = 0; at < 136; at++) summaries[`stopped-${at}`] = child({ status: 1, killed: true,
    trajectoryMetadata: { parentConversationId: 'direct', subagentSpec: { role: 'Historical worker' } } });
  const projected = projectAntigravitySubagentTree(antigravitySubagentIndex(summaries), parent, host, generation);
  assert.equal(projected.rows[0].id, 'direct'); assert.equal(projected.rows[0].status, 'idle');
  assert.equal(projected.rows[1].status, 'stopped'); assert.equal(projected.total, 137); assert.equal(projected.truncated, true);
});

