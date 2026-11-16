import { createHash } from 'node:crypto';

/** @typedef {Record<string,any>} Value */
const ACTIVE = new Set(['active', 'running', 'waiting', 'inProgress']);
const TERMINAL = new Set(['idle', 'completed', 'failed', 'stopped']);
const CHILD = new Set(['running', 'waiting', 'idle', 'completed', 'failed', 'stopped', 'unknown']);
/** @param {unknown} value @returns {value is Value} */
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Separate attention/activity projection; never changes own native turn or
 * creates a mutation target. Positive busy proof is sufficient even when other
 * roster members are unknown; absence is idle proof only for a complete roster.
 * @param {{app:string,parentConversationId:string,hostId:string,ownerGeneration:string|null,ownStatus:string,ownWaiting?:boolean,subagents?:Value[],rosterAvailable:boolean,rosterComplete:boolean,nativeChildActive?:boolean,taskActivity?:Value|null}} value */
export function aggregateNativeActivity(value) {
  const ownKnown = ACTIVE.has(value.ownStatus) || TERMINAL.has(value.ownStatus);
  const ownWaiting = value.ownWaiting === true || value.ownStatus === 'waiting';
  let active = ACTIVE.has(value.ownStatus) || value.nativeChildActive === true, waiting = ownWaiting;
  let unknownChildren = 0, childCount = 0;
  const task = record(value.taskActivity) && value.app === 'claude-desktop' && ['app', 'parentConversationId', 'hostId', 'ownerGeneration'].every(key => value.taskActivity?.[key] === /** @type {Value} */ (value)[key])
    && ['active', 'waiting', 'rosterAvailable', 'rosterComplete'].every(key => typeof value.taskActivity?.[key] === 'boolean')
    && ['taskCount', 'dispatchChildCount', 'unknownTasks', 'unknownDispatchChildren'].every(key => Number.isInteger(value.taskActivity?.[key]) && value.taskActivity?.[key] >= 0 && value.taskActivity?.[key] <= 128)
    && value.taskActivity.unknownTasks <= value.taskActivity.taskCount && value.taskActivity.unknownDispatchChildren <= value.taskActivity.dispatchChildCount
    ? value.taskActivity : null;
  const seen = new Set();
  let rosterAvailable = value.rosterAvailable && Array.isArray(value.subagents) && typeof value.ownerGeneration === 'string' && !!value.ownerGeneration;
  for (const row of task ? [] : value.subagents ?? []) {
    if (!record(row) || row.relationship !== 'native-subagent' || row.app !== value.app || row.hostId !== value.hostId ||
        row.parentConversationId !== value.parentConversationId || row.ownerGeneration !== value.ownerGeneration ||
        typeof row.nativeConversationId !== 'string' || !row.nativeConversationId || row.nativeConversationId === value.parentConversationId || seen.has(row.nativeConversationId)) { rosterAvailable = false; continue; }
    seen.add(row.nativeConversationId); childCount++;
    const status = CHILD.has(row.status) ? row.status : 'unknown';
    if (status === 'unknown') unknownChildren++;
    if (status === 'running' || status === 'waiting') active = true;
    if (status === 'waiting') waiting = true;
  }
  if (task) { active ||= task.active; waiting ||= task.waiting; childCount = task.dispatchChildCount; unknownChildren = task.unknownDispatchChildren; rosterAvailable = task.rosterAvailable; }
  const rosterComplete = rosterAvailable && (task ? task.rosterComplete : value.rosterComplete);
  const known = active || waiting || ownKnown && rosterComplete && unknownChildren === 0 && (!task || task.unknownTasks === 0);
  const status = waiting ? 'waiting' : active ? 'running' : known ? value.ownStatus : 'unknown';
  const result = { version: 1, app: value.app, parentConversationId: value.parentConversationId, hostId: value.hostId,
    ownerGeneration: value.ownerGeneration, ownStatus: value.ownStatus, ownKnown, status, known, active, waiting,
    rosterAvailable, rosterComplete, childCount, unknownChildren,
    ...(task ? { taskCount: task.taskCount, unknownTasks: task.unknownTasks } : {}) };
  return { ...result, digest: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}
