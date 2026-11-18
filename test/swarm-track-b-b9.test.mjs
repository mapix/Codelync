import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravitySubagentIndex, projectAntigravitySubagentTree } from '../src/adapters/antigravity-subagents.mjs';
import { CodexSubagentProjection, sourceSubagents } from '../src/adapters/native-subagents.mjs';
import { ClaudeNativeSettings } from '../src/adapters/claude-settings.mjs';
import { nativeSettingsScope } from '../src/codelync/native-settings-scope.mjs';

/** @typedef {Record<string,any>} Value */

const host = 'local:antigravity:' + 'a'.repeat(64);
const generation = 'antigravity:owner-a';

function agChild(/** @type {Value} */ extra = {}) {
  return {
    status: 'CASCADE_RUN_STATUS_RUNNING',
    trajectoryMetadata: { parentConversationId: 'root', subagentSpec: { role: 'Worker' } },
    nativeSummaryAvailable: true,
    notFullyIdle: false,
    hasRunningSubagents: false,
    backgroundTaskCount: 0,
    lastModifiedTime: '2026-11-18T00:00:00.000Z',
    ...extra,
  };
}

test('R082: antigravitySubagentIndex and projectAntigravitySubagentTree guard self/root/descendant cycles and tie-break deterministically', () => {
  // Self-loop on non-root is safely ignored while valid sibling remains deterministic
  const withSelfLoop = {
    'self-loop': agChild({ trajectoryMetadata: { parentConversationId: 'self-loop', subagentSpec: { role: 'Self' } } }),
    'b-worker': agChild(),
    'Z-worker': agChild(),
    'a-worker': agChild(),
  };
  const tree = projectAntigravitySubagentTree(antigravitySubagentIndex(withSelfLoop), 'root', host, generation);
  // Code-unit tie-break order puts 'Z-worker' before 'a-worker' before 'b-worker' deterministically regardless of locale
  assert.deepEqual(tree.rows.map(r => r.id), ['Z-worker', 'a-worker', 'b-worker']);

  // Root cycle (root -> a -> b -> root) throws antigravity-invalid-response
  const rootCycle = {
    root: agChild({ trajectoryMetadata: { parentConversationId: 'b', subagentSpec: { role: 'Root' } } }),
    a: agChild({ trajectoryMetadata: { parentConversationId: 'root', subagentSpec: { role: 'A' } } }),
    b: agChild({ trajectoryMetadata: { parentConversationId: 'a', subagentSpec: { role: 'B' } } }),
  };
  assert.throws(() => projectAntigravitySubagentTree(antigravitySubagentIndex(rootCycle), 'root', host, generation), { code: 'antigravity-invalid-response' });

  // Synthetic descendant cycle (root -> a -> b -> a) throws antigravity-invalid-response
  const syntheticCyclicIndex = {
    children: new Map([
      ['root', [{ id: 'a', parentId: 'root', name: 'A', status: 'running', observedAt: 0, statusSource: 'native-summary-stream' }]],
      ['a', [{ id: 'b', parentId: 'a', name: 'B', status: 'running', observedAt: 0, statusSource: 'native-summary-stream' }]],
      ['b', [{ id: 'a', parentId: 'b', name: 'A', status: 'running', observedAt: 0, statusSource: 'native-summary-stream' }]],
    ]),
  };
  assert.throws(() => projectAntigravitySubagentTree(syntheticCyclicIndex, 'root', host, generation), { code: 'antigravity-invalid-response' });

  // Diamond DAG (root -> a -> c, root -> b -> c) deduplicates cleanly without false cycle error
  const diamondIndex = {
    children: new Map([
      ['root', [
        { id: 'a', parentId: 'root', name: 'A', status: 'running', observedAt: 0, statusSource: 'native-summary-stream' },
        { id: 'b', parentId: 'root', name: 'B', status: 'running', observedAt: 0, statusSource: 'native-summary-stream' },
      ]],
      ['a', [{ id: 'c', parentId: 'a', name: 'C', status: 'running', observedAt: 0, statusSource: 'native-summary-stream' }]],
      ['b', [{ id: 'c', parentId: 'b', name: 'C', status: 'running', observedAt: 0, statusSource: 'native-summary-stream' }]],
    ]),
  };
  const diamond = projectAntigravitySubagentTree(diamondIndex, 'root', host, generation);
  assert.deepEqual(diamond.rows.map(r => r.id), ['a', 'b', 'c']);
});

test('R082: CodexSubagentProjection keeps active rows under 128-cap and sourceSubagents rejects cyclic/inconsistent parentConversationId chains', () => {
  const projection = new CodexSubagentProjection();
  const items = [
    { type: 'subAgentActivity', kind: 'started', agentThreadId: 'early-active', agentPath: '/root/early', id: 'e0', startedAtMs: 1 },
    ...Array.from({ length: 130 }, (_, index) => ({
      type: 'subAgentActivity', kind: 'completed', agentThreadId: `done-${String(index).padStart(3, '0')}`,
      agentPath: '/root/done', id: `ed-${index}`, startedAtMs: 100 + index,
    })),
  ];
  const projected = projection.project([{ items }], 'root', 'local', 'owner');
  assert.equal(projected.subagents.length, 128);
  assert.equal(projected.subagents[0].id, 'early-active');
  assert.equal(projected.subagentsTruncated, true);
  assert.equal(projected.subagentsComplete, false);

  const source = { app: 'antigravity', id: 'root', hostId: host };
  const baseRow = (/** @type {string} */ id, /** @type {string} */ nativeParent, /** @type {number} */ depth) => ({
    id, nativeConversationId: id, name: id, app: 'antigravity', hostId: host,
    parentConversationId: 'root', ownerGeneration: generation, relationship: 'native-subagent', status: 'running',
    nativeParentConversationId: nativeParent, depth,
  });

  // 2-node and 3-node parent cycles are excluded, while valid root/descendant and truncated-parent leaf survive
  const mixed = [
    baseRow('direct', 'root', 1),
    baseRow('direct', 'root', 1), // duplicate ID ignored
    baseRow('leaf-missing-mid', 'truncated-coordinator', 2), // valid per spec when intermediate parent outside slice
    baseRow('cyc-a', 'cyc-b', 2),
    baseRow('cyc-b', 'cyc-a', 3),
    baseRow('tri-a', 'tri-c', 2),
    baseRow('tri-b', 'tri-a', 3),
    baseRow('tri-c', 'tri-b', 4),
    baseRow('bad-depth', 'direct', 3), // immediate parent 'direct' has depth 1, so depth 3 is inconsistent
  ];
  const published = sourceSubagents(mixed, source, generation);
  assert.deepEqual(published.map(r => r.id), ['direct', 'leaf-missing-mid']);
});

test('R087: nativeSettingsScope and ClaudeNativeSettings tighten queryToken/appMode CAS checks and preserve frozen owner errors', async () => {
  const validScope = {
    app: 'claude-desktop',
    appMode: 'code',
    nativeCollection: 'claude-code-sessions',
    nativeConversationId: 'session-1',
    hostId: 'native-host',
    ownerGeneration: 'owner-1',
    runtimeGeneration: 'runtime-1',
    queryToken: 'query-token-1',
    cliSessionId: 'cli-1',
    settingsToken: 'a'.repeat(64),
  };
  assert.ok(nativeSettingsScope(validScope));
  assert.equal(nativeSettingsScope(Object.assign(new Date(), validScope)), null);
  assert.equal(nativeSettingsScope(Object.defineProperty({ ...validScope }, 'extra', { value: 1, enumerable: false })), null);
  assert.equal(nativeSettingsScope({ ...validScope, settingsToken: { toString: () => 'a'.repeat(64) } }), null);
  assert.equal(nativeSettingsScope({ ...validScope, appMode: 'chat' }), null);

  let readCalls = 0;
  let liveQueryToken = 'query-token-1';
  let driftMidRead = false;
  let throwFrozenEffort = false;
  const query = /** @type {Value} */ ({
    supportedModels: async () => {
      readCalls++;
      return [{ value: 'native-old', displayName: 'Old', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }];
    },
    supportedCommands: async () => [{ name: 'help' }],
    getContextUsage: async () => {
      if (driftMidRead) liveQueryToken = 'query-token-2';
      return { model: 'native-old' };
    },
    getSettings: async () => ({ applied: { effort: 'high' } }),
    setModel: async () => {},
    applyFlagSettings: async () => {
      if (throwFrozenEffort) {
        throw Object.freeze(Object.assign(Error('native-effort-frozen'), { code: 'ERR_FROZEN_OWNER', effectMayHaveOccurred: false }));
      }
    },
  });
  const value = /** @type {Value} */ ({
    sessionId: 'session-1',
    cliSessionId: 'cli-1',
    backend: { kind: 'local' },
    model: 'native-old',
    effort: 'high',
    modelChangeSeq: 0,
    modelRecordSeq: 0,
    isRunning: false,
    query,
  });
  const manager = /** @type {Value} */ ({
    sessions: new Map([['session-1', value]]),
    sessionModelSettings: { deps: { getSession: (/** @type {string} */ id) => id === 'session-1' ? value : null } },
    setModel: async () => {},
    setEffort: async (/** @type {string} */ _id, /** @type {string|null} */ effort) => { await query.applyFlagSettings({ effortLevel: effort }); },
  });
  const settings = new ClaudeNativeSettings({
    kind: 'code',
    writeVerified: true,
    readOnly: false,
    manager,
    api: () => ({ getSession: async () => ({ sessionId: 'session-1', isRunning: false, turnRunning: false, hasBackgroundActivity: false, hasBackgroundWork: false, starting: false }) }),
    mode: () => ({ clampSessionEffort: (_k = 'code', _m = '', effort = 'high') => effort }),
    scope: () => ({
      app: 'claude-desktop',
      appMode: 'code',
      nativeCollection: 'claude-code-sessions',
      nativeConversationId: 'session-1',
      hostId: 'native-host',
      ownerGeneration: 'owner-1',
      runtimeGeneration: 'runtime-1',
      queryToken: liveQueryToken,
      cliSessionId: 'cli-1',
    }),
    assertCurrent: (record, captured) => {
      if (record.query !== captured || captured !== query) throw Object.assign(Error('stale-query'), { effectMayHaveOccurred: false });
    },
  });

  const controls = await settings.read(value);
  assert.equal(readCalls, 1);

  // Stale queryToken CAS fails fast BEFORE invoking native read()
  await assert.rejects(
    settings.update(value, {
      model: 'native-old',
      reasoningEffort: 'low',
      expectedModel: 'native-old',
      expectedReasoningEffort: 'high',
      expectedScope: { ...controls.scope, queryToken: 'stale-query-token' },
    }),
    err => err instanceof Error && err.message === 'settings-conflict' && /** @type {Value} */ (err).effectMayHaveOccurred === false,
  );
  assert.equal(readCalls, 1);

  // Mismatched appMode ('chat') CAS fails fast BEFORE invoking native read()
  await assert.rejects(
    settings.update(value, {
      model: 'native-old',
      reasoningEffort: 'low',
      expectedModel: 'native-old',
      expectedReasoningEffort: 'high',
      expectedScope: { ...controls.scope, appMode: 'chat', nativeCollection: 'local-agent-mode-sessions' },
    }),
    err => err instanceof Error && err.message === 'settings-conflict' && /** @type {Value} */ (err).effectMayHaveOccurred === false,
  );
  assert.equal(readCalls, 1);

  // Mid-read queryToken drift is caught in read() even if assertCurrent only checked query identity
  driftMidRead = true;
  await assert.rejects(
    settings.read(value),
    err => err instanceof Error && err.message === 'stale-query' && /** @type {Value} */ (err).effectMayHaveOccurred === false,
  );
  driftMidRead = false;
  liveQueryToken = 'query-token-1';

  // Frozen owner error preserves code, message, cause, and effectMayHaveOccurred: true
  const freshControls = await settings.read(value);
  throwFrozenEffort = true;
  await assert.rejects(
    settings.update(value, {
      model: 'native-old',
      reasoningEffort: 'low',
      expectedModel: 'native-old',
      expectedReasoningEffort: 'high',
      expectedScope: freshControls.scope,
    }),
    err => err instanceof Error
      && err.message === 'native-effort-frozen'
      && /** @type {Value} */ (err).code === 'ERR_FROZEN_OWNER'
      && /** @type {Value} */ (err).effectMayHaveOccurred === true
      && /** @type {Value} */ (err).cause instanceof Error,
  );
});
