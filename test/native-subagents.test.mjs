import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexSubagentProjection, sourceSubagents } from '../src/adapters/native-subagents.mjs';

const source = { app: 'codex', id: 'parent', hostId: 'local' };
/** @param {string} kind @param {string} [id] */
const event = (kind, id = 'child') => ({ type: 'subAgentActivity', kind, agentThreadId: id, agentPath: '/root/verification', id: 'event-' + kind,
  startedAtMs: 100, completedAtMs: 100, model: 'native-model', reasoningEffort: 'high', prompt: 'PRIVATE-PROMPT-MUST-NOT-LEAVE' });

test('native starts and completion stay distinct from tool completion and ordinary interaction', () => {
  const projection = new CodexSubagentProjection();
  const view = projection.project([{ items: [event('started'), event('interacted')] }], 'parent', 'local', 'owner');
  assert.equal(view.subagents[0].status, 'running');
  assert.equal(view.subagents[0].relationship, 'native-subagent');
  assert.equal(JSON.stringify(view).includes('PRIVATE-PROMPT-MUST-NOT-LEAVE'), false);
  const complete = projection.project([{ items: [event('started'), event('completed')] }], 'parent', 'local', 'owner');
  assert.equal(complete.subagents[0].status, 'completed');
});

test('an interaction after completion is unknown and an explicit new start resumes lifecycle', () => {
  const projection = new CodexSubagentProjection();
  assert.equal(projection.project([{ items: [event('completed'), event('interacted')] }], 'parent', 'local', 'owner').subagents[0].status, 'unknown');
  assert.equal(projection.project([{ items: [event('completed'), event('started')] }], 'parent', 'local', 'owner').subagents[0].status, 'running');
});

test('generic tool success, malformed identities and the parent itself never become subagents', () => {
  const projection = new CodexSubagentProjection();
  const view = projection.project([{ items: [{ type: 'mcpToolCall', status: 'completed', agentThreadId: 'not-proof' }, event('started', 'bad\nid'), event('started', 'parent')] }], 'parent', 'local', 'owner');
  assert.deepEqual(view.subagents, []);
  assert.equal(projection.project([], 'parent', 'local', null).subagentsAvailable, false);
});

test('parent, application, instance and owner fences protect the published agentState list', () => {
  const row = new CodexSubagentProjection().project([{ items: [event('started')] }], source.id, source.hostId, 'owner').subagents[0];
  assert.equal(sourceSubagents([row], source, 'owner').length, 1);
  assert.deepEqual(sourceSubagents([row], { ...source, hostId: 'other-host' }, 'owner'), []);
  assert.deepEqual(sourceSubagents([row], { ...source, id: 'other-parent' }, 'owner'), []);
  assert.deepEqual(sourceSubagents([row], source, 'new-owner'), []);
  assert.deepEqual(sourceSubagents([{ ...row, relationship: 'fork' }], source, 'owner'), []);
});

test('Antigravity descendant display preserves the actual native parent without changing roster or control scope', () => {
  const parent = { app: 'antigravity', id: 'root', hostId: 'native-host' };
  const row = { id: 'leaf', nativeConversationId: 'leaf', name: 'worker', app: 'antigravity', hostId: 'native-host',
    parentConversationId: 'root', ownerGeneration: 'owner', relationship: 'native-subagent', status: 'running',
    nativeParentConversationId: 'coordinator', depth: 2, privateNativeInput: 'PRIVATE-NOT-PUBLISHED' };
  const published = sourceSubagents([row], parent, 'owner');
  assert.equal(published[0].parentConversationId, 'root');
  assert.equal(published[0].nativeParentConversationId, 'coordinator');
  assert.equal(published[0].depth, 2);
  assert.equal(JSON.stringify(published).includes('PRIVATE-NOT-PUBLISHED'), false);
  assert.deepEqual(sourceSubagents([row], parent, 'new-owner'), []);
  for (const change of [{ depth: 1 }, { depth: 0 }, { depth: 129 }, { nativeParentConversationId: 'leaf' }, { nativeParentConversationId: undefined }]) {
    assert.deepEqual(sourceSubagents([{ ...row, ...change }], parent, 'owner'), []);
  }
  assert.equal(sourceSubagents([{ ...row, nativeParentConversationId: 'root', depth: 1 }], parent, 'owner')[0].depth, 1);
});
