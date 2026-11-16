import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSettingsScope, sameNativeSettingsScope, confirmedNativeSettingsEvidence } from '../src/happy/native-settings-scope.mjs';

const scope = { app: 'claude-desktop', appMode: 'code', nativeCollection: 'claude-code-sessions', nativeConversationId: 'session', hostId: 'host',
  ownerGeneration: 'session-owner', runtimeGeneration: 'main-owner', queryToken: 'held-query', cliSessionId: 'native-cli', settingsToken: 'a'.repeat(64) };
const after = { ...scope, settingsToken: 'b'.repeat(64) };
const controls = { scope: after, model: { current: { model: 'native-alias', reasoningEffort: 'high' } } };
const evidence = { version: 1, expectedScope: scope, confirmedScope: after, modelAckConfirmed: true, effortAckConfirmed: true,
  effectiveModel: 'native-alias', effectiveReasoningEffort: 'high' };

test('settings scope distinguishes original Query, collection, main/session generations and snapshot token', () => {
  assert.deepEqual(nativeSettingsScope(scope), scope);
  for (const key of ['queryToken', 'ownerGeneration', 'runtimeGeneration', 'nativeConversationId', 'hostId', 'cliSessionId']) {
    assert.equal(sameNativeSettingsScope(scope, { ...scope, [key]: 'replacement' }), false, key);
  }
  assert.equal(sameNativeSettingsScope(scope, after), false); assert.equal(sameNativeSettingsScope(scope, after, false), true);
  assert.equal(nativeSettingsScope({ ...scope, appMode: 'chat' }), null);
  assert.equal(nativeSettingsScope({ ...scope, queryToken: null }), null);
});

test('acknowledged effective alias/clamped effort can confirm; optimistic, partial or foreign values cannot', () => {
  assert.ok(confirmedNativeSettingsEvidence(evidence, scope, controls));
  assert.equal(confirmedNativeSettingsEvidence({ ...evidence, effortAckConfirmed: false }, scope, controls), null);
  assert.equal(confirmedNativeSettingsEvidence({ ...evidence, modelAckConfirmed: false }, scope, controls), null);
  assert.equal(confirmedNativeSettingsEvidence({ ...evidence, confirmedScope: { ...after, queryToken: 'replacement' } }, scope, controls), null);
  assert.equal(confirmedNativeSettingsEvidence(evidence, scope, { ...controls, model: { current: { model: 'requested-not-native', reasoningEffort: 'max' } } }), null);
  assert.equal(confirmedNativeSettingsEvidence(undefined, scope, controls), null);
});
