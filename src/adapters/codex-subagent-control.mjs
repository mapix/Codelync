/** @typedef {Record<string,any>} Value */
/** @param {unknown} value */
function bounded(value) { return typeof value === 'string' && !!value.trim() && value.length <= 512 && !/[\x00-\x1f]/.test(value) ? value : null; }

/** Current original provenance, not a title/recency guess. v2 managed children
 * have a canonical agent_path and receive follow-ups through their parent.
 * @param {Value} state */
export function codexNativeInputControl(state) {
  const spawn = state.source?.subAgent?.thread_spawn;
  const agentPath = bounded(spawn?.agent_path), recordedParent = bounded(spawn?.parent_thread_id), parent = bounded(state.parentThreadId);
  if (state.threadSource !== 'subagent' || !agentPath || !recordedParent) return { available: true };
  return { available: false, reason: 'parent-owned-subagent', agentPath,
    parentConversationId: parent && parent !== recordedParent ? null : recordedParent };
}
