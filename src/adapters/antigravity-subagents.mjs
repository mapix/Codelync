import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
/** @typedef {'running'|'waiting'|'idle'|'stopped'|'failed'|'unknown'} Status */
const RUNNING = new Set(['CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_BUSY', 2, 4]);
const CANCELING = new Set(['CASCADE_RUN_STATUS_CANCELING', 3]);
const IDLE = new Set(['CASCADE_RUN_STATUS_IDLE', 1]);
const ERROR = new Set(['EXECUTOR_TERMINATION_REASON_ERROR', 1]);
const CANCELED = new Set(['EXECUTOR_TERMINATION_REASON_USER_CANCELED', 2]);
const MAX_SUBAGENTS = 128;
const MAX_NATIVE_SUMMARIES = 20000;

/** @param {unknown} value @returns {value is Value} */
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function identity(value) { return typeof value === 'string' && !!value.trim() && value.length <= 512 && !/[\x00-\x1f]/.test(value); }
/** @param {unknown} value */
function name(value) { return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) : ''; }

/** Original relationship metadata; ordinary forks do not qualify.
 * @param {Value} summary */
export function antigravitySubagentIdentity(summary) {
  const value = summary.trajectoryMetadata;
  const metadata = record(value) ? value : {};
  const spec = record(metadata.subagentSpec) ? metadata.subagentSpec : null;
  const isSubagent = summary.nativeSubagentSpecPresent === true || !!(spec && Object.keys(spec).length)
    || summary.source === 'CORTEX_TRAJECTORY_SOURCE_SUBAGENT' || summary.source === 16;
  return { isSubagent, parentId: identity(metadata.parentConversationId) ? metadata.parentConversationId : null,
    name: isSubagent ? name(spec?.role) || name(spec?.typeName) : '' };
}

/** Native run state is independent of completed model invocations. In particular
 * IDLE/no-tool-call and a terminal custom hook can mean a parked Swarm worker.
 * @param {Value} summary @returns {Status} */
export function antigravitySubagentStatus(summary) {
  if (summary.nativeActivityInvalidated === true) return 'unknown';
  if (CANCELING.has(summary.status)) return 'running';
  if (RUNNING.has(summary.status) || antigravitySummaryHasWork(summary)) {
    return Array.isArray(summary.waitingSteps) && summary.waitingSteps.length > 0 ? 'waiting' : 'running';
  }
  if (IDLE.has(summary.status)) {
    if (!antigravitySummaryIdleConfirmed(summary)) return 'unknown';
    if (summary.killed === true || summary.interrupted === true || CANCELED.has(summary.latestExecutorTerminationReason)) return 'stopped';
    if (ERROR.has(summary.latestExecutorTerminationReason)) return 'failed';
    return 'idle';
  }
  return summary.killed === true ? 'stopped' : 'unknown';
}

/** Positive native work is separate from the foreground cascade state.
 * @param {Value} summary */
export function antigravitySummaryHasWork(summary) {
  return summary.nativeActivityInvalidated !== true && (summary.notFullyIdle === true || summary.hasRunningSubagents === true
    || Number.isSafeInteger(summary.backgroundTaskCount) && summary.backgroundTaskCount > 0);
}

/** Only a current rich full summary can confirm the native fully-idle predicate.
 * @param {Value} summary */
export function antigravitySummaryIdleConfirmed(summary) {
  return summary.nativeActivityInvalidated !== true && summary.nativeSummaryAvailable === true
    && summary.notFullyIdle === false && summary.hasRunningSubagents === false && summary.backgroundTaskCount === 0
    && !antigravitySummaryHasWork(summary);
}

/** Build once per native index so multiple ancestors do not rescan all metadata.
 * @param {unknown} summaries */
export function antigravitySubagentIndex(summaries) {
  if (!record(summaries) || Object.keys(summaries).length > MAX_NATIVE_SUMMARIES) throw new BridgeError('antigravity-invalid-response', 'The native subagent index is unavailable.', 503);
  /** @type {Map<string,Value[]>} */ const children = new Map();
  for (const [id, summary] of Object.entries(summaries)) {
    if (!record(summary)) throw new BridgeError('antigravity-invalid-response', 'The native subagent summary is invalid.', 503);
    const child = antigravitySubagentIdentity(summary);
    if (!child.isSubagent || !child.parentId) continue;
    if (!identity(id)) throw new BridgeError('antigravity-invalid-response', 'The native subagent identity is invalid.', 503);
    const entry = { id, parentId: child.parentId, name: child.name || 'Antigravity subagent', status: antigravitySubagentStatus(summary),
      observedAt: typeof summary.lastModifiedTime === 'string' ? Date.parse(summary.lastModifiedTime) || 0 : 0,
      statusSource: summary.nativeSummaryAvailable === true ? 'native-summary-stream' : summary.nativeActivityInvalidated === true ? 'unknown' : 'native-cascade-summary' };
    const rows = children.get(child.parentId) ?? []; rows.push(entry); children.set(child.parentId, rows);
  }
  return { children };
}

/** Exact native ancestry, with active descendants retained before historical rows.
 * @param {{children:Map<string,Value[]>}} index @param {string} parentConversationId
 * @param {string} hostId @param {string} ownerGeneration */
export function projectAntigravitySubagentTree(index, parentConversationId, hostId, ownerGeneration) {
  if (!identity(parentConversationId) || !/^local:antigravity:[a-f0-9]{64}$/.test(hostId) || !identity(ownerGeneration)) throw new BridgeError('source-epoch-changed', 'The native subagent source identity is unavailable.', 409);
  /** @type {Value[]} */ const rows = [];
  const visited = new Set([parentConversationId]), queue = [{ id: parentConversationId, depth: 0 }];
  let depthBounded = false;
  for (let at = 0; at < queue.length; at += 1) {
    const parent = queue[at];
    for (const child of index.children.get(parent.id) ?? []) {
      if (child.id === parentConversationId) {
        if (parent.id !== parentConversationId) throw new BridgeError('antigravity-invalid-response', 'The native subagent ancestry loops through its selected ancestor.', 503);
        continue;
      }
      if (visited.has(child.id)) continue;
      visited.add(child.id); const depth = parent.depth + 1;
      queue.push({ id: child.id, depth });
      if (depth > 128) { depthBounded = true; continue; }
      rows.push({ id: child.id, name: child.name, app: 'antigravity', nativeConversationId: child.id,
        parentConversationId, nativeParentConversationId: child.parentId, depth, status: child.status,
        hostId, ownerGeneration, relationship: 'native-subagent', statusSource: child.statusSource, observedAt: child.observedAt });
    }
  }
  const rank = /** @type {Record<string,number>} */ ({ waiting: 0, running: 1, unknown: 2, idle: 3, failed: 4, stopped: 4 });
  rows.sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2) || a.depth - b.depth || b.observedAt - a.observedAt || a.id.localeCompare(b.id));
  const total = visited.size - 1, truncated = total > MAX_SUBAGENTS || depthBounded;
  const allRows = rows.map(row => { const value = { ...row }; delete value.observedAt; return value; });
  return { rows: allRows.slice(0, MAX_SUBAGENTS), allRows, total, truncated, complete: !truncated,
    activityComplete: !depthBounded && total <= 256 };
}

/** Bounded descendant projection from the original owner's resident index.
 * An unavailable index must be represented by the caller's availability field,
 * not replaced with {}. All row identities are exact, never title/path matches.
 * @param {unknown} summaries @param {string} parentConversationId
 * @param {string} hostId @param {string} ownerGeneration @returns {Value[]} */
export function projectAntigravitySubagents(summaries, parentConversationId, hostId, ownerGeneration) {
  if (!record(summaries) || !identity(parentConversationId)) throw new BridgeError('antigravity-invalid-response', 'The native subagent index or parent identity is unavailable.', 503);
  return projectAntigravitySubagentTree(antigravitySubagentIndex(summaries), parentConversationId, hostId, ownerGeneration).rows;
}

