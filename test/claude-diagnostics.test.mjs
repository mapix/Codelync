import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeProviderFacts, projectClaudeBridgeResult } from '../src/adapters/claude-diagnostics.mjs';

test('native capability projection never serializes nested provider credentials', () => {
  const result = claudeProviderFacts({ creds: { provider: 'gateway', apiKey: 'private-fixture-key', models: [{ name: 'native-model' }] }, credentialSource: { key: 'private-fixture-key' }, supportsDirectOneShot: true });
  assert.deepEqual(result, { provider: 'gateway', credentialPresent: true, modelIds: ['native-model'], supportsDirectOneShot: true });
  assert.equal(JSON.stringify(result).includes('private-fixture-key'), false);
});

test('all owner/account/config diagnostic routes drop recursively nested secrets, endpoints and headers', () => {
  const secret = 'synthetic-secret-sentinel', endpoint = 'https://private-endpoint.example.invalid/hidden';
  const input = { provider: { creds: { apiKey: secret, baseUrl: endpoint, provider: 'gateway' }, credentialSource: { key: secret } },
    configSource: { type: 'local', raw: { apiKey: secret } }, account: { token: secret }, config: { headers: { Authorization: secret }, url: endpoint },
    diagnostics: { nested: [{ password: secret, endpoint }] }, nativeConfigProvider: 'gateway', nativeConfigModels: [{ id: 'native-model', headers: { Authorization: secret } }],
    effectiveCodeModels: [{ id: endpoint }, { id: 'Bearer '+secret }], userdata: endpoint, rendererConfig: { credentials: secret }, appVersion: '4.16336.0' };
  for (const method of ['owner.status', 'owner.resolvedConfig', 'owner.gateway', 'owner.resolveGateway', 'owner.mode', 'owner.lastFailure', 'code.capabilities', 'code.initialize', 'code.prepare', 'code.list', 'cowork.list', 'code.methods', 'code.historyShape', 'code.send', 'code.eventsShape']) {
    const serialized = JSON.stringify(projectClaudeBridgeResult(method, input));
    assert.equal(serialized.includes(secret), false, method); assert.equal(serialized.includes(endpoint), false, method);
  }
  assert.throws(() => projectClaudeBridgeResult('owner.arbitraryRawObject', input));
});
