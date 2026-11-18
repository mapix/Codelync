import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceImageAdapter, createBoundSource } from '../src/codelync/bound-source.mjs';
import { sourceKey } from '../src/codelync/source-registry.mjs';
import { ClaudeDesktopRpcClient, readClaudeDesktopRuntime, claudeDesktopHostId } from '../src/adapters/claude-desktop-rpc.mjs';
import { BridgeError } from '../src/errors.mjs';

/** @typedef {Record<string,any>} Value */

function savedView() {
  return {
    status: 'history-only',
    ownerGeneration: null,
    currentTurnId: null,
    requests: [],
    historyComplete: false,
    rows: [{ id: 'saved-1', role: 'assistant', text: 'Saved text', turnId: null, displayTurnId: 'saved-turn', order: 100 }],
    historicalRead: {
      app: 'codex',
      version: 1,
      available: true,
      originator: 'Codex Desktop',
      nativeId: 'native-child',
      hostId: 'local',
      namespaceHash: 'a'.repeat(64),
      sourceStamp: 'b'.repeat(64),
      byteBoundary: { start: 100, end: 200, total: 200 },
      trailingIncomplete: false,
      lastLifecycle: { type: 'turn_aborted', turnId: 'native-turn', terminalObserved: true },
    },
  };
}

test('R032: SourceImageAdapter.freshSnapshot falls through to live freshSnapshot when readHistoricalPage fails', async () => {
  let failSaved = false;
  let freshCalls = 0;
  const live = { status: 'running', ownerGeneration: 'live-owner', currentTurnId: 'turn-live', rows: [], requests: [] };
  const adapter = {
    supportsNativeSavedHistory: true,
    generation: () => null,
    readHistoricalPage: async () => {
      if (failSaved) throw new BridgeError('codex-history-read-unavailable', 'Saved rollout rotated.', 503);
      return savedView();
    },
    snapshot: async () => { throw new Error('Must not call snapshot when terminal saved succeeds'); },
    freshSnapshot: async () => { freshCalls += 1; return live; },
  };
  const wrapped = new SourceImageAdapter(adapter, /** @type {any} */ ({}), { app: 'codex', kind: 'session', hostId: 'local', isSubagent: true });

  const initial = await wrapped.snapshot('native-child');
  assert.equal(initial.status, 'history-only');
  assert.equal(wrapped.latest?.historicalRead?.available, true);

  failSaved = true;
  const refreshed = await wrapped.freshSnapshot('native-child');
  assert.equal(freshCalls, 1);
  assert.equal(refreshed.ownerGeneration, 'live-owner');
  assert.equal(refreshed.status, 'running');
});

test('R032: createBoundSource constructor preserves original error when rollback releaseLease rejects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-bound-b4-'));
  const activeDir = join(dir, 'active');
  const leaseDir = join(dir, 'leases');
  const source = { app: 'codex', hostId: 'local', id: 'fixture-rollback' };
  const markerLock = join(leaseDir, `${sourceKey(source)}.source.lock`);
  let accesses = 0;
  const binding = {
    source,
    happySessionId: 'happy-rollback',
    sessionKey: Buffer.alloc(32, 9).toString('base64'),
    get metadata() {
      accesses += 1;
      if (accesses === 3) {
        // Compromised/removed lock causes releaseLease() to reject during rollback.
        rmSync(markerLock, { recursive: true, force: true });
        throw new BridgeError('constructor-boom', 'Original initialization failure.');
      }
      return {};
    },
  };
  try {
    await assert.rejects(
      createBoundSource({
        directory: activeDir,
        leaseDirectory: leaseDir,
        account: { serverUrl: 'http://127.0.0.1:1', token: 'fixture-token' },
        binding,
        adapter: { dispose: () => {} },
      }),
      { code: 'constructor-boom', message: 'Original initialization failure.' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('R037: taskFeed validates optional expectedOwnerGeneration and expectedExecutionToken before dispatch', async () => {
  const runtime = { origin: 'http://127.0.0.1:5555', generation: 'owner-1', storagePath: '/fixture/profile', accessToken: 'private' };
  let sends = 0;
  const client = new ClaudeDesktopRpcClient({
    readRuntime: async () => runtime,
    fetch: async () => {
      sends += 1;
      return new Response(JSON.stringify({ version: 1, ok: true, ownerGeneration: runtime.generation, hostId: claudeDesktopHostId(runtime), result: { events: [] } }));
    },
  });

  const invalidOwnerValues = ['', '   ', null, 123, { bad: true }, 'a'.repeat(513), 'bad\nline', 'bad\x00null'];
  for (const bad of invalidOwnerValues) {
    await assert.rejects(
      client.call('code.taskFeed', { sessionId: 'parent-1', expectedOwnerGeneration: bad }),
      { code: 'invalid-task-request' },
    );
  }

  const invalidTokenValues = ['', '   ', 123, ['arr'], 't'.repeat(513), 'tok\x7fctrl'];
  for (const bad of invalidTokenValues) {
    await assert.rejects(
      client.call('cowork.taskFeed', { sessionId: 'parent-1', expectedExecutionToken: bad }),
      { code: 'invalid-task-request' },
    );
  }
  assert.equal(sends, 0);

  // Valid string tokens and nullable idle expectedExecutionToken are accepted.
  await client.call('code.taskFeed', { sessionId: 'parent-1', expectedOwnerGeneration: 'owner-1', expectedExecutionToken: null });
  await client.call('cowork.taskFeed', { sessionId: 'parent-1', expectedOwnerGeneration: 'owner-1', expectedExecutionToken: 'query-token-1' });
  assert.equal(sends, 2);
});

test('R037: readClaudeDesktopRuntime bounds ASAR artifactCache in LRU order without stale hits after eviction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-asar-lru-'));
  const fixedTime = new Date(1_700_000_000_000);
  const sha256 = (/** @type {string} */ content) => createHash('sha256').update(Buffer.from(content)).digest('hex');
  /** @param {number} index @param {string} content */
  const makeBundle = async (index, content) => {
    const appDir = join(root, `App-${index}.app`, 'Contents');
    const macosDir = join(appDir, 'MacOS');
    const resDir = join(appDir, 'Resources');
    await mkdir(macosDir, { recursive: true });
    await mkdir(resDir, { recursive: true });
    const executable = join(macosDir, 'Claude');
    const asar = join(resDir, 'app.asar');
    const storagePath = join(root, `profile-${index}`);
    const runtimePath = join(root, `runtime-${index}.json`);
    await writeFile(executable, 'fixture-bin');
    await writeFile(asar, content);
    await utimes(asar, fixedTime, fixedTime);
    await mkdir(storagePath, { recursive: true });
    const manifest = {
      version: 1,
      protocol: 'claude-desktop-native',
      pid: 100 + index,
      parentPid: 1,
      startTime: 'Mon Jan 1 00:00:00 2026',
      executable,
      storagePath,
      origin: 'http://127.0.0.1:5555',
      bootEpoch: 'a'.repeat(32),
      accessToken: 'b'.repeat(64),
      asarSha256: sha256(content),
    };
    await writeFile(runtimePath, JSON.stringify(manifest), { mode: 0o600 });
    return { runtimePath, executable, asar, manifest };
  };

  try {
    const app0 = await makeBundle(0, 'AAAA');
    await readClaudeDesktopRuntime(app0.runtimePath, async () => ({ ...app0.manifest }));

    // Replace bytes in app0.asar preserving size, inode, and mtimeMs to prove cache hit before eviction.
    const before = await stat(app0.asar);
    await writeFile(app0.asar, 'BBBB');
    await utimes(app0.asar, fixedTime, fixedTime);
    const after = await stat(app0.asar);
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    await readClaudeDesktopRuntime(app0.runtimePath, async () => ({ ...app0.manifest }));

    // Insert 32 distinct newer bundles -> total 33, evicting oldest (app0) under MAX_ARTIFACT_CACHE=32.
    const bundles = await Promise.all(
      Array.from({ length: 32 }, (_, offset) => makeBundle(offset + 1, `C${String(offset + 1).padStart(3, '0')}`)),
    );
    for (const b of bundles) {
      await readClaudeDesktopRuntime(b.runtimePath, async () => ({ ...b.manifest }));
    }

    // app0 was evicted, so its ASAR is re-read and mismatches the stale manifest digest.
    await assert.rejects(
      readClaudeDesktopRuntime(app0.runtimePath, async () => ({ ...app0.manifest })),
      { code: 'source-artifact-changed' },
    );

    // Newest bundle (#32) remains cached even with modified bytes + preserved stamp.
    const newest = bundles[bundles.length - 1];
    await writeFile(newest.asar, 'ZZZZ');
    await utimes(newest.asar, fixedTime, fixedTime);
    await readClaudeDesktopRuntime(newest.runtimePath, async () => ({ ...newest.manifest }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
