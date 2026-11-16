import test from 'node:test';
import assert from 'node:assert/strict';
import { projectClaudeNativeTranscript, projectClaudeNativeMessage, projectClaudeNativeRequests, claudeTranscriptView, boundClaudeNativeTail, CLAUDE_NATIVE_TAIL_LIMITS } from '../src/adapters/claude-history.mjs';
import { projectClaudeTasks } from '../src/adapters/claude-tasks.mjs';

test('expanded native 512-message window retains the latest whole messages and real older UUID coverage', () => {
  const messages = Array.from({ length: 512 }, (_, index) => ({ type: 'assistant', uuid: 'native-' + index,
    message: { content: [{ type: 'text', text: 'complete body ' + index + '\n' + 'x'.repeat(64) }] } }));
  const original = { messages, hasMore: false, source: 'cache' }, tail = boundClaudeNativeTail(original);
  assert.equal(tail.messages.length, 32); assert.equal(tail.messages[0], messages[480]); assert.equal(tail.messages.at(-1), messages[511]);
  assert.equal(tail.hasMore, true); assert.equal(tail.source, 'cache'); assert.equal(original.messages.length, 512);
  const projected = projectClaudeNativeTranscript({ ...tail, sessionId: 'native-session', ownerGeneration: 'owner', executionToken: 'query' });
  assert.equal(projected.messages[0].uuid, 'native-480'); assert.equal(projected.messages.at(-1).message.content[0].text, messages[511].message.content[0].text);
  assert.equal(projected.hasMore, true);
});

test('native tail preserves short-window unknown coverage and rejects unbounded materialized results', () => {
  assert.equal(boundClaudeNativeTail({ messages: [], hasMore: null }).hasMore, null);
  assert.equal(boundClaudeNativeTail({ messages: [], hasMore: false }).hasMore, false);
  assert.throws(() => boundClaudeNativeTail({ messages: Array(CLAUDE_NATIVE_TAIL_LIMITS.messages + 1).fill({}) }), { code: 'claude-invalid-tail-window' });
  assert.throws(() => boundClaudeNativeTail({ messages: [{ type: 'assistant', message: { content: 'x'.repeat(CLAUDE_NATIVE_TAIL_LIMITS.bytes) } }] }), { code: 'claude-tail-window-too-large' });
});

test('native messages without UUID stay nullable while retained real row UUIDs remain page boundaries', () => {
  const tail = boundClaudeNativeTail({ messages: [{ type: 'system', subtype: 'init' }, { type: 'assistant', uuid: 'actual-native-answer', message: { content: 'whole body' } }], hasMore: null });
  const projected = projectClaudeNativeTranscript({ ...tail, sessionId: 'native-session', ownerGeneration: 'owner', executionToken: 'query' });
  assert.equal(projected.messages[0].uuid, null); assert.equal(projected.messages[1].uuid, 'actual-native-answer');
  const view = claudeTranscriptView(projected); assert.equal(view.rows[0].id, 'claude:actual-native-answer'); assert.equal(view.historyComplete, false);
});

test('native transcript projection excludes runtime/provider secrets and thinking signatures', () => {
  const sentinel = 'synthetic-secret-key';
  const reply = projectClaudeNativeTranscript({ sessionId: 'local_probe', sessionGeneration: 'query-one', header: { sessionId: 'local_probe', isRunning: false, provider: { key: sentinel } }, hasMore: false,
    messages: [{ type: 'system', uuid: 'init', apiKeySource: sentinel, provider: { key: sentinel } }, { type: 'assistant', uuid: 'answer', message: { id: 'api-answer', content: [{ type: 'text', text: 'done' }, { type: 'thinking', thinking: 'reason', signature: sentinel }] } }] });
  assert.equal(JSON.stringify(reply).includes(sentinel), false);
  const view = claudeTranscriptView(reply); assert.equal(view.rows[0].id, 'claude:answer'); assert.equal(view.rows[0].text, 'done'); assert.equal(view.historyComplete, true);
});

test('task lifecycle and level projection retain native task/agent/tool identities and exclude task output and credentials', () => {
  const scope = { app: 'claude-desktop', nativeCollection: 'claude-code-sessions', hostId: 'host', parentConversationId: 'desktop-parent', ownerGeneration: 'owner', runtimeGeneration: 'runtime', queryToken: 'query', cliSessionId: 'native-cli' };
  const native = { type: 'system', subtype: 'task_started', uuid: 'task-event', session_id: 'native-cli', task_id: 'native-task', task_type: 'local_agent', agentId: 'native-agent', tool_use_id: 'native-tool', parent_tool_use_id: 'parent-tool', is_backgrounded: false, output_file: '/private/task/output', credentials: 'synthetic-provider-secret' };
  const event = projectClaudeNativeMessage(native), again = projectClaudeNativeMessage(event);
  const projected = projectClaudeTasks({ scope, observedScope: scope, connected: true, fresh: true, coverage: { available: true }, events: [again] });
  assert.equal(projected.tasks[0].nativeTaskId, 'native-task'); assert.equal(projected.tasks[0].agentId, 'native-agent');
  assert.equal(projected.tasks[0].toolUseId, 'native-tool'); assert.equal(projected.tasks[0].parentToolUseId, 'parent-tool');
  assert.equal(projected.tasks[0].isBackgrounded, false); assert.equal(projected.tasks[0].status, 'running');
  assert.equal(JSON.stringify(again).includes('synthetic-provider-secret'), false); assert.equal(JSON.stringify(again).includes('/private/task/output'), false);
  const update = projectClaudeNativeMessage({ ...native, subtype: 'task_updated', uuid: 'patch-event', patch: { status: 'paused', is_backgrounded: true, privateOutput: 'synthetic-provider-secret' } });
  assert.deepEqual(update.patch, { status: 'paused', is_backgrounded: true });
  const level = projectClaudeNativeMessage({ type: 'system', subtype: 'background_tasks_changed', uuid: 'level', session_id: 'native-cli', tasks: [{ task_id: 'native-task', task_type: 'local_agent', status: 'running', credentials: 'synthetic-provider-secret' }] });
  assert.equal(level.tasks[0].task_id, 'native-task'); assert.equal(level.tasks[0].task_type, 'local_agent');
  assert.equal(JSON.stringify(level).includes('synthetic-provider-secret'), false);
});

test('malformed or oversized task levels cannot become a complete empty background roster', () => {
  assert.throws(() => projectClaudeNativeMessage({ type: 'system', subtype: 'background_tasks_changed' }), { code: 'claude-invalid-task-level' });
  assert.throws(() => projectClaudeNativeMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: Array(129).fill({ task_id: 'task', task_type: 'local_agent' }) }), { code: 'claude-invalid-task-level' });
});

test('native background status omission survives projection while explicit unknown remains unknown', () => {
  const scope = { app: 'claude-desktop', nativeCollection: 'claude-code-sessions', hostId: 'host', parentConversationId: 'parent', ownerGeneration: 'owner', runtimeGeneration: 'runtime', queryToken: 'query', cliSessionId: 'cli' };
  const level = projectClaudeNativeMessage({ type: 'system', subtype: 'background_tasks_changed', uuid: 'level', session_id: 'cli', tasks: [
    { task_id: 'active', task_type: 'local_agent' }, { task_id: 'explicit-null', task_type: 'local_agent', status: null }, { task_id: 'explicit-unknown', task_type: 'local_agent', status: 'unknown' }] });
  assert.equal(Object.hasOwn(level.tasks[0], 'status'), false); assert.equal(Object.hasOwn(level.tasks[1], 'status'), true);
  const again = projectClaudeNativeMessage(level);
  const result = projectClaudeTasks({ scope, observedScope: scope, connected: true, fresh: true, events: [], level: again, coverage: { available: true, levelComplete: true } });
  assert.equal(result.tasks.find((/** @type {any} */ row) => row.nativeTaskId === 'active').status, 'running');
  assert.equal(result.tasks.find((/** @type {any} */ row) => row.nativeTaskId === 'explicit-null').status, 'unknown');
  assert.equal(result.tasks.find((/** @type {any} */ row) => row.nativeTaskId === 'explicit-unknown').status, 'unknown');
});

test('bounded assistant/tool prefix keeps display grouping without inventing a native control turn', () => {
  const transcript = projectClaudeNativeTranscript({ sessionId: 'local_probe', ownerGeneration: 'owner', executionToken: 'query', header: { isRunning: false }, hasMore: true,
    messages: [{ type: 'assistant', uuid: 'prefix-answer', message: { content: 'older answer' } }, { type: 'user', uuid: 'prefix-tool', message: { content: [{ type: 'tool_result', tool_use_id: 'native-tool', content: 'done' }] } }] });
  const view = claudeTranscriptView(transcript);
  assert.equal(view.rows.length, 2); assert.equal(view.rows[0].turnId, 'claude-display:local_probe:prefix-answer'); assert.equal(view.rows[1].turnId, view.rows[0].turnId);
  assert.equal(view.rows[0].displayOnlyTurn, true); assert.equal(view.rows[1].displayOnlyTurn, true); assert.equal(view.currentTurnId, null);
});

test('native tool results keep the parent turn and cannot become accepted user input', () => {
  const transcript = projectClaudeNativeTranscript({ sessionId: 'local_probe', sessionGeneration: 'query-one', header: { isRunning: false }, hasMore: false,
    messages: [{ type: 'user', uuid: 'person', message: { content: 'write' } }, { type: 'assistant', uuid: 'call', message: { content: [{ type: 'tool_use', id: 'tool-one', name: 'Write', input: { file_path: '/probe/a', content: 'done', credentials: 'synthetic-secret' } }] } },
      { type: 'user', uuid: 'result', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-one', content: 'written' }] } }] });
  const view = claudeTranscriptView(transcript);
  assert.equal(view.rows[2].role, 'tool'); assert.equal(view.rows[2].turnId, view.rows[0].turnId); assert.equal(view.rows[2].commandId, undefined);
  assert.equal(view.rows[1].tools[0].status, 'completed'); assert.equal(JSON.stringify(view).includes('synthetic-secret'), false);
});

test('verified Write requests retain single-use controls and card-only requests stay unavailable on reprojection', () => {
  const requests = projectClaudeNativeRequests([{ requestId: 'native-request', toolName: 'Write', input: { file_path: '/probe/a', content: 'a', secret: 'synthetic-secret' } },
    { requestId: 'native-card', toolName: 'Write', onlyOnCard: true, input: { file_path: '/probe/b', content: 'b' } }]);
  const again = projectClaudeNativeRequests(requests);
  assert.deepEqual(again[0].allowedActions, ['accept', 'decline']); assert.equal(again[1].operable, false); assert.equal(JSON.stringify(again).includes('synthetic-secret'), false);
});

test('native API stream identity converges on final UUID without a duplicate assistant row', () => {
  const transcript = projectClaudeNativeTranscript({ sessionId: 'local_probe', sessionGeneration: 'query-one', header: { isRunning: true }, hasMore: false, messages: [] });
  const stream = [projectClaudeNativeMessage({ type: 'stream_event', uuid: 'frame', api_message_id: 'api-answer', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } } })];
  assert.equal(claudeTranscriptView(transcript, stream).rows[0].text, 'hello');
  const final = projectClaudeNativeMessage({ type: 'assistant', uuid: 'native-answer', message: { id: 'api-answer', content: 'hello' } });
  const view = claudeTranscriptView(transcript, [...stream, final]);
  assert.equal(view.rows.length, 1); assert.equal(view.rows[0].id, 'claude:native-answer'); assert.deepEqual(view.rows[0].replaceSourceRowIds, ['claude-api:api-answer']);
});

test('tail and final native events converge on UUID and retain unknown status/coverage', () => {
  const tail = projectClaudeNativeTranscript({ sessionId: 'local_probe', sessionGeneration: 'query-one', header: {}, hasMore: null,
    messages: [{ type: 'user', uuid: 'person', message: { content: 'hello' } }, { type: 'assistant', uuid: 'answer', message: { content: 'partial' } }] });
  const view = claudeTranscriptView(tail, [projectClaudeNativeMessage({ type: 'assistant', uuid: 'answer', message: { content: 'complete' } })]);
  assert.equal(view.rows.length, 2); assert.equal(view.rows[1].text, 'complete'); assert.equal(view.status, 'unknown'); assert.equal(view.historyComplete, false);
});

test('native Code workflow activity never becomes foreground/cancel, and missing turn evidence stays unknown', () => {
  const base = { sessionId: 'native-code', ownerGeneration: 'owner', executionToken: 'query', messages: [], hasMore: false };
  const view = claudeTranscriptView(projectClaudeNativeTranscript({ ...base, header: { sessionType: 'code', isRunning: true, turnRunning: false,
    hasBackgroundActivity: true, hasBackgroundWork: true, queryPresent: true, pendingPermissionCount: 0 } }));
  assert.equal(view.status, 'idle'); assert.equal(view.nativeCancel.available, false); assert.equal(view.currentTurnId, null);
  const unknown = claudeTranscriptView(projectClaudeNativeTranscript({ ...base, header: { sessionType: 'code', isRunning: true, hasBackgroundActivity: true, queryPresent: true } }));
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.nativeInput.canSend, false); assert.equal(unknown.nativeCancel.available, false);
});
