/** @typedef {Record<string,any>} Value */
const keys = ['app', 'appMode', 'nativeCollection', 'nativeConversationId', 'hostId', 'ownerGeneration', 'runtimeGeneration', 'queryToken', 'cliSessionId', 'settingsToken'];
/** @param {unknown} value @returns {value is Value} */
const object = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
/** @param {unknown} value @param {number} max */
const label = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

/** Session and main generations are distinct; this describes an existing Query.
 * @param {unknown} input @returns {Value|null} */
export function nativeSettingsScope(input) {
  if (!object(input) || Object.getOwnPropertyNames(input).length !== keys.length
    || keys.some(key => !Object.hasOwn(input, key))
    || input.app !== 'claude-desktop' || !['code', 'chat'].includes(input.appMode)
    || input.nativeCollection !== (input.appMode === 'code' ? 'claude-code-sessions' : 'local-agent-mode-sessions')
    || !label(input.nativeConversationId, 512) || !label(input.hostId, 256) || !label(input.ownerGeneration, 2048)
    || !label(input.runtimeGeneration, 2048) || !label(input.queryToken, 512) || !label(input.cliSessionId, 512)
    || typeof input.settingsToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.settingsToken)) return null;
  return Object.fromEntries(keys.map(key => [key, input[key]]));
}

/** @param {unknown} a @param {unknown} b @param {boolean} [includeToken] */
export function sameNativeSettingsScope(a, b, includeToken = true) {
  const first = nativeSettingsScope(a), second = nativeSettingsScope(b);
  return !!first && !!second && keys.every(key => !includeToken && key === 'settingsToken' || first[key] === second[key]);
}

/** An optimistic header value never supplies this acknowledgement evidence.
 * @param {unknown} input @param {unknown} expected @param {unknown} controls @returns {Value|null} */
export function confirmedNativeSettingsEvidence(input, expected, controls) {
  if (!object(input) || input.version !== 1 || input.modelAckConfirmed !== true || input.effortAckConfirmed !== true
    || !sameNativeSettingsScope(input.expectedScope, expected) || !sameNativeSettingsScope(input.confirmedScope, expected, false)
    || !object(controls) || !sameNativeSettingsScope(controls.scope, input.confirmedScope) || !object(controls.model?.current)
    || !label(input.effectiveModel, 512) || input.effectiveReasoningEffort !== null && !label(input.effectiveReasoningEffort, 128)
    || controls.model.current.model !== input.effectiveModel || controls.model.current.reasoningEffort !== input.effectiveReasoningEffort) return null;
  return { version: 1, expectedScope: nativeSettingsScope(input.expectedScope), confirmedScope: nativeSettingsScope(input.confirmedScope),
    modelAckConfirmed: true, effortAckConfirmed: true, effectiveModel: input.effectiveModel, effectiveReasoningEffort: input.effectiveReasoningEffort };
}
