import { createHash } from 'node:crypto';
import { BridgeError } from '../errors.mjs';

/** @typedef {Record<string,any>} Value */
/** @param {unknown} value @returns {Value} */
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Value} */ (value) : {};
/** @param {unknown} value @param {number} [max] */
const label = (value, max = 256) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f]|https?:\/\/|Bearer\s/i.test(value) ? value : null;
const TASK_EVENTS = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed']);
export const CLAUDE_NATIVE_TAIL_LIMITS = Object.freeze({ messages: 2048, bytes: 8 * 1024 * 1024, snapshot: 32 });

/** Native cache/window reconstruction may expand the requested tail count.
 * Bound that native result, then keep complete messages and a real UUID boundary.
 * @param {unknown} input @returns {Value} */
export function boundClaudeNativeTail(input) {
  const value = object(input), messages = value.messages;
  if (!Array.isArray(messages) || messages.length > CLAUDE_NATIVE_TAIL_LIMITS.messages) throw new BridgeError('claude-invalid-tail-window', 'A bounded native transcript tail is required.');
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { throw new BridgeError('claude-invalid-tail-window', 'A serializable native transcript tail is required.'); }
  if (bytes > CLAUDE_NATIVE_TAIL_LIMITS.bytes) throw new BridgeError('claude-tail-window-too-large', 'The native transcript tail exceeds its byte bound.');
  return { ...value, messages: messages.slice(-CLAUDE_NATIVE_TAIL_LIMITS.snapshot),
    hasMore: messages.length > CLAUDE_NATIVE_TAIL_LIMITS.snapshot ? true : typeof value.hasMore === 'boolean' ? value.hasMore : null };
}
/** @param {Value} value @returns {Value} */
function taskFields(value) {
  const patch = object(value.patch);
  return { ...(Object.hasOwn(value, 'session_id') ? { session_id: label(value.session_id, 512) } : {}), task_id: label(value.task_id), task_type: label(value.task_type),
    tool_use_id: label(value.tool_use_id), agent_id: label(value.agent_id), agentId: label(value.agentId),
    is_backgrounded: typeof value.is_backgrounded === 'boolean' ? value.is_backgrounded : null,
    ambient: value.ambient === true, skip_transcript: value.skip_transcript === true,
    patch: { status: label(patch.status), ...(typeof patch.is_backgrounded === 'boolean' ? { is_backgrounded: patch.is_backgrounded } : {}) } };
}
/** @param {unknown} value */
function text(value) {
  if (typeof value !== 'string') return '';
  if (value.length > 1024 * 1024) throw new BridgeError('claude-text-too-large', 'The native text exceeds its projection bound.');
  return value;
}
/** @param {unknown} value @returns {Value[]} */
function content(value) {
  if (typeof value === 'string') return [{ type: 'text', text: text(value) }];
  if (!Array.isArray(value)) return [];
  if (value.length > 256) throw new BridgeError('claude-invalid-response', 'The native content exceeds its projection bound.');
  return value.flatMap(input => {
    const block = object(input), type = label(block.type);
    if (type === 'text') return [{ type, text: text(block.text) }];
    if (type === 'thinking') return [{ type, thinking: text(block.thinking) }];
    if (type === 'redacted_thinking') return [{ type }];
    if (type === 'tool_use') {
      const input = object(block.input), name = label(block.name);
      return [{ type, id: label(block.id), name, ...(name === 'Write' ? { input: { file_path: label(input.file_path, 4096), content: text(input.content) } } : { inputUnavailable: true }) }];
    }
    if (type === 'tool_result') return [{ type, tool_use_id: label(block.tool_use_id), is_error: block.is_error === true, content: content(block.content) }];
    return [{ type: 'unsupported', nativeType: type }];
  });
}

/** Native objects can contain credential/process fields; keep only visible messages.
 * @param {unknown} input @returns {Value} */
export function projectClaudeNativeMessage(input) {
  const value = object(input), type = label(value.type), uuid = label(value.uuid, 512);
  const common = { type, uuid, timestamp: label(value.timestamp, 80), parent_tool_use_id: label(value.parent_tool_use_id),
    user_message_uuid: label(value.user_message_uuid), api_message_id: label(value.api_message_id) };
  if (type === 'user' || type === 'assistant') {
    const message = object(value.message);
    return { ...common, message: { id: label(message.id), role: type, model: label(message.model), content: content(message.content) }, isReplay: value.isReplay === true };
  }
  if (type === 'result') return { ...common, subtype: label(value.subtype), is_error: value.is_error === true, result: text(value.result), stop_reason: label(value.stop_reason) };
  if (type === 'system') {
    const subtype = label(value.subtype), task = TASK_EVENTS.has(subtype ?? '');
    if (subtype === 'background_tasks_changed' && (!Array.isArray(value.tasks) || value.tasks.length > 128)) throw new BridgeError('claude-invalid-task-level', 'A bounded original task level is required.');
    return { ...common, subtype, status: label(value.status), model: label(value.model), ...(task ? taskFields(value) : {}),
      ...(subtype === 'background_tasks_changed' ? { tasks: value.tasks.map((/** @type {unknown} */ item) => { const row = object(item); return { ...taskFields(row),
        ...(Object.hasOwn(row, 'status') ? { status: label(row.status) } : {}) }; }) } : {}) };
  }
  if (type === 'command_lifecycle') return { ...common, command_uuid: label(value.command_uuid), state: label(value.state) };
  if (type === 'stream_event') {
    const event = object(value.event), delta = object(event.delta), block = object(event.content_block), message = object(event.message);
    return { ...common, event: { type: label(event.type), index: Number.isSafeInteger(event.index) ? event.index : null,
      message: { id: label(message.id), model: label(message.model) },
      content_block: { type: label(block.type), text: text(block.text) }, delta: { type: label(delta.type), text: text(delta.text), thinking: text(delta.thinking) } } };
  }
  return { ...common, unavailable: true };
}

/** @param {unknown} input @returns {Value} */
export function projectClaudeNativeTranscript(input) {
  const value = object(input), messages = value.messages;
  const ownerGeneration = label(value.ownerGeneration ?? value.sessionGeneration, 256);
  const executionToken = label(value.executionToken ?? value.sessionGeneration, 256);
  if (!Array.isArray(messages) || messages.length > 500 || !label(value.sessionId, 512) || !ownerGeneration || !executionToken) throw new BridgeError('claude-invalid-response', 'A bounded native session transcript is required.');
  const header = object(value.header);
  return { sessionId: label(value.sessionId, 512), sessionGeneration: ownerGeneration, ownerGeneration, executionToken,
    header: { sessionId: label(header.sessionId, 512), isRunning: typeof header.isRunning === 'boolean' ? header.isRunning : null,
      turnRunning: typeof header.turnRunning === 'boolean' ? header.turnRunning : null,
      hasBackgroundActivity: typeof header.hasBackgroundActivity === 'boolean' ? header.hasBackgroundActivity : null,
      hasBackgroundWork: typeof header.hasBackgroundWork === 'boolean' ? header.hasBackgroundWork : null,
      queryPresent: typeof header.queryPresent === 'boolean' ? header.queryPresent : null,
      sessionType: ['code', 'chat'].includes(header.sessionType) ? header.sessionType : null,
      starting: header.starting === true, model: label(header.model), effort: label(header.effort), parentSessionId: label(header.parentSessionId),
      pendingPermissionCount: Number.isSafeInteger(header.pendingPermissionCount) ? header.pendingPermissionCount : null },
    messages: messages.map(projectClaudeNativeMessage), requests: projectClaudeNativeRequests(value.requests), hasMore: typeof value.hasMore === 'boolean' ? value.hasMore : null,
    found: typeof value.found === 'boolean' ? value.found : null, source: label(value.source), windowFallback: label(value.windowFallback), readFailure: label(value.readFailure) };
}

/** @param {unknown} value @returns {Value[]} */
export function projectClaudeNativeRequests(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 128) throw new BridgeError('claude-invalid-response', 'The native permission list exceeds its bound.');
  return value.map(input => {
    const request = object(input), args = object(request.input ?? request.nativeToolInput), toolName = label(request.toolName ?? request.command), requestId = label(request.requestId);
    const operable = !!requestId && toolName === 'Write' && request.operable !== false && request.onlyOnCard !== true && request.outOfTurn !== true;
    return { requestId, kind: operable ? 'file' : 'unsupported', command: toolName, operable,
      allowedActions: operable ? ['accept', 'decline'] : [], nativeInteraction: 'claude-tool-permission',
      nativeToolInput: toolName === 'Write' ? { file_path: label(args.file_path, 4096), content: text(args.content) } : undefined };
  });
}

/** @param {Value} transcript @param {Value[]} [streamMessages] @returns {Value} */
export function claudeTranscriptView(transcript, streamMessages = []) {
  /** @type {Map<string,Value>} */ const messages = new Map();
  for (const message of [...transcript.messages, ...streamMessages]) if (message.uuid && message.type !== 'stream_event') messages.set(message.uuid, message);
  const finished = new Set([...messages.values()].filter(message => message.type === 'assistant').map(message => message.message?.id).filter(Boolean));
  /** @type {Map<string,Value>} */ const partial = new Map();
  for (const message of streamMessages) {
    if (message.type !== 'stream_event') continue;
    const event = message.event ?? {}, id = message.api_message_id ?? event.message?.id;
    if (!id || finished.has(id)) continue;
    let current = partial.get(id); if (!current) { current = { id, text: '', turnId: message.user_message_uuid ? 'claude-turn:' + message.user_message_uuid : null }; partial.set(id, current); }
    if (event.type === 'content_block_start' && event.content_block?.type === 'text') current.text += event.content_block.text ?? '';
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') current.text += event.delta.text ?? '';
  }
  const firstUuid = [...messages.values()].find(message => message.uuid && ['user', 'assistant'].includes(message.type))?.uuid ?? 'empty';
  const displayPrefix = `claude-display:${transcript.sessionId}:${firstUuid}`;
  /** @type {Value[]} */ const rows = []; let turn = displayPrefix;
  /** @type {Map<string,Value>} */ const outputs = new Map();
  for (const message of messages.values()) for (const block of message.message?.content ?? []) if (block.type === 'tool_result' && block.tool_use_id) outputs.set(block.tool_use_id, block);
  for (const message of messages.values()) {
    const at = message.timestamp ? Date.parse(message.timestamp) : NaN;
    if (message.type === 'user' || message.type === 'assistant') {
      const blocks = message.message?.content ?? [], body = blocks.filter((/** @type {Value} */ block) => block.type === 'text').map((/** @type {Value} */ block) => block.text).join('\n');
      const results = blocks.filter((/** @type {Value} */ block) => block.type === 'tool_result');
      if (message.type === 'user' && results.length && !body) {
        rows.push({ id: 'claude:' + message.uuid, role: 'tool', text: '', turnId: turn, ...(turn === displayPrefix ? { displayTurnId: turn, displayOnlyTurn: true } : {}), at: Number.isFinite(at) ? at : null, status: 'completed',
          tools: results.map((/** @type {Value} */ result) => ({ id: result.tool_use_id, name: '', arguments: {}, output: (result.content ?? []).filter((/** @type {Value} */ block) => block.type === 'text').map((/** @type {Value} */ block) => block.text).join('\n'), status: result.is_error ? 'failed' : 'completed' })) });
        continue;
      }
      if (message.type === 'user') turn = 'claude-turn:' + message.uuid;
      rows.push({ id: 'claude:' + message.uuid, role: message.type, text: body, tools: blocks.filter((/** @type {Value} */ block) => block.type === 'tool_use').map((/** @type {Value} */ block) => ({ id: block.id, name: block.name, arguments: block.input ?? {}, inputUnavailable: block.inputUnavailable === true, status: outputs.get(block.id)?.is_error ? 'failed' : outputs.has(block.id) ? 'completed' : 'unknown', output: '' })),
        turnId: turn, ...(turn === displayPrefix ? { displayTurnId: turn, displayOnlyTurn: true } : {}), status: 'completed', at: Number.isFinite(at) ? at : null,
        ...(message.type === 'user' ? { commandId: message.uuid, inputStatus: 'accepted' } : { replaceSourceRowIds: message.message?.id ? ['claude-api:' + message.message.id] : [] }) });
    }
  }
  for (const message of partial.values()) if (message.text) rows.push({ id: 'claude-api:' + message.id, role: 'assistant', text: message.text, tools: [], turnId: message.turnId, status: 'running', at: null });
  const turnRunning = transcript.header.sessionType === 'code' ? transcript.header.turnRunning : transcript.header.isRunning;
  const status = turnRunning === true ? transcript.header.pendingPermissionCount > 0 ? 'waiting' : 'running'
    : turnRunning === false && !transcript.header.starting ? 'idle' : 'unknown';
  return { rows, requests: transcript.requests ?? [], status, currentTurnId: null, latestTurnId: turn, ownerGeneration: transcript.ownerGeneration ?? transcript.sessionGeneration,
    nativeSessionType: transcript.header.sessionType,
    nativeCancel: { scope: 'session-query', sessionId: transcript.sessionId, queryToken: transcript.executionToken, queryPresent: transcript.header.queryPresent, available: transcript.header.queryPresent === true && ['running', 'waiting'].includes(status) },
    nativeInput: { scope: 'session-query', sessionId: transcript.sessionId, queryToken: transcript.executionToken, sendSupported: true, canSend: status === 'idle', canSteer: false, activeSendMode: 'unverified' },
    nativeModel: { model: transcript.header.model, effort: transcript.header.effort }, historyComplete: transcript.hasMore === false && transcript.found !== false && !transcript.readFailure,
    contentStamp: createHash('sha256').update(JSON.stringify([rows, status, transcript.ownerGeneration, transcript.executionToken, transcript.requests, transcript.header.model, transcript.header.effort])).digest('hex'),
    nativeHistory: { hasMore: transcript.hasMore, source: transcript.source, windowFallback: transcript.windowFallback } };
}
