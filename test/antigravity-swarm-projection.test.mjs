import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAntigravityTrajectory } from '../src/adapters/antigravity-backend.mjs';
import { recentRowsPage } from '../src/happy/recent-data.mjs';

/** @typedef {Record<string,any>} Value */
/** @param {Value[]} steps */
function project(steps) {
  return projectAntigravityTrajectory('selected-native', { trajectory: { trajectoryId: 'original-trajectory', cascadeId: 'selected-native', steps },
    status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 100 + steps.length, nativeStepOffset: 100 }, 'original-owner');
}

test('selected Swarm generic results retain existing Unicode Markdown blocks and bounded string-map input', () => {
  const view = project([{ status: 3, userInput: { query: 'Fixture' } },
    { status: 3, metadata: { toolCall: { id: 'native-tool-id', name: 'read_board' }, internalMetadata: { private: 'ignored metadata' } },
      generic: { args: { since: '42', text: '原生任务正文' }, result: { result: 'Short native acknowledgement', fullOutputUri: 'file:///private/not-fetched',
        stepRenderInfo: { titlePrefix: 'Swarm', contentBlocks: [{ markdown: '成员消息 α' }, { markdown: '任务进度 β' }] } } } },
    { status: 3, generic: { args: { action: 'list' }, result: { result: 'Existing native result' } } }]);
  const row = view.rows[1]; assert.equal(row.id, 'agy:original-trajectory:101'); assert.equal(row.order, 101);
  assert.equal(row.turnId, 'agy-turn:original-trajectory:100'); assert.equal(row.tools[0].id, 'native-tool-id');
  assert.deepEqual(row.tools[0].arguments, { since: '42', text: '原生任务正文' });
  assert.equal(row.tools[0].output, '成员消息 α\n\n任务进度 β'); assert.equal(view.rows[2].tools[0].output, 'Existing native result');
  assert.equal(JSON.stringify(view).includes('not-fetched'), false); assert.equal(JSON.stringify(view).includes('ignored metadata'), false);
  assert.equal(view.historyComplete, false); assert.equal(view.nativeStepOffset, 100); assert.equal(view.ownerGeneration, 'original-owner');
});

test('visible original agent content reaches the existing assistant surface while native hidden flags remain hidden', () => {
  const view = project([{ status: 3, systemMessage: { message: 'Native wrapper', agentMessage: { sender: 'original-sender', content: '现成成员正文', renderDetails: { messageTitle: 'Native member title' } } } },
    { status: 3, systemMessage: { agentMessage: { content: 'hidden agent sentinel', hideFromUser: true } } },
    { status: 3, systemMessage: { renderInfo: { hidden: true }, agentMessage: { content: 'hidden render sentinel' } } },
    { status: 3, generic: { args: { text: 'hidden input sentinel' }, result: { result: 'hidden output sentinel', stepRenderInfo: { hidden: true } } } }]);
  assert.equal(view.rows.length, 1); assert.equal(view.rows[0].role, 'assistant'); assert.equal(view.rows[0].text, 'Native member title\n\n现成成员正文');
  assert.equal(view.rows[0].id, 'agy:original-trajectory:100'); assert.equal(view.rows[0].turnId, 'agy-turn:original-trajectory:prefix');
  assert.equal(JSON.stringify(view).includes('sentinel'), false);
  assert.equal(recentRowsPage('mirror', view.rows, { historyComplete: false, nativeStepOffset: 100 }).rows.length, 1);
});

test('native generic Markdown and input keep the existing text and collection bounds', () => {
  assert.throws(() => project([{ generic: { result: { stepRenderInfo: { contentBlocks: Array.from({ length: 129 }, () => ({ markdown: 'Fixture' })) } } } }]), { code: 'antigravity-text-too-large' });
  assert.throws(() => project([{ generic: { result: { result: 'x'.repeat(1024 * 1024 + 1) } } }]), { code: 'antigravity-text-too-large' });
  assert.throws(() => project([{ generic: { args: { text: { unsupported: true } } } }]), { code: 'antigravity-invalid-response' });
  assert.throws(() => project([{ generic: { args: { text: 'x'.repeat(1024 * 1024) } } }]), { code: 'antigravity-text-too-large' });
});

test('explicit native tool-call JSON stays authoritative over the generic string map', () => {
  const view = project([{ metadata: { toolCall: { name: 'post_message', argumentsJson: '{"text":"Original native input"}' } },
    generic: { args: { text: 'Fallback only' }, result: { stepRenderInfo: { markdown: 'Original rendered message' } } } }]);
  assert.deepEqual(view.rows[0].tools[0].arguments, { text: 'Original native input' });
  assert.equal(view.rows[0].tools[0].output, 'Original rendered message');
});
