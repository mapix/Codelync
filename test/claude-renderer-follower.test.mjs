import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeRendererEndpoint, installClaudeRendererFollower } from '../src/adapters/claude-renderer-follower.mjs';

test('trusted-renderer projection excludes account/provider secrets and uses bounded native tail APIs', async () => {
  /** @type {any[][]} */ const calls = [];
  const secret = 'synthetic-provider-secret';
  const api = { getSession: async () => ({ sessionId: 'local_probe', isRunning: false, provider: { key: secret } }),
    getTranscriptTail: async (/** @type {any[]} */ ...args) => { calls.push(args); return { hasMore: true, messages: [{ type: 'assistant', uuid: 'answer', provider: { key: secret }, message: { role: 'assistant', content: 'hello', credential: secret } }] }; } };
  const endpoint = createClaudeRendererEndpoint({ LocalSessions: api, LocalAgentModeSessions: {} }, { ownerEpoch: 'owner', gatewayVerified: true });
  const reply = await endpoint.request({ ownerEpoch: 'owner', appMode: 'code', method: 'snapshot', params: { sessionId: 'local_probe' } });
  assert.deepEqual(calls, [['local_probe', 32]]); assert.equal(JSON.stringify(reply).includes(secret), false);
});

test('renderer command admission is retained without replay and deactivation rejects new work', async () => {
  let sends = 0;
  const api = { getSession: async () => ({ sessionId: 'local_probe', isRunning: false }), sendMessage: async () => { sends++; } };
  const endpoint = createClaudeRendererEndpoint({ LocalSessions: api, LocalAgentModeSessions: {} }, { ownerEpoch: 'owner', gatewayVerified: true });
  const packet = { ownerEpoch: 'owner', appMode: 'code', method: 'send', commandId: 'operation-one', params: { sessionId: 'local_probe', text: 'hello', messageUuid: 'native-uuid' } };
  await Promise.all([endpoint.request(packet), endpoint.request(packet)]); assert.equal(sends, 1);
  endpoint.deactivate(); await assert.rejects(endpoint.request(packet), { code: 'renderer-follower-deactivated' }); assert.equal(sends, 1);
});

test('unknown query token and non-loopback installation fail before native access', async () => {
  const api = { getSession: async () => ({ sessionId: 'local_probe', isRunning: true }) };
  const endpoint = createClaudeRendererEndpoint({ LocalSessions: api, LocalAgentModeSessions: {} }, { ownerEpoch: 'owner', gatewayVerified: true });
  await assert.rejects(endpoint.request({ ownerEpoch: 'owner', appMode: 'code', method: 'interrupt', commandId: 'operation-one', params: { sessionId: 'local_probe', queryToken: 'invented' } }), { code: 'native-query-token-unavailable' });
  assert.throws(() => installClaudeRendererFollower({}, { socketUrl: 'wss://example.invalid/claude-native-follower', nonce: 'a'.repeat(64), ownerEpoch: 'owner', gatewayVerified: true }), { code: 'invalid-local-bridge' });
});
