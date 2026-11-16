import test from 'node:test';
import assert from 'node:assert/strict';
import { assertClaudeInstallAdmission, sameClaudeNativeDraft } from '../src/adapters/claude-install-admission.mjs';

/** @typedef {Record<string,any>} Value */
function fixture() {
  const expected = { pid: 5604, executable: '/synthetic/Claude', runtimePath: '/synthetic/runtime.json', runtimeGeneration: 'synthetic-original-epoch',
    manifestSha256: '1'.repeat(64), profileNamespace: 'synthetic-copy', storagePath: '/synthetic/profile', appPath: '/synthetic/app.asar',
    asarSha256: '2'.repeat(64), appVersion: '4.16336.0', readOnly: false, mutationAllowed: true };
  const bridge = { pid: expected.pid, runtimePath: expected.runtimePath, readOnly: false };
  const current = { ...expected, manifestPid: expected.pid, derivedRuntimeGeneration: expected.runtimeGeneration,
    manifestExecutable: expected.executable, manifestStoragePath: expected.storagePath, manifestAsarSha256: expected.asarSha256,
    manifestReadOnly: false, manifestMutationAllowed: true, gatewayStable: true, callbacksStable: true, keyboardStable: true, idle: true, stockManifestStable: true };
  return { expected, current: /** @type {Value} */ (current), expectedBridge: bridge, slotBridge: /** @type {Value} */ (bridge), nativeReferencesStable: true };
}

test('exact main-process admission accepts the synchronously captured owner without invoking a mutation', () => {
  const f = fixture(); assert.doesNotThrow(() => assertClaudeInstallAdmission(f));
});

test('a replacement SLOT or newer manifest epoch rejects before deactivation despite the same path and readonly flag', () => {
  const f = fixture(); f.slotBridge = { ...f.expectedBridge };
  assert.throws(() => assertClaudeInstallAdmission(f), { message: 'native-installer-bridge-changed', effectMayHaveOccurred: false });
  const g = fixture(); g.current.runtimeGeneration = 'synthetic-newer-epoch';
  assert.throws(() => assertClaudeInstallAdmission(g), { message: 'native-installer-identity-changed', effectMayHaveOccurred: false });
});

test('PID, executable, private manifest, profile, ASAR and generation derivation each have an exact admission fence', () => {
  for (const key of ['pid', 'executable', 'manifestSha256', 'profileNamespace', 'storagePath', 'appPath', 'asarSha256', 'derivedRuntimeGeneration', 'manifestStoragePath', 'manifestPid']) {
    const f = fixture(); f.current[key] = 'foreign';
    assert.throws(() => assertClaudeInstallAdmission(f), { message: 'native-installer-identity-changed', effectMayHaveOccurred: false }, key);
  }
});

test('late native reference, callback, keyboard, Gateway, idle or stock drift cannot pass admission', () => {
  for (const key of ['gatewayStable', 'callbacksStable', 'keyboardStable', 'idle', 'stockManifestStable']) {
    const f = fixture(); f.current[key] = false;
    assert.throws(() => assertClaudeInstallAdmission(f), { message: 'native-installer-state-changed', effectMayHaveOccurred: false }, key);
  }
  const f = fixture(); f.nativeReferencesStable = false;
  assert.throws(() => assertClaudeInstallAdmission(f), { message: 'native-installer-state-changed', effectMayHaveOccurred: false });
});

test('native draft composition transitions are rejected even with identical text, document, plugins and references', () => {
  const before = { nativeDomReferenceStable: true, nativeEditorReferenceStable: true, nativeViewReferenceStable: true,
    composing: true, domHash: 'synthetic-dom', docHash: 'synthetic-doc', plugins: ['native-plugin'] };
  assert.equal(sameClaudeNativeDraft(before, { ...before, composing: false }), false);
  assert.equal(sameClaudeNativeDraft(before, { ...before }), true);
  assert.equal(sameClaudeNativeDraft(before, { ...before, nativeViewReferenceStable: false }), false);
});
