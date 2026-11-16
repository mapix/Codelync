/** @typedef {Record<string,any>} Value */
const METHODS = Object.freeze({
  code: new Set(['getSession', 'getTranscriptTail', 'getTranscriptPage', 'getTaskOutput', 'stopTask', 'sendMessage', 'interrupt', 'respondToToolPermission', 'setModel', 'setEffort']),
  cowork: new Set(['getSession', 'getTranscript', 'sendMessage', 'stop']),
});
const failure = (/** @type {string} */ code, effect = false) => Object.assign(Error(code), { effectMayHaveOccurred: effect });

/** Serialize only the bridge's fixed native call arguments, retaining undefined.
 * @param {unknown} value @returns {string} */
function argument(value) {
  if (value === undefined) return 'void 0';
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(argument).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.entries(value).map(([key, field]) => JSON.stringify(key) + ':' + argument(field)).join(',') + '}';
  }
  throw failure('invalid-native-arguments');
}

/** Use the original trusted renderer's pre-existing native IPC API. This never
 * initializes vendor factories, installs renderer code/listeners or changes input.
 * @param {Value} webContents @param {'code'|'cowork'} kind @returns {Value} */
export function existingClaudeRendererApi(webContents, kind) {
  const allowed = METHODS[kind];
  if (!allowed) throw failure('unsupported-native-mode');
  /** @type {Value} */ const api = {};
  for (const method of allowed) api[method] = async (/** @type {unknown[]} */ ...args) => {
    if (webContents.isDestroyed()) throw failure('native-window-unavailable');
    let location;
    try { location = new URL(webContents.getURL()); } catch { throw failure('native-window-unavailable'); }
    if (location.protocol !== 'app:' || location.hostname !== 'localhost') throw failure('native-window-unavailable');
    const name = kind === 'code' ? 'LocalSessions' : 'LocalAgentModeSessions';
    const expression = `(async()=>{if(location.protocol!=='app:'||location.hostname!=='localhost')return {version:1,ok:false,code:'native-window-unavailable',effectMayHaveOccurred:false};const api=window['claude.web']?.[${JSON.stringify(name)}];if(typeof api?.[${JSON.stringify(method)}]!=='function')return {version:1,ok:false,code:'native-renderer-unavailable',effectMayHaveOccurred:false};try{return {version:1,ok:true,value:await api[${JSON.stringify(method)}](${args.map(argument).join(',')})};}catch{return {version:1,ok:false,code:'native-renderer-operation-failed',effectMayHaveOccurred:true};}})()`;
    const result = await webContents.mainFrame.executeJavaScript(expression);
    if (!result || result.version !== 1 || typeof result.ok !== 'boolean') throw failure('native-renderer-response-invalid', true);
    if (!result.ok) throw failure(['native-window-unavailable', 'native-renderer-unavailable', 'native-renderer-operation-failed'].includes(result.code) ? result.code : 'native-renderer-response-invalid', result.effectMayHaveOccurred !== false);
    return result.value;
  };
  return Object.freeze(api);
}
