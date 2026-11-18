/** @typedef {Record<string,any>} Value */
const STATUSES = new Set(['running', 'waiting', 'idle', 'stopped', 'completed', 'failed', 'unknown']);
/** @param {unknown} value @returns {value is Value} */
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value @param {number} [max] */
function bounded(value, max = 512) { return typeof value === 'string' && value && value.length <= max && !/[\x00-\x1f]/.test(value) ? value : null; }

/** Native subAgentActivity events are lifecycle signals. An interaction's tool
 * completedAtMs is never an agent completion signal. Cache immutable item/turn
 * references so streaming text does not reparse old private tool/message bodies.
 */
export class CodexSubagentProjection {
  /** @type {WeakMap<Value,Value[]>} */ turns = new WeakMap();
  /** @type {WeakMap<Value,Value|null>} */ items = new WeakMap();
  /** @param {Value} turn */
  events(turn) {
    const saved = this.turns.get(turn); if (saved) return saved;
    /** @type {Value[]} */ const events = [];
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (!record(item)) continue;
      let event = this.items.get(item);
      if (event === undefined) {
        const id = bounded(item.agentThreadId);
        event = item.type === 'subAgentActivity' && id ? { id, name: bounded(item.agentPath)?.split('/').filter(Boolean).at(-1) || id.slice(0, 8),
          kind: bounded(item.kind), model: bounded(item.model, 200), reasoningEffort: bounded(item.reasoningEffort, 80),
          eventId: bounded(item.id), at: typeof item.startedAtMs === 'number' && Number.isFinite(item.startedAtMs) ? item.startedAtMs : null } : null;
        this.items.set(item, event);
      }
      if (event) events.push(event);
    }
    this.turns.set(turn, events); return events;
  }
  /** @param {Value[]} turns @param {string} parentConversationId @param {string} hostId @param {string|null} ownerGeneration @param {boolean} [complete] */
  project(turns, parentConversationId, hostId, ownerGeneration, complete = false) {
    /** @type {Map<string,Value>} */ const agents = new Map();
    for (const turn of turns) for (const event of this.events(turn)) {
      if (event.id === parentConversationId) continue;
      const previous = agents.get(event.id);
      const status = event.kind === 'started' ? 'running' : event.kind === 'completed' ? 'completed' : event.kind === 'failed' ? 'failed'
        : event.kind === 'stopped' || event.kind === 'interrupted' ? 'stopped'
          : event.kind === 'interacted' && previous && ['running', 'waiting'].includes(previous.status) ? previous.status : 'unknown';
      agents.set(event.id, { ...previous, id: event.id, name: event.name, app: 'codex', nativeConversationId: event.id, parentConversationId,
        hostId, ownerGeneration, relationship: 'native-subagent', status, statusSource: 'native-lifecycle',
        ...(event.model ? { model: event.model } : {}), ...(event.reasoningEffort ? { reasoningEffort: event.reasoningEffort } : {}),
        ...(event.eventId ? { nativeEventId: event.eventId } : {}), observedEventAt: event.at });
    }
    const rank = /** @type {Record<string,number>} */ ({ waiting: 0, running: 1, unknown: 2, idle: 3, completed: 4, failed: 4, stopped: 4 });
    const ordered = [...agents.values()].sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2)
      || (b.observedEventAt ?? -Infinity) - (a.observedEventAt ?? -Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { subagents: ordered.slice(0, 128), subagentsAvailable: ownerGeneration !== null,
      subagentsComplete: complete && agents.size <= 128, subagentsTruncated: agents.size > 128 };
  }
}

/** Only the current source's derived public list enters phone agentState.
 * @param {unknown} value @param {{app:string,id:string,hostId:string}} source @param {string|null} epoch */
export function sourceSubagents(value, source, epoch) {
  if (!Array.isArray(value)) return [];
  /** @type {Map<string,Value>} */ const byId = new Map();
  /** @type {Value[]} */ const accepted = [];
  for (const row of value.slice(0, 128)) {
    if (!record(row) || row.relationship !== 'native-subagent' || row.app !== source.app || row.hostId !== source.hostId ||
        row.parentConversationId !== source.id || row.ownerGeneration !== epoch || !bounded(row.nativeConversationId) || !bounded(row.name, 512)) continue;
    if (byId.has(row.nativeConversationId)) continue;
    const ancestry = source.app === 'antigravity' && (row.nativeParentConversationId !== undefined || row.depth !== undefined);
    if (ancestry && (!bounded(row.nativeParentConversationId) || row.nativeParentConversationId === row.nativeConversationId
      || row.nativeConversationId === source.id
      || !Number.isSafeInteger(row.depth) || row.depth < 1 || row.depth > 128
      || (row.depth === 1) !== (row.nativeParentConversationId === source.id))) continue;
    const normalized = { id: row.nativeConversationId, name: row.name, app: source.app, hostId: source.hostId, nativeConversationId: row.nativeConversationId,
      parentConversationId: source.id, ownerGeneration: epoch, relationship: 'native-subagent', status: STATUSES.has(row.status) ? row.status : 'unknown',
      ...(bounded(row.model, 200) ? { model: row.model } : {}), ...(bounded(row.reasoningEffort, 80) ? { reasoningEffort: row.reasoningEffort } : {}),
      ...(ancestry
        ? { nativeParentConversationId: row.nativeParentConversationId, depth: row.depth } : {}),
      ...(bounded(row.statusSource, 80) ? { statusSource: row.statusSource } : {}) };
    byId.set(normalized.id, normalized);
    accepted.push(normalized);
  }
  return accepted.filter(row => {
    if (row.nativeParentConversationId === undefined) return true;
    const seen = new Set([row.id]);
    let cursor = row.nativeParentConversationId;
    for (let step = 0; step < 128; step++) {
      if (cursor === source.id) return true;
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) return true;
      if (step === 0 && row.depth !== parent.depth + 1) return false;
      if (parent.nativeParentConversationId === undefined || parent.depth <= 0) return false;
      cursor = parent.nativeParentConversationId;
    }
    return false;
  });
}
