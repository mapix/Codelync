import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityBackend, AntigravityActivityObserver, antigravitySource, projectAntigravityTrajectory } from '../src/adapters/antigravity-backend.mjs';
import { fixtureSummaryReplica } from './helpers/antigravity-summary-replica.mjs';
import { antigravityHostId } from '../src/adapters/antigravity-rpc.mjs';
import { sourceKey } from '../src/codelync/source-registry.mjs';
import { BridgeError } from '../src/errors.mjs';

/** @typedef {Record<string,any>} Value */
const generation = 'antigravity:fixture-process-lifetime';
const runtime = { binary: '/fixture/Antigravity.app/Contents/Resources/bin/language_server', home: '/fixture/home', appDataDir: 'antigravity', generation };
test('native subagent directory preserves its role and real parent instead of a generic conversation title', () => {
  const child = antigravitySource('child-id', { createdTime: '2026-11-13T01:00:00Z', forkParentConversationId: 'ordinary-fork',
    trajectoryMetadata: { parentConversationId: 'real-parent', subagentSpec: { typeName: 'Worker', role: 'Protocol worker' } } }, generation, antigravityHostId(runtime));
  assert.equal(child.isSubagent, true); assert.equal(child.title, 'Protocol worker'); assert.equal(child.agentName, 'Protocol worker');
  assert.equal(child.parentId, 'real-parent'); assert.equal(child.createdAt, Date.parse('2026-11-13T01:00:00Z'));
  const fork = antigravitySource('fork-id', { forkParentConversationId: 'ordinary-fork', trajectoryMetadata: { parentConversationId: 'ordinary-fork' } }, generation, antigravityHostId(runtime));
  assert.equal(fork.isSubagent, false); assert.equal(fork.agentName, '');
});
/** @returns {Value} */
function reply() { return { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 3, trajectory: { trajectoryId: 'native-trajectory', cascadeId: 'native-cascade', steps: [
  { status: 'CORTEX_STEP_STATUS_DONE', userInput: { query: 'fixture input', clientMessageId: 'fixture-command' }, metadata: { createdAt: '2026-11-13T01:00:00Z', internalMetadata: { private: 'do not project' } } },
  { status: 'CORTEX_STEP_STATUS_DONE', runCommand: { commandLine: 'fixture command', cwd: '/fixture', combinedOutput: { full: 'fixture result' } }, metadata: { toolCall: { id: 'native-tool-id', name: 'run_command', argumentsJson: '{"command":"fixture command"}', thoughtSignature: 'do not project' } } },
  { status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'fixture final answer', rawThinking: 'do not project', thinkingSignature: 'do not project' } },
] } }; }
/** @param {Value} [initial] */
function fixture(initial = reply()) {
  let value = initial, reads = 0, generationValue = generation, failReadback = false;
  /** @type {Value} */ let residentHeaders = {};
  /** @type {Value[]} */ const mutations = [];
  const rpc = { latestRuntime: runtime, generation: () => generationValue, dispose: async () => {},
    call: async (/** @type {string} */ method, /** @type {Value} */ body = {}, /** @type {Value} */ options = {}) => {
      if (method === 'GetCascadeTrajectory') { reads++; if (failReadback && mutations.length) throw new BridgeError('source-epoch-changed', 'fixture changed owner'); return structuredClone(value); }
      if (method === 'GetAllCascadeTrajectories') { residentHeaders = { 'native-cascade': { summary: 'Fixture', trajectoryId: 'native-trajectory', stepCount: value.numTotalSteps, status: value.status, lastModifiedTime: '2026-11-13T01:00:00Z', workspaces: [{ workspaceFolderAbsoluteUri: 'file:///fixture' }] } }; return { trajectorySummaries: residentHeaders }; }
      mutations.push({ method, body, options });
      if (method === 'SendUserCascadeMessage') {
        value.trajectory.steps.push({ status: 'CORTEX_STEP_STATUS_DONE', userInput: { query: body.items[0].text, clientMessageId: body.clientMessageId } }); value.numTotalSteps++;
      }
      if (method === 'HandleCascadeUserInteraction') { value.trajectory.steps.at(-1).status = 'CORTEX_STEP_STATUS_DONE'; delete value.trajectory.steps.at(-1).requestedInteraction; }
      if (method === 'CancelCascadeInvocation') value.status = 'CASCADE_RUN_STATUS_IDLE';
      return {};
    } };
  const backend = new AntigravityBackend({ rpc, historyIndex: false, summaryStreamFactory: fixtureSummaryReplica(() => residentHeaders) });
  return { backend, rpc, mutations, reads: () => reads, value: () => value, changeOwner: () => { generationValue = 'new-owner'; }, loseReadback: () => { failReadback = true; } };
}

test('native trajectory projection retains message, tool and command identities while excluding hidden metadata', () => {
  const view = projectAntigravityTrajectory('native-cascade', reply(), generation);
  assert.equal(view.status, 'idle'); assert.equal(view.currentTurnId, null); assert.equal(view.historyComplete, true);
  assert.equal(view.rows[0].commandId, 'fixture-command'); assert.equal(view.rows[0].turnId, 'agy-turn:native-trajectory:0');
  assert.equal(view.rows[1].tools[0].id, 'native-tool-id'); assert.deepEqual(view.rows[1].tools[0].arguments, { command: 'fixture command' });
  assert.equal(view.rows[1].tools[0].output, 'fixture result'); assert.equal(view.rows[2].text, 'fixture final answer');
  assert.equal(JSON.stringify(view).includes('do not project'), false);
  const partial = reply(); partial.numTotalSteps = 99; assert.equal(projectAntigravityTrajectory('native-cascade', partial, generation).historyComplete, false);
  assert.throws(() => projectAntigravityTrajectory('another-cascade', reply(), generation), { code: 'antigravity-invalid-response' });
});

test('original and copied app namespaces isolate equal native conversation IDs and survive process restarts', () => {
  const original = antigravityHostId(runtime), probe = antigravityHostId({ ...runtime, home: '/fixture/probe-home' });
  assert.notEqual(original, probe); assert.equal(antigravityHostId({ ...runtime, generation: 'new-process' }), original);
  const source = antigravitySource('same-cascade', {}, generation, original), copy = antigravitySource('same-cascade', {}, generation, probe);
  assert.notEqual(sourceKey(source), sourceKey(copy));
});

test('resident and durable catalogue caches cannot reuse equal conversation IDs from another native namespace', async () => {
  const f = fixture(), originalCall = f.rpc.call; let indexReads = 0;
  f.rpc.call = async (method, body, options) => {
    const value = await originalCall(method, body, options);
    if (method === 'GetAllCascadeTrajectories') { indexReads++; value.trajectorySummaries['native-cascade'].summary = f.rpc.latestRuntime.home; }
    return value;
  };
  try {
    const first = await f.backend.list({ fresh: true });
    f.rpc.latestRuntime = { ...runtime, home: '/fixture/copy-home' }; f.changeOwner();
    const resident = await f.backend.list({ history: false });
    const catalogue = await f.backend.list();
    assert.equal(resident[0].title, '/fixture/copy-home'); assert.equal(catalogue[0].title, '/fixture/copy-home');
    assert.notEqual(first[0].hostId, catalogue[0].hostId); assert.equal(indexReads, 2);
  } finally { await f.backend.dispose(); }
});

test('a pending durable catalogue cannot block resident activity or the selected native message window', async () => {
  const f = fixture();
  let release = () => {}, entered = () => {}, complete = false;
  const started = new Promise(resolve => { entered = () => resolve(undefined); });
  const held = new Promise(resolve => { release = () => resolve(undefined); });
  f.backend.historyIndex = { merge: async summaries => { entered(); await held; complete = true; return { summaries, complete: false, stamp: 'partial', archivedIds: [] }; }, dispose: () => {} };
  const catalogue = f.backend.list({ fresh: true });
  try {
    await started;
    const status = await f.backend.activity('native-cascade');
    const selected = await Promise.race([f.backend.snapshot('native-cascade'), new Promise((_, reject) => setTimeout(() => reject(Error('Selected read waited for history catalogue')), 100))]);
    assert.equal(status.known, true); assert.equal(complete, false); assert.equal(selected.ownerGeneration, f.backend.generation());
    assert.equal(f.mutations.length, 0);
  } finally { release(); await catalogue; await f.backend.dispose(); }
});

test('owner drift during a held durable merge rejects its publication while resident activity can recover independently', async () => {
  const f = fixture(); let release = () => {}, entered = () => {};
  const started = new Promise(resolve => { entered = () => resolve(undefined); }), held = new Promise(resolve => { release = () => resolve(undefined); });
  f.backend.historyIndex = { merge: async summaries => { entered(); await held; return { summaries, complete: true, stamp: 'old', archivedIds: [] }; }, dispose: () => {} };
  const catalogue = f.backend.list({ fresh: true });
  try {
    await started; f.changeOwner();
    await f.backend.list({ fresh: true, history: false });
    assert.equal((await f.backend.activity('native-cascade')).known, true);
    release(); await assert.rejects(catalogue, { code: 'source-epoch-changed' });
    assert.equal(f.backend.inventoryComplete, false); assert.equal(f.backend.activityInventoryComplete, true);
  } finally { release(); await catalogue.catch(() => {}); await f.backend.dispose(); }
});

test('a cached idle parent publishes changing native child state without loading parent or child history again', async () => {
  const f = fixture(), originalCall = f.rpc.call; let childStatus = 'CASCADE_RUN_STATUS_RUNNING';
  f.rpc.call = async (method, body, options) => {
    const value = await originalCall(method, body, options);
    if (method === 'GetAllCascadeTrajectories') value.trajectorySummaries['native-child'] = { status: childStatus, trajectoryMetadata: { parentConversationId: 'native-cascade', subagentSpec: { role: 'Fixture worker' } } };
    return value;
  };
  /** @type {Value[]} */ const frames = [];
  let release = () => {};
  try {
    release = await f.backend.subscribe('native-cascade', view => frames.push(view));
    assert.equal(frames[0].subagents[0].status, 'running'); assert.equal(f.reads(), 1);
    const firstStamp = frames[0].contentStamp;
    childStatus = 'CASCADE_RUN_STATUS_IDLE'; await f.backend.list({ fresh: true, history: false });
    const end = Date.now() + 3000;
    while (!frames.some(frame => frame.subagents?.[0].status === 'idle')) { if (Date.now() > end) throw Error('Child update did not publish'); await new Promise(resolve => setTimeout(resolve, 10)); }
    const observed = frames.at(-1); assert.ok(observed);
    const latest = /** @type {Parameters<AntigravityBackend['withSubagents']>[1]} */ (/** @type {unknown} */ (observed));
    assert.equal(f.reads(), 1); assert.notEqual(latest.contentStamp, firstStamp);
    await f.backend.list({ fresh: true, history: false });
    const stable = f.backend.withSubagents('native-cascade', latest);
    assert.equal(stable.contentStamp, latest.contentStamp);
  } finally { release(); await f.backend.dispose(); }
});

test('a failed child index is explicit and cannot reuse a stale empty successful list', async () => {
  const f = fixture(), originalCall = f.rpc.call;
  try {
    const original = await f.backend.snapshot('native-cascade'); assert.equal(original.subagentsAvailable, true);
    f.rpc.call = async (method, body, options) => { if (method === 'GetAllCascadeTrajectories') throw new BridgeError('antigravity-rpc-unavailable', 'fixture index failed'); return originalCall(method, body, options); };
    f.backend.indexAt = 0;
    const unavailable = await f.backend.snapshot('native-cascade');
    assert.equal(unavailable.subagentsAvailable, false); assert.equal(unavailable.subagents, undefined);
  } finally { await f.backend.dispose(); }
});

test('an owner restart between parent and reduced child reads cannot promote old parent state into the new owner epoch', async () => {
  const f = fixture(), originalCall = f.rpc.call;
  f.rpc.call = async (method, body, options) => { const result = await originalCall(method, body, options); if (method === 'GetAllCascadeTrajectories') f.changeOwner(); return result; };
  try { await assert.rejects(f.backend.snapshot('native-cascade'), { code: 'source-epoch-changed' }); }
  finally { await f.backend.dispose(); }
});

test('send uses exact native clientMessageId admission and rejects stale owner/turn and arbitrary native fields before dispatch', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.backend.command('native-cascade', 'send', { text: 'fixture', gateway: 'foreign' }, 'stable-command-one'), { code: 'invalid-input' });
    await assert.rejects(f.backend.command('native-cascade', 'send', { text: 'fixture' }, 'stable-command-one', { expectedGeneration: 'old-owner' }), { code: 'source-epoch-changed' });
    assert.equal(f.mutations.length, 0);
    const sent = await f.backend.command('native-cascade', 'send', { text: 'new fixture input' }, 'stable-command-one', { expectedGeneration: generation });
    assert.equal(sent.admitted, true); assert.match(sent.messageId, /^agy:/); assert.equal(f.mutations[0].body.clientMessageId, 'stable-command-one');
    assert.deepEqual(f.mutations[0].body.items, [{ text: 'new fixture input' }]); assert.equal(f.mutations[0].options.expectedGeneration, generation);
  } finally { await f.backend.dispose(); }
});

test('a successful native dispatch followed by failed owner readback is unknown rather than a safe rejection', async () => {
  const f = fixture(); f.loseReadback();
  try { await assert.rejects(f.backend.command('native-cascade', 'send', { text: 'fixture' }, 'stable-command-one'), { code: 'delivery-unknown', nativeCause: 'source-epoch-changed' }); assert.equal(f.mutations.length, 1); }
  finally { await f.backend.dispose(); }
});

test('native stop remains conversation-scoped and reports the observed state without asserting empty JSON meant stopped', async () => {
  const input = reply(); input.status = 'CASCADE_RUN_STATUS_RUNNING';
  const f = fixture(input);
  try {
    const view = await f.backend.snapshot('native-cascade');
    await assert.rejects(f.backend.command('native-cascade', 'interrupt', { turnId: 'stale-turn' }, 'stable-stop-command'), { code: 'stale-turn' }); assert.equal(f.mutations.length, 0);
    const result = await f.backend.command('native-cascade', 'interrupt', { turnId: view.currentTurnId }, 'stable-stop-command');
    assert.equal(result.cancelRequested, true); assert.equal(result.observedStatus, 'idle'); assert.equal(result.foregroundActive, false); assert.equal(Object.hasOwn(result, 'cancelled'), false);
    assert.deepEqual(f.mutations[0].body, { cascadeId: 'native-cascade' });
  } finally { await f.backend.dispose(); }
});

test('native questions reconstruct exact option IDs only for the current trajectory step, and pending readback stays unknown', async () => {
  const input = reply(); input.status = 'CASCADE_RUN_STATUS_RUNNING'; input.numTotalSteps++;
  input.trajectory.steps.push({ status: 'CORTEX_STEP_STATUS_WAITING', requestedInteraction: { askQuestion: { questions: [{ question: 'Choose a fixture option', options: [{ id: 'native-option-one', text: 'Protocol' }, { id: 'native-option-two', text: 'UI' }] }] } }, askQuestion: { questions: [] } });
  const f = fixture(input);
  try {
    const view = await f.backend.snapshot('native-cascade'), request = view.requests[0]; assert.equal(view.status, 'waiting'); assert.equal(request.kind, 'user-input');
    await assert.rejects(f.backend.command('native-cascade', 'approval', { kind: 'user-input', requestId: 'foreign-step', response: { answers: { q0: { answers: ['UI'] } } } }, 'stable-answer-command'), { code: 'stale-approval' });
    const result = await f.backend.command('native-cascade', 'approval', { kind: 'user-input', requestId: request.requestId, response: { answers: { q0: { answers: ['UI'] } } } }, 'stable-answer-command');
    assert.equal(result.answered, true); assert.equal(f.mutations.length, 1);
    assert.equal(f.mutations[0].body.interaction.trajectoryId, 'native-trajectory'); assert.equal(f.mutations[0].body.interaction.stepIndex, 3);
    assert.deepEqual(f.mutations[0].body.interaction.askQuestion.responses[0].selectedOptionIds, ['native-option-two']);
  } finally { await f.backend.dispose(); }
});

test('every shared subscriber gets an initial frame and unchanged idle summaries do not reload full history', async () => {
  const f = fixture(); await f.backend.list(); let first = 0, second = 0;
  try {
    const releaseOne = await f.backend.subscribe('native-cascade', () => { first++; });
    const reads = f.reads(); const releaseTwo = await f.backend.subscribe('native-cascade', () => { second++; });
    assert.equal(first, 1); assert.equal(second, 1); assert.equal(f.reads(), reads);
    releaseTwo(); releaseOne(); assert.equal(f.backend.sessions.size, 0);
  } finally { await f.backend.dispose(); }
});

test('continuous foreground summary activity remains current without history or capture-time renewal', async () => {
  const f = fixture(); let now = Date.now(); const observer = new AntigravityActivityObserver({ id: 'native-cascade', backend: f.backend, now: () => now });
  try {
    await observer.refresh(); assert.equal(observer.status().known, true); assert.equal(observer.status().active, false); assert.equal(f.reads(), 0);
    const capturedAt = observer.status().observedAt;
    now += 6000; assert.equal(observer.status().known, true); assert.equal(observer.status().observedAt, capturedAt); assert.equal(observer.refreshDueAt(), null);
  } finally { observer.close(); await f.backend.dispose(); }
});

test('idle parent foreground aggregate includes waiting children and unknown rosters without child history reads', async () => {
  const f = fixture(), originalCall = f.rpc.call; let childStatus = 'CASCADE_RUN_STATUS_RUNNING', complete = true;
  f.rpc.call = async (method, body, options) => {
    const value = await originalCall(method, body, options);
    if (method === 'GetAllCascadeTrajectories') {
      value.trajectorySummaries['native-cascade'].hasRunningSubagents = !complete;
      value.trajectorySummaries.child = { status: childStatus, waitingSteps: childStatus === 'CASCADE_RUN_STATUS_RUNNING' ? [0] : [],
        trajectoryMetadata: { parentConversationId: 'native-cascade', subagentSpec: { role: 'Worker' } } };
    }
    return value;
  };
  try {
    const running = await f.backend.activity('native-cascade');
    assert.equal(running.ownActive, false); assert.equal(running.active, true); assert.equal(running.waiting, true);
    assert.equal(running.aggregateActivity.status, 'waiting'); assert.equal(f.reads(), 0);
    childStatus = 'FUTURE_RUN_STATUS'; await f.backend.list({ fresh: true, history: false });
    const unknown = await f.backend.activity('native-cascade');
    assert.equal(unknown.known, false); assert.equal(unknown.aggregateActivity.unknownChildren, 1);
    childStatus = 'CASCADE_RUN_STATUS_IDLE'; complete = false; await f.backend.list({ fresh: true, history: false });
    const incomplete = await f.backend.activity('native-cascade');
    assert.equal(incomplete.aggregateActivity.rosterAvailable, true); assert.equal(incomplete.aggregateActivity.rosterComplete, false);
    assert.equal(incomplete.active, true); assert.equal(f.reads(), 0);
  } finally { await f.backend.dispose(); }
});

test('failed current child read cannot reuse old native busy hints and owner changes invalidate cached activity', async () => {
  const f = fixture(), originalCall = f.rpc.call;
  f.rpc.call = async (method, body, options) => { const value = await originalCall(method, body, options);
    if (method === 'GetAllCascadeTrajectories') value.trajectorySummaries['native-cascade'].hasRunningSubagents = true;
    return value; };
  const observer = new AntigravityActivityObserver({ id: 'native-cascade', backend: f.backend });
  try {
    const view = await f.backend.snapshot('native-cascade'); assert.equal(view.aggregateActivity.active, true);
    const unavailable = f.backend.withSubagents('native-cascade', view, {}, false);
    assert.equal(unavailable.aggregateActivity.known, false); assert.equal(unavailable.aggregateActivity.active, false);
    await observer.refresh(); assert.equal(observer.status().known, true);
    f.changeOwner(); assert.equal(observer.status().known, false); assert.equal(observer.status().active, false);
    assert.equal(f.reads(), 1);
  } finally { observer.close(); await f.backend.dispose(); }
});

test('large resident roster groups are scanned linearly and share one native summary read', async () => {
  const parentCount = 2000;
  let metadataReads = 0, indexReads = 0;
  const summaries = /** @type {Value} */ ({});
  for (let i = 0; i < parentCount; i++) {
    summaries[`parent-${i}`] = { status: 'CASCADE_RUN_STATUS_IDLE' };
    for (let n = 0; n < 2; n++) summaries[`child-${i}-${n}`] = { status: 'CASCADE_RUN_STATUS_RUNNING',
      get trajectoryMetadata() { metadataReads++; return { parentConversationId: `parent-${i}`, subagentSpec: { role: 'Worker' } }; },
      get steps() { throw Error('Child history must not be read'); } };
  }
  const backend = new AntigravityBackend({ historyIndex: false, now: () => 1000, rpc: { latestRuntime: runtime, generation: () => generation,
    call: async (/** @type {string} */ method) => {
      assert.equal(method, 'GetAllCascadeTrajectories'); indexReads++; return { trajectorySummaries: summaries };
    } } });
  try {
    const start = performance.now(); await backend.list({ fresh: true, history: false });
    assert.ok(performance.now() - start < 3000, 'A bounded 6000-row index must remain responsive');
    assert.ok(metadataReads < parentCount * 20, `Expected linear metadata reads, got ${metadataReads}`);
    for (let i = 0; i < 50; i++) { const value = await backend.activity(`parent-${i}`);
      assert.equal(value.active, true); assert.equal(value.ownActive, false); assert.equal(value.aggregateActivity.childCount, 2); }
    assert.equal(indexReads, 1);
  } finally { await backend.dispose(); }
});
