/** CodeLight's portable channel contract; no credentials or IO live here. */
export const CHANNEL_KINDS = Object.freeze(['local', 'cloudflare', 'relay']);
export function isPrivateHost(host) {
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}
export function channelOrigin(value, kind) {
  const url = new URL(value);
  if (!CHANNEL_KINDS.includes(kind) || url.username || url.password || url.search || url.hash
    || url.protocol !== 'https:' && !(url.protocol === 'http:' && kind === 'local' && isPrivateHost(url.hostname))) throw Error('invalid-channel-origin');
  const path = url.pathname.replace(/\/+$/, '');
  if (path && !/^\/r\/[a-f0-9]{24}$/.test(path)) throw Error('invalid-channel-prefix');
  return url.origin + path;
}
export function channelList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw Error('invalid-channel-list');
  const ids = new Set(), origins = new Set();
  return value.map(row => {
    if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id)
      || !CHANNEL_KINDS.includes(row.kind) || typeof row.url !== 'string') throw Error('invalid-channel');
    const url = channelOrigin(row.url, row.kind);
    if (ids.has(row.id) || origins.has(url)) throw Error('duplicate-channel');
    ids.add(row.id); origins.add(url);
    return { id: row.id, kind: row.kind, url, ...(typeof row.label === 'string' ? { label: row.label.slice(0, 80) } : {}) };
  });
}
export function channelPath(origin, requestUrl) {
  const base = new URL(origin), url = new URL(requestUrl, origin + '/');
  if (url.origin !== base.origin || !(url.pathname === base.pathname || url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/'))) throw Error('foreign-channel-request');
  return url.pathname.slice(base.pathname.replace(/\/$/, '').length) || '/';
}
export function peerMaterial(macKey, secret) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(macKey) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw Error('invalid-peer-key');
  return 'CodeLight peer v2\n' + macKey + '\n' + secret;
}
export function rpcTarget(method, params = {}) {
  const key = method === 'codex-controls-update' && params.expectedScope?.app === 'claude-desktop'
    ? ['settings', ...['appMode', 'nativeCollection', 'nativeConversationId', 'hostId', 'ownerGeneration', 'runtimeGeneration', 'queryToken', 'cliSessionId', 'settingsToken'].map(name => params.expectedScope[name] ?? null)]
    : method === 'native-task-stop' && typeof params.taskId === 'string' ? ['task', params.taskId, params.scope?.queryToken ?? null]
    : typeof params.id === 'string' ? ['request', params.id]
    : typeof params.queryToken === 'string' ? ['query', params.queryToken]
      : typeof params.turnId === 'string' ? ['turn', params.turnId]
      : typeof params.sourceKey === 'string' ? ['source', params.sourceKey] : ['entity'];
  return JSON.stringify([method, ...key]);
}

/** Visible native tool JSON is independent of attachment marker parameters. */
export const NATIVE_TOOL_INPUT_MAX_BYTES = 64 * 1024;
function nativeToolInputJson(value) {
  let count = 0;
  const seen = new Set();
  function valid(item, depth) {
    if (++count > 2048 || depth > 12) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= NATIVE_TOOL_INPUT_MAX_BYTES;
    if (!item || typeof item !== 'object' || seen.has(item) || Object.getOwnPropertySymbols(item).length) return false;
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    seen.add(item);
    const properties = Object.getOwnPropertyDescriptors(item);
    for (const [key, property] of Object.entries(properties)) {
      if (array && key === 'length') continue;
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) return false;
      if (key.length > 512 || ['__proto__', 'prototype', 'constructor'].includes(key) || property.get || property.set || !valid(property.value, depth + 1)) return false;
    }
    seen.delete(item); return true;
  }
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !valid(value, 0)) return null;
    const encoded = JSON.stringify(value);
    return new TextEncoder().encode(encoded).byteLength <= NATIVE_TOOL_INPUT_MAX_BYTES ? encoded : null;
  } catch { return null; }
}
export function isNativeToolInput(value) { return nativeToolInputJson(value) !== null; }
export function projectNativeToolInput(value) {
  const encoded = nativeToolInputJson(value);
  return encoded === null ? { inputUnavailable: true } : { input: JSON.parse(encoded) };
}
