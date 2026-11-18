import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { installClaudeOwnerBridge } from '../src/adapters/claude-owner-bridge.mjs';
import { NativeCatalogDeltas } from '../src/codelync/recent-data.mjs';

/** @typedef {Record<string, any>} Value */

/** @param {(ctx: Value) => Promise<void>} run */
async function withClaudeBridge(run) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-b6-'));
  const artifact = join(dir, 'app.asar');
  const metadata = join(dir, 'meta.json');
  const runtimePath = join(dir, 'runtime.json');
  await writeFile(artifact, 'native fixture');
  await writeFile(metadata, JSON.stringify({ appliedId: 'fixture' }));

  const sessionA = /** @type {Value} */ ({ sessionId: 'sess-a', createdAt: 1, query: { id: 'q1' }, cliSessionId: 'cli-a', isRunning: true });
  const sessionB = /** @type {Value} */ ({ sessionId: 'sess-b', createdAt: 2, query: { id: 'q2' }, cliSessionId: 'cli-b', isRunning: true });

  const manager = /** @type {any} */ (new EventEmitter());
  manager.sessions = new Map([[sessionA.sessionId, sessionA], [sessionB.sessionId, sessionB]]);
  manager.permissionBroker = { pendingPermissions: new Map() };
  /** @type {(sessionId: string, a1: any, a2: any, opts: any) => Promise<{queued:boolean}>} */
  const baseSendMessage = async (_id, _msg, _u1, _opts) => ({ queued: false });
  manager.sendMessage = baseSendMessage;

  const lam = /** @type {any} */ (new EventEmitter());
  lam.sessions = new Map();
  lam.permissionBroker = { pendingPermissions: new Map() };

  let interrupts = 0;
  /** @type {((id: string) => Promise<Value>) | null} */
  let getSessionHook = null;
  /** @type {((args: any[]) => Promise<void>) | null} */
  let rendererSendHook = null;

  const native = {
    LocalSessions: {
      getSession: async (/** @type {string} */ id) => getSessionHook ? getSessionHook(id) : ({ sessionId: id, isRunning: manager.sessions.get(id)?.isRunning === true }),
      interrupt: async () => { interrupts += 1; },
      sendMessage: async (/** @type {any[]} */ ...args) => {
        if (rendererSendHook) return rendererSendHook(args);
        return manager.sendMessage(args[0], args[1], undefined, { messageUuid: args[7] });
      },
    },
  };

  const wc = /** @type {any} */ (new EventEmitter());
  wc.isDestroyed = () => false;
  wc.getURL = () => 'app://localhost/new';
  wc.mainFrame = {
    executeJavaScript: (/** @type {string} */ script) => runInNewContext(script, {
      location: new URL(wc.getURL()),
      window: { 'claude.web': native },
    }),
  };

  const main = {
    Hft: () => ({ type: '3p', getProvider: () => ({ creds: { provider: 'gateway' } }), managesProviderRouting: () => true }),
    Lut: () => ({ inference: { provider: 'gateway', baseUrl: 'https://fixture.invalid', credential: { kind: 'static' } }, codeSurface: { enabled: true }, chatSurface: { enabled: true } }),
    Fut: () => ({ type: 'local' }),
    Wdt: () => metadata,
    bdt: () => true,
    r3: () => 'allowed',
  };

  const app = /** @type {any} */ (new EventEmitter());
  app.getVersion = () => '4.16336.0';
  app.getAppPath = () => artifact;
  app.getPath = () => dir;

  const nativeRequire = createRequire(import.meta.url);
  const hostRequire = (/** @type {string} */ path) => {
    if (/index\.chunk-(yo8W6L7k|DzkpfKOD)/.test(path)) throw new Error('Native factory must not run');
    return path === 'original-fs' ? fs
      : path.includes('index.chunk-Du-Wqi0E') ? main
      : path.includes('index.chunk-CqaSnEfn') ? { claudeCodeSessionManager: manager }
      : path.includes('index.chunk-vuRwhTdh') ? { n: lam }
      : nativeRequire(path);
  };

  const bridge = await installClaudeOwnerBridge({
    electron: { app, webContents: { getAllWebContents: () => [wc] } },
    hostRequire,
    runtimePath,
    expectedAsarSha256: createHash('sha256').update('native fixture').digest('hex'),
  });
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  const call = async (/** @type {string} */ method, /** @type {Value} */ params, /** @type {string} */ commandId) => {
    const res = await fetch(runtime.origin + '/rpc', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + runtime.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, method, params, ...(commandId ? { commandId } : {}) }),
    });
    return res.json();
  };

  try {
    await run({
      bridge,
      manager,
      baseSendMessage,
      sessionA,
      sessionB,
      call,
      interrupts: () => interrupts,
      setGetSessionHook: (/** @type {typeof getSessionHook} */ fn) => { getSessionHook = fn; },
      setRendererSendHook: (/** @type {typeof rendererSendHook} */ fn) => { rendererSendHook = fn; },
      emit: (/** @type {string} */ sessionId, /** @type {Value} */ message) => manager.emit('event', { type: 'message', sessionId, message }),
    });
  } finally {
    await bridge.deactivate();
    await rm(dir, { recursive: true, force: true });
  }
}

test('R052: code.events validates cursor bounds, enforces expectedExecutionToken, avoids foreign-session starvation and sets resetRequired on ring truncation', async () => withClaudeBridge(async f => {
  const initial = await f.call('code.events', { sessionId: 'sess-a', cursor: 0 });
  assert.equal(initial.ok, true);
  const execToken = initial.result.executionToken;

  // Reject invalid cursor shapes and out-of-range cursors fail-closed.
  for (const badCursor of [-1, 1.5, '0', null, 99]) {
    const bad = await f.call('code.events', { sessionId: 'sess-a', cursor: badCursor });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'invalid-event-cursor');
  }

  // Enforce expectedExecutionToken fence when provided.
  const wrongToken = await f.call('code.events', { sessionId: 'sess-a', cursor: 0, expectedExecutionToken: 'stale-token' });
  assert.equal(wrongToken.ok, false);
  assert.equal(wrongToken.error.code, 'stale-query');

  // Emit 120 events on sess-b, then 2 events on sess-a -> single poll for sess-a retrieves both without starvation!
  for (let i = 0; i < 120; i += 1) f.emit('sess-b', { type: 'assistant', uuid: `b-${i}`, message: { content: `b-${i}` } });
  f.emit('sess-a', { type: 'assistant', uuid: 'a-first', message: { content: 'a-first' } });
  f.emit('sess-a', { type: 'assistant', uuid: 'a-second', message: { content: 'a-second' } });

  const page = await f.call('code.events', { sessionId: 'sess-a', cursor: 0, expectedExecutionToken: execToken });
  assert.equal(page.ok, true);
  assert.equal(page.result.resetRequired, false);
  assert.deepEqual(page.result.events.map((/** @type {Value} */ e) => e.message.uuid), ['a-first', 'a-second']);
  assert.equal(page.result.cursor, 122);

  // Push > 512 events to truncate ring buffer -> cursor 0 falls below oldest -> resetRequired: true.
  for (let i = 0; i < 420; i += 1) f.emit('sess-b', { type: 'assistant', uuid: `b-ovf-${i}`, message: { content: `b-overflow-${i}` } });
  const truncated = await f.call('code.events', { sessionId: 'sess-a', cursor: 10 });
  assert.equal(truncated.ok, true);
  assert.equal(truncated.result.resetRequired, true);
  assert.deepEqual(truncated.result.events.map((/** @type {Value} */ e) => e.message.uuid), ['a-first', 'a-second']);

  // Swap query execution -> old executionToken events from ring are isolated and rejected on stale fence.
  f.sessionA.query = { id: 'q2' };
  const stale = await f.call('code.events', { sessionId: 'sess-a', cursor: truncated.result.cursor, expectedExecutionToken: execToken });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'stale-query');
}));

test('R052: concurrent code.send shares reversible sendMessage wrapper cleanly without leaking or clobbering across rejection and deactivation', async () => withClaudeBridge(async f => {
  const tokenA = (await f.call('code.events', { sessionId: 'sess-a' })).result.executionToken;
  const tokenB = (await f.call('code.events', { sessionId: 'sess-b' })).result.executionToken;

  /** @type {Map<string, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
  const gates = new Map();
  f.manager.sendMessage = async (/** @type {string} */ id, /** @type {string} */ _msg, /** @type {any} */ _u, /** @type {Value} */ opts) => {
    return new Promise((resolve, reject) => {
      gates.set(`${id}:${opts.messageUuid}`, { resolve, reject });
    });
  };
  const originalSend = f.manager.sendMessage;

  const uuidA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const uuidB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const sendA = f.call('code.send', { sessionId: 'sess-a', message: 'msg A', messageUuid: uuidA, expectedExecutionToken: tokenA }, 'cmd-send-a-01');
  const sendB = f.call('code.send', { sessionId: 'sess-b', message: 'msg B', messageUuid: uuidB, expectedExecutionToken: tokenB }, 'cmd-send-b-01');

  while (gates.size < 2) await new Promise(resolve => setTimeout(resolve, 5));

  // Complete sendA FIRST (before sendB) -> sendB still receives its queued result, and sendA rejection/completion does NOT restore wrapper early or leak.
  gates.get(`sess-a:${uuidA}`)?.resolve({ queued: true });
  const resA = await sendA;
  assert.equal(resA.ok, true);
  assert.equal(resA.result.queued, true);
  // Wrapper remains active until sendB finishes.
  assert.notEqual(f.manager.sendMessage, originalSend);

  gates.get(`sess-b:${uuidB}`)?.reject(new Error('send-b-aborted'));
  const resB = await sendB;
  assert.equal(resB.ok, false);
  // Original manager.sendMessage reference is cleanly restored once all concurrent sends finish!
  assert.equal(f.manager.sendMessage, originalSend);

  // Deactivate during an in-flight send -> wrapper is immediately restored synchronously on deactivate().
  gates.clear();
  const uuidC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const sendC = f.call('code.send', { sessionId: 'sess-a', message: 'msg C', messageUuid: uuidC, expectedExecutionToken: tokenA }, 'cmd-send-c-01');
  while (!gates.has(`sess-a:${uuidC}`)) await new Promise(resolve => setTimeout(resolve, 5));
  await f.bridge.deactivate();
  assert.equal(f.manager.sendMessage, originalSend);
  gates.get(`sess-a:${uuidC}`)?.resolve({ queued: false });
  await sendC.catch(() => {});
}));

test('R052: code.interrupt rechecks owner/query fences after pre-dispatch getSession and refuses stale interrupt before side effect', async () => withClaudeBridge(async f => {
  const tokenA = (await f.call('code.events', { sessionId: 'sess-a' })).result.executionToken;

  f.setGetSessionHook(async (/** @type {string} */ id) => {
    // Query rotates concurrently while getSession is in flight.
    f.sessionA.query = { id: 'q-replaced' };
    return { sessionId: id, isRunning: true };
  });

  const interrupted = await f.call('code.interrupt', { sessionId: 'sess-a', expectedExecutionToken: tokenA }, 'cmd-interrupt-01');
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.error.code, 'stale-query');
  assert.equal(interrupted.effectMayHaveOccurred, false);
  assert.equal(f.interrupts(), 0);
}));

/** @param {number} index @param {number} [updatedAt] */
function makeCatalogEntry(index, updatedAt = 1000 + index) {
  const source = {
    app: 'codex',
    id: `native-${index}`,
    hostId: 'local',
    workspace: '/fixture/project',
    updatedAt,
    title: `Title ${index}`,
  };
  return {
    source,
    binding: {
      happySessionId: `happy-${index}`,
      metadataVersion: 1,
      machineId: 'machine-1',
      metadata: {
        machineId: 'machine-1',
        client: { id: 'noninvasive-bridge' },
        bridge: { source, controlMode: 'session' },
        nativeSession: { catalogueAvailable: true },
      },
    },
  };
}

test('R057: NativeCatalogDeltas avoids redundant structuredClone on unchanged/delta/maintained pages while keeping full immutability', () => {
  const entries = Array.from({ length: 400 }, (_, i) => makeCatalogEntry(i));
  const originalStructuredClone = globalThis.structuredClone;
  let cloneCalls = 0;

  try {
    globalThis.structuredClone = (/** @type {any[]} */ ...args) => {
      cloneCalls += 1;
      return /** @type {any} */ (originalStructuredClone)(...args);
    };

    // Unmaintained catalog: unchanged delta performs 0 structuredClone calls; 1-row delta clones only 1 snapshot + 1 page row!
    const unmaintained = new NativeCatalogDeltas({ maintained: false });
    const full = unmaintained.page(entries, { limit: 100 }, 'machine-1');
    // 1 batch clone in page snapshot + 1 batch clone for returned slice = 2 calls (not 3).
    assert.equal(cloneCalls, 2);

    cloneCalls = 0;
    const unchanged = unmaintained.page(entries, { since: full.watermark }, 'machine-1');
    assert.equal(unchanged.mode, 'delta');
    assert.deepEqual(unchanged.sessions, []);
    assert.equal(cloneCalls, 0);

    entries[0].source.title = 'Changed 0';
    entries[0].binding.metadataVersion += 1;
    cloneCalls = 0;
    const oneChange = unmaintained.page(entries, { since: full.watermark }, 'machine-1');
    assert.equal(oneChange.sessions.length, 1);
    assert.equal(cloneCalls, 2);
    // Mutating returned session cannot corrupt retained snapshot.
    oneChange.sessions[0].metadata.client.id = 'caller-mutated';
    oneChange.sessions[0].metadata.nativeSession.title = 'Caller Mutated';

    // Maintained catalog: refresh clones once in capture(); page() stores immutable references without re-cloning all 400 rows!
    const maintained = new NativeCatalogDeltas({ maintained: true });
    cloneCalls = 0;
    maintained.refresh(entries, 'machine-1');
    assert.equal(cloneCalls, 1);

    cloneCalls = 0;
    const mPage1 = maintained.page([], { limit: 10 }, 'machine-1');
    assert.equal(mPage1.sessions.length, 10);
    // Only the 10-row output slice is cloned in page() (not snapshot.changed).
    assert.equal(cloneCalls, 1);

    cloneCalls = 0;
    const mUnchanged = maintained.page([], { since: mPage1.watermark }, 'machine-1');
    assert.equal(mUnchanged.sessions.length, 0);
    assert.equal(cloneCalls, 0);

    // Mutate returned mPage1 objects AND mutate source entries after capture -> maintained snapshots and cursor pages remain untouched!
    mPage1.sessions[0].metadata.client.id = 'caller-mutated';
    mPage1.sessions[0].metadata.nativeSession.title = 'Caller Mutated';
    entries[10].source.title = 'Source Mutated After Refresh';
    entries[10].binding.metadata.client.id = 'source-mutated';

    const mPage2 = maintained.page([], { limit: 400, cursor: mPage1.nextCursor }, 'machine-1');
    assert.equal(mPage2.sessions.find((/** @type {Value} */ r) => r.id === 'happy-10')?.metadata.nativeSession.title, 'Title 10');
    assert.equal(mPage2.sessions.find((/** @type {Value} */ r) => r.id === 'happy-10')?.metadata.client.id, 'noninvasive-bridge');

    const legacy = maintained.legacyPage({ limit: 5 }, 'machine-1');
    assert.equal(legacy.sessions[0].metadata.client.id, 'noninvasive-bridge');
    legacy.sessions[0].metadata.client.id = 'legacy-mutated';
    const legacyAgain = maintained.legacyPage({ limit: 5 }, 'machine-1');
    assert.equal(legacyAgain.sessions[0].metadata.client.id, 'noninvasive-bridge');
  } finally {
    globalThis.structuredClone = originalStructuredClone;
  }
});
