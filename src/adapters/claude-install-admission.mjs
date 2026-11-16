/** @typedef {Record<string,any>} Value */
const fail = (/** @type {string} */ code) => Object.assign(Error(code), { effectMayHaveOccurred: false });

/** Pure exact predicate for a synchronously collected main-process snapshot.
 * Collection and this check must run in the same owner stack immediately before
 * deactivation. It never opens, closes, starts or mutates an application.
 * @param {{expected:Value,current:Value,expectedBridge:Value,slotBridge:Value|null|undefined,nativeReferencesStable:boolean}} input */
export function assertClaudeInstallAdmission(input) {
  const { expected, current, expectedBridge, slotBridge } = input;
  if (!expectedBridge || slotBridge !== expectedBridge || slotBridge.runtimePath !== expected.runtimePath
    || slotBridge.pid !== expected.pid || slotBridge.readOnly !== expected.readOnly) throw fail('native-installer-bridge-changed');
  const keys = ['pid', 'executable', 'runtimePath', 'runtimeGeneration', 'manifestSha256', 'profileNamespace', 'storagePath', 'appPath', 'asarSha256', 'appVersion', 'readOnly', 'mutationAllowed'];
  if (keys.some(key => !Object.hasOwn(expected, key) || !Object.hasOwn(current, key) || expected[key] !== current[key])
    || current.pid !== expectedBridge.pid || current.manifestPid !== current.pid
    || current.derivedRuntimeGeneration !== current.runtimeGeneration || current.manifestExecutable !== current.executable
    || current.manifestStoragePath !== current.storagePath || current.manifestAsarSha256 !== current.asarSha256
    || current.manifestReadOnly !== current.readOnly || current.manifestMutationAllowed !== current.mutationAllowed)
    throw fail('native-installer-identity-changed');
  if (input.nativeReferencesStable !== true || current.gatewayStable !== true || current.callbacksStable !== true
    || current.keyboardStable !== true || current.idle !== true || current.stockManifestStable !== true) throw fail('native-installer-state-changed');
}

/** @param {Value} before @param {Value} after */
export function sameClaudeNativeDraft(before, after) {
  return before.nativeDomReferenceStable === true && before.nativeEditorReferenceStable === true && before.nativeViewReferenceStable === true
    && after.nativeDomReferenceStable === true && after.nativeEditorReferenceStable === true && after.nativeViewReferenceStable === true
    && typeof before.composing === 'boolean' && before.composing === after.composing
    && before.domHash === after.domHash && before.docHash === after.docHash && JSON.stringify(before.plugins) === JSON.stringify(after.plugins);
}
