import test from 'node:test';
import assert from 'node:assert/strict';
import { isCodelyncCodexSource, isCodelyncAntigravitySource, isCodelyncClaudeSource, isCodelyncNativeSource } from '../src/codelync/source-scope.mjs';

test('current Codelync scope accepts native Codex descriptors and legacy missing mode', () => {
  const source = { app: 'codex', kind: 'session', id: 'original-id', hostId: 'local' };
  assert.equal(isCodelyncCodexSource(source), true);
  assert.equal(isCodelyncCodexSource(source, {}), true);
  assert.equal(isCodelyncCodexSource(source, { bridge: { controlMode: 'session' } }), true);
  assert.equal(isCodelyncCodexSource({ app: 'codex' }, { controlMode: 'session' }), true);
});

test('Antigravity native scope requires an explicit protocol, instance namespace and session mode', () => {
  const source = { app: 'antigravity', kind: 'session', protocol: 'antigravity-connect', hostId: 'local:antigravity:' + 'a'.repeat(64), runtimeGeneration: 'owner-one' };
  assert.equal(isCodelyncAntigravitySource(source), true); assert.equal(isCodelyncNativeSource(source), true);
  for (const field of ['protocol', 'runtimeGeneration', 'hostId']) {
    const copy = /** @type {Record<string,any>} */ ({ ...source }); delete copy[field]; assert.equal(isCodelyncAntigravitySource(copy), false);
  }
  assert.equal(isCodelyncAntigravitySource({ ...source, hostId: 'local' }), false);
  assert.equal(isCodelyncAntigravitySource({ ...source, kind: 'window' }, { bridge: { controlMode: 'session' } }), false);
  assert.equal(isCodelyncAntigravitySource(source, { bridge: { controlMode: null } }), false);
  assert.equal(isCodelyncAntigravitySource(source, { bridge: { controlMode: 'window' } }), false);
  assert.equal(isCodelyncCodexSource(source), false);
});

test('window and unknown modes cannot promote a preserved descriptor into Codex support', () => {
  const source = { app: 'codex', kind: 'session' };
  for (const controlMode of ['window', 'unknown', '', null, false]) {
    assert.equal(isCodelyncCodexSource(source, { bridge: { controlMode } }), false);
    assert.equal(isCodelyncCodexSource(source, { controlMode }), false);
  }
  assert.equal(isCodelyncCodexSource(source, { bridge: { controlMode: 'session' }, controlMode: 'window' }), false);
  assert.equal(isCodelyncCodexSource({ ...source, kind: 'window' }, { bridge: { controlMode: 'session' } }), false);
  for (const app of ['zcode', 'claude-desktop', 'cursor', 'terminal', 'Codex', '']) assert.equal(isCodelyncCodexSource({ app }), false);
  for (const value of [null, undefined, [], 'codex']) assert.equal(isCodelyncCodexSource(value), false);
});

test('Claude requires exact native protocol, mode and record collection without a cloud or window fallback', () => {
  const source = { app: 'claude-desktop', id: 'native', kind: 'session', protocol: 'claude-desktop-native',
    hostId: 'local:claude-desktop:' + 'b'.repeat(64), runtimeGeneration: 'original-owner', appMode: 'code', nativeCollection: 'claude-code-sessions' };
  assert.equal(isCodelyncClaudeSource(source), true); assert.equal(isCodelyncNativeSource(source), true);
  assert.equal(isCodelyncClaudeSource({ ...source, appMode: 'chat', nativeCollection: 'local-agent-mode-sessions' }), true);
  for (const field of ['id', 'kind', 'protocol', 'hostId', 'runtimeGeneration', 'appMode', 'nativeCollection']) {
    const missing = /** @type {Record<string,any>} */ ({ ...source }); delete missing[field]; assert.equal(isCodelyncClaudeSource(missing), false);
  }
  for (const patch of [{ kind: 'window' }, { appMode: 'chat' }, { appMode: 'claude-ai-chat' }, { hostId: 'local' }, { runtimeGeneration: null }]) assert.equal(isCodelyncClaudeSource({ ...source, ...patch }), false);
  for (const controlMode of [null, 'window', 'unknown', false]) assert.equal(isCodelyncClaudeSource(source, { bridge: { controlMode } }), false);
});
