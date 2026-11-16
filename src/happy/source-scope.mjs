/** @typedef {Record<string,any>} Value */

/** @param {unknown} value @returns {value is Value} */
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** Product scope only; native owner, identity and lease checks remain separate.
 * @param {unknown} source @param {unknown} [metadata] */
export function isCodeLightCodexSource(source, metadata) {
  if (!record(source) || source.app !== 'codex' || source.kind === 'window') return false;
  const value = record(metadata) ? metadata : {};
  const bridgeMode = record(value.bridge) ? value.bridge.controlMode : undefined;
  // 旧记录未声明 mode 时保留原生回退；显式非 session 值不能被恢复为 Codex 支持。
  return (bridgeMode === undefined || bridgeMode === 'session') &&
    (value.controlMode === undefined || value.controlMode === 'session');
}

/** Antigravity has no historical window or missing-protocol fallback.
 * @param {unknown} source @param {unknown} [metadata] */
export function isCodeLightAntigravitySource(source, metadata) {
  if (!record(source) || source.app !== 'antigravity' || source.kind === 'window' ||
      source.protocol !== 'antigravity-connect' || typeof source.runtimeGeneration !== 'string' || !source.runtimeGeneration.trim() ||
      typeof source.hostId !== 'string' || !/^local:antigravity:[a-f0-9]{64}$/.test(source.hostId)) return false;
  const value = record(metadata) ? metadata : {};
  const bridge = record(value.bridge) ? value.bridge : {};
  const mode = bridge.controlMode ?? value.controlMode ?? (source.kind === 'session' ? 'session' : undefined);
  return mode === 'session' && (bridge.controlMode === undefined || bridge.controlMode === 'session') &&
    (value.controlMode === undefined || value.controlMode === 'session');
}

/** Explicit native Claude collection; neither cloud Chat nor windows qualify.
 * @param {unknown} source @param {unknown} [metadata] */
export function isCodeLightClaudeSource(source, metadata) {
  if (!record(source) || source.app !== 'claude-desktop' || source.kind !== 'session'
      || source.protocol !== 'claude-desktop-native' || typeof source.id !== 'string' || !source.id.trim()
      || typeof source.runtimeGeneration !== 'string' || !source.runtimeGeneration.trim()
      || typeof source.hostId !== 'string' || !/^local:claude-desktop:[a-f0-9]{64}$/.test(source.hostId)) return false;
  const collection = source.appMode === 'code' ? 'claude-code-sessions'
    : ['chat', 'cowork'].includes(source.appMode) ? 'local-agent-mode-sessions' : null;
  if (!collection || source.nativeCollection !== collection) return false;
  const value = record(metadata) ? metadata : {}, bridge = record(value.bridge) ? value.bridge : {};
  return (bridge.controlMode === undefined || bridge.controlMode === 'session')
    && (value.controlMode === undefined || value.controlMode === 'session');
}

/** Supported original desktop session sources; runtime/lease checks are separate.
 * @param {unknown} source @param {unknown} [metadata] */
export function isCodeLightNativeSource(source, metadata) {
  return isCodeLightCodexSource(source, metadata) || isCodeLightAntigravitySource(source, metadata) || isCodeLightClaudeSource(source, metadata);
}
