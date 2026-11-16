import { createHash } from 'node:crypto';

/** @typedef {Record<string,any>} Value */
export const CLAUDE_TASK_LIMITS = Object.freeze({ tasks: 128, children: 128, events: 512, logs: 512, seen: 1024, page: 100 });
const COLLECTIONS = new Set(['claude-code-sessions', 'local-agent-mode-sessions']);
const EVENTS = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification']);
const TERMINAL = new Set(['completed', 'failed', 'stopped']);
const STATUS = new Set(['pending', 'running', 'paused', 'completed', 'failed', 'stopped']);
/** @param {unknown} value @returns {value is Value} */
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @param {number} [max] */
const label = (value, max = 512) => typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]|Bearer\s/i.test(value) ? value : null;
/** @param {unknown} value */
const integer = value => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
/** @param {unknown} value */
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

/** @param {unknown} value @returns {Value|null} */
function scopeOf(value) {
  if (!record(value) || value.app !== 'claude-desktop' || !COLLECTIONS.has(value.nativeCollection)) return null;
  for (const key of ['parentConversationId', 'hostId', 'ownerGeneration', 'runtimeGeneration']) if (!label(value[key])) return null;
  if (value.queryToken !== null && !label(value.queryToken) || value.cliSessionId !== null && !label(value.cliSessionId)) return null;
  return { app: value.app, nativeCollection: value.nativeCollection, parentConversationId: value.parentConversationId,
    hostId: value.hostId, ownerGeneration: value.ownerGeneration, runtimeGeneration: value.runtimeGeneration,
    queryToken: value.queryToken, cliSessionId: value.cliSessionId };
}
/** @param {Value|null} scope */
const scopeKey = scope => scope ? digest(scope) : null;
/** Native child membership survives a parent query transition. @param {Value|null} a @param {Value|null} b */
const sameOwner = (a, b) => !!a && !!b && ['app', 'nativeCollection', 'parentConversationId', 'hostId', 'ownerGeneration', 'runtimeGeneration'].every(key => a[key] === b[key]);

/** A task kind is not a conversation relationship. @param {unknown} type */
export function claudeTaskKind(type) {
  return type === 'local_agent' ? 'agent' : type === 'local_bash' ? 'shell' : type === 'local_workflow' ? 'workflow'
    : type === 'remote_agent' ? 'remote-agent' : 'other';
}
/** @param {unknown} status */
const taskStatus = status => status === 'killed' ? 'stopped' : STATUS.has(/** @type {string} */ (status)) ? status : 'unknown';
/** @param {Value} event @param {Value} scope */
function sessionMatches(event, scope) {
  return event.session_id === undefined || label(event.session_id) !== null && scope.cliSessionId !== null && event.session_id === scope.cliSessionId;
}
/** Only visible identity/lifecycle metadata; never retain summary, output_file or tool input. @param {unknown} input @param {Value} scope @returns {Value|null} */
function taskEvent(input, scope) {
  if (!record(input) || input.type !== 'system' || !EVENTS.has(input.subtype) || !label(input.task_id, 256) || !sessionMatches(input, scope)) return null;
  if (input.ambient === true || input.task_type === 'dream') return null;
  const patch = record(input.patch) ? input.patch : {};
  const nativeStatus = input.subtype === 'task_notification' ? label(input.status, 64) : input.subtype === 'task_updated' ? label(patch.status, 64) : null;
  return { taskId: input.task_id, subtype: input.subtype, nativeEventId: label(input.uuid), taskType: label(input.task_type, 64),
    agentId: label(input.agent_id ?? input.agentId, 256), toolUseId: label(input.tool_use_id, 256), parentToolUseId: label(input.parent_tool_use_id, 256),
    isBackgrounded: typeof patch.is_backgrounded === 'boolean' ? patch.is_backgrounded : typeof input.is_backgrounded === 'boolean' ? input.is_backgrounded : null,
    nativeStatus, timestamp: label(input.timestamp, 80), name: label(input.description, 160) };
}
/** @param {Value} event @param {Value|null} previous @param {Value} scope @returns {Value} */
function applyEvent(event, previous, scope) {
  const type = event.taskType ?? previous?.taskType ?? 'unknown';
  let status = previous?.status ?? 'unknown';
  if (event.subtype === 'task_started') status = 'running';
  else if (event.subtype === 'task_notification') status = TERMINAL.has(event.nativeStatus) ? event.nativeStatus : 'unknown';
  else if (event.subtype === 'task_updated' && event.nativeStatus !== null) status = taskStatus(event.nativeStatus);
  return { ...previous, id: event.taskId, nativeTaskId: event.taskId, relationship: 'native-sdk-task', ...scope,
    taskType: type, kind: claudeTaskKind(type), name: event.name ?? previous?.name ?? type,
    status, nativeStatus: event.subtype === 'task_started' ? 'running' : event.nativeStatus ?? previous?.nativeStatus ?? null,
    isBackgrounded: event.isBackgrounded ?? previous?.isBackgrounded ?? null,
    agentId: event.agentId ?? previous?.agentId ?? null, toolUseId: event.toolUseId ?? previous?.toolUseId ?? null,
    parentToolUseId: event.parentToolUseId ?? previous?.parentToolUseId ?? null,
    nativeEventId: event.nativeEventId, observedEventAt: event.timestamp, statusSource: 'native-task-lifecycle' };
}
/** @param {Value} state @param {Value} event @param {Value} row */
function appendLog(state, event, row) {
  const sequence = ++state.logSequence;
  state.logs.push({ id: `claude-task-log:${state.scopeKey}:${sequence}`, identity: 'local-log', sequence,
    nativeEventId: event.nativeEventId, nativeTaskId: row.nativeTaskId, subtype: event.subtype, taskType: row.taskType,
    kind: row.kind, status: row.status, nativeStatus: row.nativeStatus, isBackgrounded: row.isBackgrounded, timestamp: event.timestamp });
  if (state.logs.length > CLAUDE_TASK_LIMITS.logs) { state.logs.shift(); state.logsTruncated = true; }
}
/** @param {Value} native @returns {string} */
function childStatus(native) {
  if (native.lifecycleState === 'running' || native.lifecycleState === 'stopping' || native.isRunning === true) return native.pendingPermissionCount > 0 ? 'waiting' : 'running';
  if (native.lifecycleState === 'initializing') return 'pending';
  if (native.lifecycleState === 'idle' || native.isRunning === false) return 'idle';
  return 'unknown';
}
/** Each child must bring original collection membership and its own source identity. @param {unknown} input @param {Value} parent @returns {Value|null} */
function dispatchChild(input, parent) {
  if (!record(input) || input.nativeCollectionVerified !== true || !sameOwner(scopeOf(input.parentScope), parent)) return null;
  const source = record(input.source) ? input.source : {}, native = record(input.nativeRecord) ? input.nativeRecord : {};
  if (source.app !== parent.app || !COLLECTIONS.has(source.nativeCollection) || source.runtimeGeneration !== parent.runtimeGeneration ||
    !label(source.id) || source.id !== native.sessionId || source.id === parent.parentConversationId || !label(source.hostId) || !label(source.ownerGeneration)) return null;
  if (source.nativeCollection === parent.nativeCollection && source.hostId !== parent.hostId) return null;
  if (native.isArchived === true || native.lifecycleState === 'archived' || native.dispatchParentOrigin === 'remote') return null;
  if (source.nativeCollection === 'claude-code-sessions' ? native.dispatchParentId !== parent.parentConversationId
    : native.sessionType !== 'dispatch_child' || native.parentSessionId !== parent.parentConversationId) return null;
  return { id: source.id, nativeConversationId: source.id, app: source.app, name: label(native.title, 160) ?? 'Claude child',
    relationship: 'native-subagent', nativeCollection: source.nativeCollection, hostId: source.hostId, ownerGeneration: source.ownerGeneration,
    runtimeGeneration: source.runtimeGeneration, parentConversationId: parent.parentConversationId, parentHostId: parent.hostId,
    parentNativeCollection: parent.nativeCollection, parentOwnerGeneration: parent.ownerGeneration, status: childStatus(native), statusSource: 'native-collection-header' };
}

/** Pure, bounded parent activity projection. `previous` is only a state returned by this function.
 * @param {Value} input @param {Value|null} [previous] @returns {Value} */
export function projectClaudeTasks(input, previous = null) {
  const scope = scopeOf(input.scope), observed = scopeOf(input.observedScope), key = scopeKey(scope);
  const keep = previous?.version === 1 && key !== null && previous.scopeKey === key;
  const keepChildren = previous?.version === 1 && sameOwner(scope, scopeOf(previous.scope));
  /** @type {Value} */ const state = { version: 1, scope, scopeKey: key, observationSequence: keep ? previous.observationSequence : null,
    tasks: keep ? previous.tasks.map((/** @type {Value} */ row) => ({ ...row })) : [],
    dispatchChildren: keepChildren ? previous.dispatchChildren.map((/** @type {Value} */ row) => ({ ...row })) : [],
    logs: keep ? previous.logs.map((/** @type {Value} */ row) => ({ ...row })) : [], logSequence: keep ? previous.logSequence : 0,
    seen: keep ? previous.seen.map((/** @type {Value} */ row) => ({ ...row })) : [], tasksTruncated: keep && previous.tasksTruncated === true, logsTruncated: keep && previous.logsTruncated === true,
    lastTasksComplete: keep && previous.lastTasksComplete === true, lastBackgroundComplete: keep && previous.lastBackgroundComplete === true };
  const coverage = record(input.coverage) ? input.coverage : {};
  const current = !!scope && key === scopeKey(observed) && input.connected === true && input.fresh === true && scope.queryToken !== null;
  const incomingSequence = integer(input.observationSequence) ? input.observationSequence : null;
  const replay = incomingSequence !== null && state.observationSequence !== null && incomingSequence < state.observationSequence;
  const duplicateBatch = incomingSequence !== null && state.observationSequence !== null && incomingSequence === state.observationSequence;
  const available = current && coverage.available === true && (input.events === undefined || Array.isArray(input.events));
  let invalid = false, overflow = Array.isArray(input.events) && input.events.length > CLAUDE_TASK_LIMITS.events;
  let backgroundComplete = false, foregroundComplete = false;
  /** @type {Map<string,Value>} */ const tasks = new Map(state.tasks.map((/** @type {Value} */ row) => [row.nativeTaskId, row]));
  /** @type {Set<string>} */ const currentLevelTasks = new Set();
  /** @type {Map<string,Value>} */ const seen = new Map(state.seen.map((/** @type {Value} */ row) => [row.id, row]));
  /** @type {Value|null} */ let level = null;
  if (available && !replay && scope) {
    for (const [id, row] of tasks) if (['native-background-level', 'native-foreground-level'].includes(row.statusSource) && !TERMINAL.has(row.status)) {
      tasks.set(id, { ...row, status: 'unknown' });
    }
    for (const native of (input.events ?? []).slice(-CLAUDE_TASK_LIMITS.events)) {
      if (duplicateBatch) continue;
      if (record(native) && native.type === 'system' && native.subtype === 'background_tasks_changed') { level = native; continue; }
      if (!record(native) || native.type !== 'system' || !EVENTS.has(native.subtype)) continue;
      if (native.ambient === true || native.task_type === 'dream') continue;
      const event = taskEvent(native, scope);
      if (!event) { invalid = true; continue; }
      const eventKey = event.nativeEventId ?? `local:${digest(event)}`;
      const eventDigest = digest(event), prior = seen.get(eventKey);
      if (prior) {
        if (prior.digest !== eventDigest) {
          invalid = true;
          for (const id of [prior.taskId, event.taskId]) if (tasks.has(id)) tasks.set(id, { ...tasks.get(id), status: 'unknown', statusSource: 'conflicting-native-event' });
        }
        continue;
      }
      const remembered = { id: eventKey, digest: eventDigest, taskId: event.taskId };
      seen.set(eventKey, remembered); state.seen.push(remembered);
      if (state.seen.length > CLAUDE_TASK_LIMITS.seen) { state.seen.shift(); overflow = true; }
      const row = applyEvent(event, tasks.get(event.taskId) ?? null, scope);
      tasks.delete(event.taskId); tasks.set(event.taskId, row); appendLog(state, event, row);
    }
    if (input.level !== undefined) level = record(input.level) ? input.level : null;
    if (input.level !== undefined && !level) invalid = true;
    if (level) {
      const validEnvelope = level.type === 'system' && level.subtype === 'background_tasks_changed' && sessionMatches(level, scope) && Array.isArray(level.tasks);
      if (!validEnvelope) invalid = true;
      else {
        /** @type {Set<string>} */ const active = new Set();
        let badLevel = level.tasks.length > CLAUDE_TASK_LIMITS.tasks;
        for (const native of level.tasks.slice(0, CLAUDE_TASK_LIMITS.tasks)) {
          if (record(native) && (native.ambient === true || native.task_type === 'dream')) continue;
          if (!record(native) || !label(native.task_id, 256) || !label(native.task_type, 64) || active.has(native.task_id)) { badLevel = true; continue; }
          active.add(native.task_id);
          currentLevelTasks.add(native.task_id);
          const old = tasks.get(native.task_id) ?? null;
          const row = applyEvent({ taskId: native.task_id, taskType: native.task_type, subtype: 'background_tasks_changed',
            nativeEventId: label(level.uuid), nativeStatus: null, isBackgrounded: true, timestamp: label(level.timestamp, 80), name: null }, old, scope);
          row.status = native.status === undefined ? 'running' : taskStatus(native.status);
          row.nativeStatus = label(native.status, 64); row.statusSource = 'native-background-level';
          tasks.set(native.task_id, row);
        }
        backgroundComplete = coverage.levelComplete === true && !badLevel;
        if (backgroundComplete) for (const [id, row] of tasks) if (row.isBackgrounded === true && !active.has(id) && !TERMINAL.has(row.status)) {
          tasks.set(id, { ...row, status: 'unknown', isBackgrounded: null, statusSource: 'native-background-absence' });
        }
        invalid ||= badLevel; overflow ||= level.tasks.length > CLAUDE_TASK_LIMITS.tasks;
      }
    }
    if (input.foregroundLevel !== undefined && input.foregroundLevel !== null) {
      const foreground = input.foregroundLevel;
      if (!record(foreground) || !Array.isArray(foreground.tasks)) invalid = true;
      else if (foreground.available === true) {
        /** @type {Set<string>} */ const active = new Set();
        let badLevel = foreground.tasks.length > CLAUDE_TASK_LIMITS.tasks;
        for (const native of foreground.tasks.slice(0, CLAUDE_TASK_LIMITS.tasks)) {
          if (record(native) && (native.ambient === true || native.task_type === 'dream')) continue;
          if (!record(native) || !label(native.task_id, 256) || !label(native.task_type, 64) || active.has(native.task_id)) { badLevel = true; continue; }
          active.add(native.task_id);
          currentLevelTasks.add(native.task_id);
          const old = tasks.get(native.task_id) ?? null;
          const row = applyEvent({ taskId: native.task_id, taskType: native.task_type, subtype: 'foreground_tasks_level',
            nativeEventId: null, nativeStatus: null, isBackgrounded: false, timestamp: null, name: null }, old, scope);
          row.status = native.status === undefined ? 'running' : taskStatus(native.status);
          row.nativeStatus = label(native.status, 64); row.statusSource = 'native-foreground-level';
          tasks.set(native.task_id, row);
        }
        foregroundComplete = coverage.foregroundComplete === true && foreground.complete === true && !badLevel;
        if (foregroundComplete) for (const [id, row] of tasks) if (row.isBackgrounded === false && !active.has(id) && !TERMINAL.has(row.status)) {
          tasks.set(id, { ...row, status: 'unknown', isBackgrounded: null, statusSource: 'native-foreground-absence' });
        }
        invalid ||= badLevel; overflow ||= foreground.tasks.length > CLAUDE_TASK_LIMITS.tasks;
      }
    }
    if (foregroundComplete && backgroundComplete) for (const [id, row] of tasks) if (!currentLevelTasks.has(id) && !TERMINAL.has(row.status)) {
      tasks.set(id, { ...row, status: 'unknown', isBackgrounded: null, statusSource: 'native-task-absence' });
    }
    if (incomingSequence !== null) state.observationSequence = incomingSequence;
  }
  if (tasks.size > CLAUDE_TASK_LIMITS.tasks) state.tasksTruncated = true;
  state.tasksTruncated ||= overflow;
  state.tasks = [...tasks.values()].slice(-CLAUDE_TASK_LIMITS.tasks);
  const childAvailable = !!scope && sameOwner(scope, observed) && input.connected === true && input.fresh === true && coverage.dispatchAvailable === true && Array.isArray(input.dispatchChildren);
  let childInvalid = false, childOverflow = false;
  if (childAvailable && scope) {
    /** @type {Map<string,Value>} */ const children = new Map();
    childOverflow = input.dispatchChildren.length > CLAUDE_TASK_LIMITS.children;
    for (const native of input.dispatchChildren.slice(0, CLAUDE_TASK_LIMITS.children)) {
      const child = dispatchChild(native, scope);
      if (!child) { childInvalid = true; continue; }
      const childKey = digest([child.nativeCollection, child.hostId, child.nativeConversationId]);
      if (children.has(childKey)) { childInvalid = true; continue; }
      children.set(childKey, child);
    }
    if (coverage.dispatchComplete === true && !childInvalid && !childOverflow) state.dispatchChildren = [...children.values()];
    else {
      for (const child of state.dispatchChildren) {
        const childKey = digest([child.nativeCollection, child.hostId, child.nativeConversationId]);
        if (!children.has(childKey)) children.set(childKey, { ...child, status: 'unknown' });
      }
      childOverflow ||= children.size > CLAUDE_TASK_LIMITS.children;
      state.dispatchChildren = [...children.values()].slice(0, CLAUDE_TASK_LIMITS.children);
    }
  }
  const publicTasks = state.tasks.map((/** @type {Value} */ row) => ({ ...row, status: available && !replay ? row.status : 'unknown' }));
  const publicChildren = state.dispatchChildren.map((/** @type {Value} */ row) => ({ ...row, status: childAvailable ? row.status : 'unknown' }));
  const complete = available && !replay && (coverage.lifecycleComplete === true || foregroundComplete && backgroundComplete) && !invalid && !overflow && !state.tasksTruncated;
  const levelComplete = available && !replay && backgroundComplete;
  if (available && !replay) { state.lastTasksComplete = complete; state.lastBackgroundComplete = levelComplete; }
  return { tasks: publicTasks, tasksAvailable: available, tasksComplete: complete,
    tasksTruncated: overflow || state.tasksTruncated, backgroundTasksComplete: levelComplete,
    dispatchChildren: publicChildren, dispatchChildrenAvailable: childAvailable,
    dispatchChildrenComplete: childAvailable && coverage.dispatchComplete === true && !childInvalid && !childOverflow,
    dispatchChildrenTruncated: childOverflow, logs: state.logs.map((/** @type {Value} */ row) => ({ ...row })), logsTruncated: state.logsTruncated,
    observationRejected: !scope || !sameOwner(scope, observed) || key !== scopeKey(observed) || replay,
    partial: !complete, state };
}

/** Bounded local metadata log read; no native transcript or operation fetch.
 * @param {Value} state @param {{scope:Value,taskId?:string|null,before?:string|null,limit?:number}} options @returns {Value} */
export function readClaudeTaskLogPage(state, options) {
  const scope = scopeOf(options.scope), key = scopeKey(scope), taskId = options.taskId ?? null;
  /** @param {string} status */ const fail = status => ({ status, available: false, logs: [], hasMore: null, nextCursor: null });
  if (state.version !== 1 || !key || key !== state.scopeKey) return fail('scope-mismatch');
  if (taskId !== null && !label(taskId, 256)) return fail('invalid-task');
  if (taskId !== null && !state.tasks.some((/** @type {Value} */ row) => row.nativeTaskId === taskId)) return fail('task-not-found');
  const filter = digest(taskId), requested = options.before ?? null;
  let end = state.logSequence + 1;
  if (requested !== null) {
    if (typeof requested !== 'string' || requested.length > 256) return fail('invalid-cursor');
    const match = /^ct1\.([a-f0-9]{32})\.(\d{1,16})\.([a-f0-9]{32})\.(\d{1,16})$/.exec(requested);
    if (!match) return fail('invalid-cursor');
    if (match[1] !== key || match[3] !== filter) return fail('scope-mismatch');
    end = Number(match[2]);
    if (!integer(end) || !integer(Number(match[4])) || end > Number(match[4]) || Number(match[4]) > state.logSequence) return fail('invalid-cursor');
    if (!state.logs.some((/** @type {Value} */ row) => row.sequence === end && (taskId === null || row.nativeTaskId === taskId))) return fail('cursor-not-found');
  }
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(options.limit ?? 50, CLAUDE_TASK_LIMITS.page)) : 50;
  const candidates = state.logs.filter((/** @type {Value} */ row) => row.sequence < end && (taskId === null || row.nativeTaskId === taskId));
  const logs = candidates.slice(-limit).map((/** @type {Value} */ row) => ({ ...row }));
  const hasMore = candidates.length > logs.length;
  return { status: 'ok', available: true, logs, hasMore, truncated: state.logsTruncated,
    nextCursor: hasMore ? `ct1.${key}.${logs[0].sequence}.${filter}.${state.logSequence}` : null };
}
