import test from 'node:test';
import assert from 'node:assert/strict';
import { codexNativeInputControl } from '../src/adapters/codex-subagent-control.mjs';

test('only original v2 agent path and parent provenance restrict direct child input', () => {
  assert.deepEqual(codexNativeInputControl({ threadSource: 'cli' }), { available: true });
  assert.deepEqual(codexNativeInputControl({ threadSource: 'subagent', source: { subAgent: { thread_spawn: { parent_thread_id: 'parent' } } } }), { available: true });
  const child = { threadSource: 'subagent', parentThreadId: 'parent', source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', agent_path: '/root/child' } } } };
  assert.deepEqual(codexNativeInputControl(child), { available: false, reason: 'parent-owned-subagent', parentConversationId: 'parent', agentPath: '/root/child' });
  assert.equal(codexNativeInputControl({ ...child, parentThreadId: 'different-parent' }).parentConversationId, null);
});
