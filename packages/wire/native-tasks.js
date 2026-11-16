/** Portable native-task data contract. No IO, credentials or model operations. */
export const NATIVE_TASK_SNAPSHOT_MAX_BYTES = 512 * 1024;
const flags = ['tasksAvailable', 'tasksComplete', 'backgroundTasksComplete', 'tasksTruncated',
  'dispatchChildrenAvailable', 'dispatchChildrenComplete', 'dispatchChildrenTruncated', 'partial'];
const scopes = ['app', 'nativeCollection', 'hostId', 'parentConversationId', 'ownerGeneration', 'runtimeGeneration', 'queryToken', 'cliSessionId'];
const collections = new Set(['claude-code-sessions', 'local-agent-mode-sessions']);
const taskStatuses = new Set(['pending', 'running', 'paused', 'completed', 'failed', 'stopped', 'unknown']);
const childStatuses = new Set(['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'stopped', 'unknown']);
const kinds = new Set(['agent', 'shell', 'workflow', 'remote-agent', 'other']);
const fail = () => { throw Error('invalid-native-task-transfer'); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const label = (value, max = 512) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
function safe(value, depth = 0, counter = { n: 0 }) {
  if (++counter.n > 16384 || depth > 12) fail();
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!object(value) && !Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
  if (Object.getOwnPropertySymbols(value).length) fail();
  const properties = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(properties)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) fail();
    if (['__proto__', 'prototype', 'constructor'].includes(key) || descriptor.get || descriptor.set) fail();
    if (descriptor.value !== undefined) safe(descriptor.value, depth + 1, counter);
  }
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
}
function scopeValid(scope) {
  return object(scope) && scope.app === 'claude-desktop' && collections.has(scope.nativeCollection)
    && label(scope.hostId, 256) && label(scope.parentConversationId)
    && ['ownerGeneration', 'runtimeGeneration'].every(key => label(scope[key], 2048))
    && [scope.queryToken, scope.cliSessionId].every(value => value === null || label(value));
}
export function nativeTaskScopesEqual(a, b) { return scopeValid(a) && scopeValid(b) && scopes.every(key => a[key] === b[key]); }
export function nativeTaskDispatchKey(row) {
  if (!object(row) || !collections.has(row.nativeCollection) || !label(row.hostId, 256) || !label(row.nativeConversationId)) fail();
  return JSON.stringify([row.nativeCollection, row.hostId, row.nativeConversationId]);
}
function taskValid(row) {
  return object(row) && label(row.nativeTaskId, 256) && label(row.name, 160) && label(row.taskType, 64) && kinds.has(row.kind)
    && taskStatuses.has(row.status) && [true, false, null].includes(row.isBackgrounded) && label(row.statusSource, 64)
    && (row.agentId === undefined || row.agentId === null || label(row.agentId, 256))
    && (row.observedEventAt === undefined || row.observedEventAt === null || label(row.observedEventAt, 80));
}
function childValid(row, scope) {
  return object(row) && label(row.name, 160) && collections.has(row.nativeCollection) && label(row.nativeConversationId)
    && row.nativeConversationId !== scope.parentConversationId && label(row.hostId, 256) && label(row.ownerGeneration, 2048)
    && (row.nativeCollection !== scope.nativeCollection || row.hostId === scope.hostId) && childStatuses.has(row.status) && label(row.statusSource, 64);
}
function coverageValid(value) {
  return flags.every(key => typeof value[key] === 'boolean')
    && (!value.tasksComplete || value.tasksAvailable && !value.tasksTruncated)
    && (!value.backgroundTasksComplete || value.tasksAvailable && !value.tasksTruncated)
    && (!value.dispatchChildrenComplete || value.dispatchChildrenAvailable && !value.dispatchChildrenTruncated)
    && value.partial === (!value.tasksComplete || !value.dispatchChildrenComplete);
}
function snapshotValid(value, requireDigest = false) {
  safe(value);
  if (!object(value) || value.version !== 1 || !scopeValid(value.scope) || !coverageValid(value)
    || !Array.isArray(value.tasks) || !Array.isArray(value.dispatchChildren) || value.tasks.length > 128 || value.dispatchChildren.length > 128
    || !value.tasks.every(taskValid) || !value.dispatchChildren.every(row => childValid(row, value.scope))
    || new Set(value.tasks.map(row => row.nativeTaskId)).size !== value.tasks.length
    || new Set(value.dispatchChildren.map(nativeTaskDispatchKey)).size !== value.dispatchChildren.length
    || (requireDigest || value.digest !== undefined) && !hash(value.digest)
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > NATIVE_TASK_SNAPSHOT_MAX_BYTES) fail();
  return value;
}
/** Canonical SHA256 input; callers use their platform's existing SHA256. */
export function nativeTaskDigestText(value) {
  safe(value);
  const snapshot = { version: value.version, scope: value.scope, tasks: value.tasks, dispatchChildren: value.dispatchChildren,
    ...Object.fromEntries(flags.map(key => [key, value[key]])) };
  return JSON.stringify(canonical(snapshot));
}
export function nativeTaskSignal(value) {
  snapshotValid(value, true);
  return { version: 1, scope: clone(value.scope), digest: value.digest, taskCount: value.tasks.length, dispatchChildCount: value.dispatchChildren.length,
    ...Object.fromEntries(flags.map(key => [key, value[key]])) };
}
function signalValid(value) {
  return object(value) && value.version === 1 && scopeValid(value.scope) && hash(value.digest) && coverageValid(value)
    && ['taskCount', 'dispatchChildCount'].every(key => Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 128);
}
function patchRows(base, upserts, removed, order, keyOf, valid) {
  if (!Array.isArray(upserts) || !Array.isArray(removed) || upserts.length > 128 || removed.length > 128 || !upserts.every(valid)) fail();
  const upsertKeys = upserts.map(keyOf), keys = base.map(keyOf);
  if (new Set(upsertKeys).size !== upsertKeys.length || new Set(removed).size !== removed.length
    || removed.some(key => !keys.includes(key) || upsertKeys.includes(key))) fail();
  const rows = new Map(base.map(row => [keyOf(row), row]));
  for (const key of removed) rows.delete(key);
  for (const row of upserts) rows.set(keyOf(row), row);
  if (rows.size > 128) fail();
  if (order !== undefined) {
    if (!Array.isArray(order) || order.length !== rows.size || new Set(order).size !== order.length || order.some(key => !rows.has(key))) fail();
    return order.map(key => rows.get(key));
  }
  return [...rows.values()];
}
/** Structural/identity validation before atomic client promotion. Verify digest
 * with nativeTaskDigestText after this function, before publishing. */
export function nativeTaskTransferApply(base, response) {
  safe(response);
  if (!response?.kind) return clone(snapshotValid(response));
  if (!signalValid(response)) fail();
  snapshotValid(base, true);
  if (!nativeTaskScopesEqual(base.scope, response.scope)) fail();
  if (response.kind === 'native-task-unchanged') {
    if (base.digest !== response.digest || response.taskCount !== base.tasks.length || response.dispatchChildCount !== base.dispatchChildren.length
      || flags.some(key => response[key] !== base[key])) fail();
    return clone(base);
  }
  if (response.kind !== 'native-task-delta' || response.baseDigest !== base.digest) fail();
  const tasks = patchRows(base.tasks, response.taskUpserts, response.taskRemovedIds, response.taskOrder, row => row.nativeTaskId, taskValid);
  const dispatchChildren = patchRows(base.dispatchChildren, response.dispatchUpserts, response.dispatchRemovedKeys, response.dispatchOrder,
    nativeTaskDispatchKey, row => childValid(row, response.scope));
  if (tasks.length !== response.taskCount || dispatchChildren.length !== response.dispatchChildCount) fail();
  return clone(snapshotValid({ version: 1, scope: response.scope, digest: response.digest, tasks, dispatchChildren,
    ...Object.fromEntries(flags.map(key => [key, response[key]])) }, true));
}
function rowDelta(base, target, keyOf) {
  const previous = new Map(base.map(row => [keyOf(row), row])), next = new Set(target.map(keyOf));
  const upserts = target.filter(row => !previous.has(keyOf(row)) || JSON.stringify(canonical(previous.get(keyOf(row)))) !== JSON.stringify(canonical(row)));
  const removed = [...previous.keys()].filter(key => !next.has(key));
  const defaultOrder = base.map(keyOf).filter(key => next.has(key));
  for (const row of upserts) if (!previous.has(keyOf(row))) defaultOrder.push(keyOf(row));
  const order = target.map(keyOf);
  return { upserts, removed, ...(JSON.stringify(order) !== JSON.stringify(defaultOrder) ? { order } : {}) };
}
/** Requires a real materialized baseline; digest-only hints are never enough. */
export function nativeTaskTransfer(base, target) {
  snapshotValid(target, true);
  if (!base || !nativeTaskScopesEqual(base.scope, target.scope)) return clone(target);
  snapshotValid(base, true);
  const signal = nativeTaskSignal(target);
  if (base.digest === target.digest) return { ...signal, kind: 'native-task-unchanged' };
  const tasks = rowDelta(base.tasks, target.tasks, row => row.nativeTaskId), children = rowDelta(base.dispatchChildren, target.dispatchChildren, nativeTaskDispatchKey);
  const delta = { ...signal, kind: 'native-task-delta', baseDigest: base.digest, taskUpserts: tasks.upserts, taskRemovedIds: tasks.removed,
    dispatchUpserts: children.upserts, dispatchRemovedKeys: children.removed,
    ...(tasks.order ? { taskOrder: tasks.order } : {}), ...(children.order ? { dispatchOrder: children.order } : {}) };
  return new TextEncoder().encode(JSON.stringify(delta)).byteLength < new TextEncoder().encode(JSON.stringify(target)).byteLength ? clone(delta) : clone(target);
}
