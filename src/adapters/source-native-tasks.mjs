import { createHash } from 'node:crypto';
import { nativeTaskDigestText } from '@codelync/wire/native-tasks';

/** @typedef {Record<string,any>} Value */
const COLLECTIONS = new Set(['claude-code-sessions', 'local-agent-mode-sessions']);
const TASK_STATUSES = new Set(['pending', 'running', 'paused', 'completed', 'failed', 'stopped', 'unknown']);
const CHILD_STATUSES = new Set(['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'stopped', 'unknown']);
const KINDS = new Set(['agent', 'shell', 'workflow', 'remote-agent', 'other']);
const SCOPE_KEYS = ['app', 'nativeCollection', 'parentConversationId', 'hostId', 'ownerGeneration', 'runtimeGeneration', 'queryToken', 'cliSessionId'];
/** @param {unknown} value @returns {value is Value} */
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @param {number} [max] */
const label = (value, max = 512) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
/** @param {Value} value */
const withDigest = value => ({ ...value, digest: createHash('sha256').update(nativeTaskDigestText(value)).digest('hex') });

/** Compact only a current original backend projection. Scope is sent once;
 * private buffers and duplicate source fields never enter agentState.
 * @param {unknown} input @param {Value} source @param {string|null} epoch
 * @param {{runtimeGeneration:string|null,queryToken:string|null,current:boolean}} context
 * @returns {Value|null} */
export function sourceNativeTasks(input, source, epoch, context) {
  if (!record(input) || input.version !== 1 || !record(input.scope) || source.app !== 'claude-desktop') return null;
  const incoming = input.scope;
  if (!label(epoch, 2048) || !label(context.runtimeGeneration, 2048) || !COLLECTIONS.has(source.nativeCollection)
    || incoming.app !== source.app || incoming.nativeCollection !== source.nativeCollection || incoming.parentConversationId !== source.id
    || incoming.hostId !== source.hostId || incoming.ownerGeneration !== epoch || incoming.runtimeGeneration !== context.runtimeGeneration
    || incoming.queryToken !== context.queryToken || incoming.queryToken !== null && !label(incoming.queryToken, 512)
    || incoming.cliSessionId !== null && !label(incoming.cliSessionId, 512)) return null;
  const scope = Object.fromEntries(SCOPE_KEYS.map(key => [key, incoming[key]]));
  let invalidTasks = !Array.isArray(input.tasks), invalidChildren = !Array.isArray(input.dispatchChildren);
  const taskOverflow = Array.isArray(input.tasks) && input.tasks.length > 128;
  const childOverflow = Array.isArray(input.dispatchChildren) && input.dispatchChildren.length > 128;
  const tasksAvailable = context.current && scope.queryToken !== null && input.tasksAvailable === true && !invalidTasks;
  const dispatchChildrenAvailable = context.current && input.dispatchChildrenAvailable === true && !invalidChildren;
  const tasks = [], dispatchChildren = [], taskIds = new Set(), childIds = new Set();
  for (const row of (Array.isArray(input.tasks) ? input.tasks : []).slice(0, 128)) {
    if (!record(row) || row.relationship !== 'native-sdk-task' || !SCOPE_KEYS.every(key => row[key] === scope[key])
      || !label(row.nativeTaskId, 256) || !label(row.name, 160) || !label(row.taskType, 64) || !KINDS.has(row.kind)
      || taskIds.has(row.nativeTaskId)) { invalidTasks = true; continue; }
    taskIds.add(row.nativeTaskId);
    const known = TASK_STATUSES.has(row.status);
    if (!known) invalidTasks = true;
    tasks.push({ nativeTaskId: row.nativeTaskId, name: row.name, taskType: row.taskType, kind: row.kind,
      status: tasksAvailable && known ? row.status : 'unknown', isBackgrounded: typeof row.isBackgrounded === 'boolean' ? row.isBackgrounded : null,
      statusSource: tasksAvailable ? label(row.statusSource, 64) ?? 'native-task-lifecycle' : 'unavailable-native-observation',
      ...(label(row.agentId, 256) ? { agentId: row.agentId } : {}) });
  }
  for (const row of (Array.isArray(input.dispatchChildren) ? input.dispatchChildren : []).slice(0, 128)) {
    const key = record(row) ? JSON.stringify([row.nativeCollection, row.hostId, row.nativeConversationId]) : null;
    if (!record(row) || row.relationship !== 'native-subagent' || row.app !== scope.app || row.runtimeGeneration !== scope.runtimeGeneration
      || row.parentConversationId !== scope.parentConversationId || row.parentHostId !== scope.hostId
      || row.parentOwnerGeneration !== scope.ownerGeneration || row.parentNativeCollection !== scope.nativeCollection
      || !COLLECTIONS.has(row.nativeCollection) || !label(row.hostId, 256) || !label(row.ownerGeneration, 2048)
      || !label(row.nativeConversationId) || row.nativeConversationId === scope.parentConversationId || !label(row.name, 160)
      || row.nativeCollection === scope.nativeCollection && row.hostId !== scope.hostId || childIds.has(key)) { invalidChildren = true; continue; }
    childIds.add(key);
    const known = CHILD_STATUSES.has(row.status);
    if (!known) invalidChildren = true;
    dispatchChildren.push({ nativeConversationId: row.nativeConversationId, name: row.name, nativeCollection: row.nativeCollection,
      hostId: row.hostId, ownerGeneration: row.ownerGeneration, status: dispatchChildrenAvailable && known ? row.status : 'unknown',
      statusSource: dispatchChildrenAvailable ? label(row.statusSource, 64) ?? 'native-collection-header' : 'unavailable-native-observation' });
  }
  const tasksTruncated = taskOverflow || input.tasksTruncated === true, dispatchChildrenTruncated = childOverflow || input.dispatchChildrenTruncated === true;
  const tasksComplete = tasksAvailable && input.tasksComplete === true && !invalidTasks && !tasksTruncated;
  const dispatchChildrenComplete = dispatchChildrenAvailable && input.dispatchChildrenComplete === true && !invalidChildren && !dispatchChildrenTruncated;
  return withDigest({ version: 1, scope, tasks, tasksAvailable, tasksComplete,
    backgroundTasksComplete: tasksAvailable && input.backgroundTasksComplete === true && !invalidTasks && !tasksTruncated, tasksTruncated,
    dispatchChildren, dispatchChildrenAvailable, dispatchChildrenComplete, dispatchChildrenTruncated,
    partial: !tasksComplete || !dispatchChildrenComplete });
}

/** Publish verified task-type controls only for the exact selected envelope.
 * The native scope stays private here because the selected signal carries it.
 * @param {unknown} input @param {Value|null} tasks @returns {Value|null} */
export function sourceNativeTaskControls(input, tasks) {
  if (!record(input) || input.version !== 1 || !record(input.scope) || !tasks?.tasksAvailable
    || !SCOPE_KEYS.every(key => input.scope[key] === tasks.scope[key])) return null;
  const types = (/** @type {unknown} */ value) => Array.isArray(value) && value.length <= 8
    && value.every(type => typeof type === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(type)) && new Set(value).size === value.length ? [...value] : null;
  const outputTaskTypes = types(input.outputTaskTypes), stopTaskTypes = types(input.stopTaskTypes);
  if (!outputTaskTypes || !stopTaskTypes) return null;
  return { version: 1, outputTaskTypes, stopTaskTypes };
}

/** A current sanitized envelope contributes parent attention only, never a turn.
 * @param {Value|null} value @returns {Value|null} */
export function nativeTaskActivity(value) {
  if (!value) return null;
  const taskRows = value.tasksAvailable ? value.tasks : [], childRows = value.dispatchChildrenAvailable ? value.dispatchChildren : [];
  const active = taskRows.some((/** @type {Value} */ row) => ['pending', 'running', 'waiting', 'paused'].includes(row.status))
    || childRows.some((/** @type {Value} */ row) => ['pending', 'running', 'waiting', 'paused'].includes(row.status));
  // A native paused task remains nonterminal activity; it does not establish
  // a permission request or a need for human input.
  const waiting = [...taskRows, ...childRows].some((/** @type {Value} */ row) => row.status === 'waiting');
  return { app: value.scope.app, parentConversationId: value.scope.parentConversationId, hostId: value.scope.hostId,
    ownerGeneration: value.scope.ownerGeneration, active, waiting, taskCount: value.tasks.length, dispatchChildCount: value.dispatchChildren.length,
    unknownTasks: value.tasks.filter((/** @type {Value} */ row) => row.status === 'unknown').length,
    unknownDispatchChildren: value.dispatchChildren.filter((/** @type {Value} */ row) => row.status === 'unknown').length,
    rosterAvailable: value.tasksAvailable && value.dispatchChildrenAvailable,
    rosterComplete: value.tasksComplete && value.dispatchChildrenComplete };
}
