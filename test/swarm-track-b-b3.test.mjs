import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BundledCodexStorage } from '../src/codelync/bundled-codex-storage.mjs';
import { CodexIpcAdapter } from '../src/adapters/codex-ipc.mjs';

/** @typedef {Record<string, any>} Frame */

/** @param {Frame} value */
function encode(value) {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(body.length + 4);
  frame.writeUInt32LE(body.length);
  body.copy(frame, 4);
  return frame;
}

/** @param {net.Socket} socket @param {Frame} request @param {Frame} result @param {string} [owner] */
function reply(socket, request, result, owner = request.targetClientId ?? 'desktop-owner') {
  socket.write(encode({
    type: 'response',
    requestId: request.requestId,
    method: request.method,
    resultType: 'success',
    handledByClientId: owner,
    result,
  }));
}

/** @param {()=>boolean} predicate */
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Test condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** @param {import('node:test').TestContext} t @param {{timeoutMs?:number,onStatus?:(frame:Frame)=>void}} [options]
 * @param {(frame:Frame,socket:net.Socket)=>boolean|void} [onRequest] */
async function ipcFixture(t, options = {}, onRequest = () => false) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-ipc-b3-'));
  const socketPath = join(directory, 'router.sock');
  /** @type {Frame[]} */ const frames = [];
  /** @type {Set<net.Socket>} */ const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE();
        if (buffer.length < length + 4) return;
        const frame = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        frames.push(frame);
        if (onRequest(frame, socket)) continue;
        if (frame.type !== 'request') continue;
        if (frame.method === 'initialize') reply(socket, frame, { clientId: 'bridge-client' }, 'bridge-client');
        else if (frame.method === 'thread-owner-discovery') reply(socket, frame, { supportsUntrustedAppInput: true }, 'desktop-owner');
        else reply(socket, frame, { ok: true });
      }
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  const adapter = new CodexIpcAdapter({ socketPath, timeoutMs: 500, ...options });
  t.after(async () => {
    adapter.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { adapter, frames, sockets };
}

test('R022: BundledCodexStorage.readIndex rejects premature worker exit without poisoning flights or cache', async () => {
  /** @type {EventEmitter[]} */ const workers = [];
  let mode = 'exit-before-message';
  class MockWorkerStorage extends BundledCodexStorage {
    /** @param {number} offset */
    createIndexWorker(offset) {
      const emitter = new EventEmitter();
      workers.push(emitter);
      queueMicrotask(() => {
        if (mode === 'exit-before-message') emitter.emit('exit', 0);
        else if (mode === 'bad-payload') emitter.emit('message', null);
        else emitter.emit('message', { ok: true, rows: [{ id: `row-${offset}`, cwd: '/fixture', createdAt: 1, updatedAt: 2 }] });
      });
      return emitter;
    }
  }
  const storage = new MockWorkerStorage({ codex: '/nonexistent-fixture-codex', signature: async () => 'sig-1' });
  await assert.rejects(storage.list('codex'), { code: 'session-store-unavailable' });
  assert.equal(storage.cache.size, 0);
  assert.equal(storage.flights.size, 0);
  assert.equal(workers[0].listenerCount('message'), 0);
  assert.equal(workers[0].listenerCount('error'), 0);
  assert.equal(workers[0].listenerCount('exit'), 0);

  mode = 'bad-payload';
  await assert.rejects(storage.list('codex'), { code: 'session-store-unavailable' });
  assert.equal(storage.cache.size, 0);
  assert.equal(storage.flights.size, 0);

  mode = 'ok';
  const rows = await storage.list('codex');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'row-0');
  assert.equal(storage.cache.size, 1);
});

test('R022: BundledCodexStorage.list normalizes/clamps offsets so equivalent keys share flights and cache entries', async () => {
  /** @type {number[]} */ const seenOffsets = [];
  const storage = new BundledCodexStorage({
    signature: async () => 'sig-same',
    loadIndex: async (offset) => {
      seenOffsets.push(offset);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ id: `page-${offset}` }];
    },
  });
  const zeroVariants = await Promise.all([
    storage.list('codex', -5),
    storage.list('codex', Number.NaN),
    storage.list('codex', -0),
    storage.list('codex', 0.9),
    storage.list('codex', /** @type {any} */ ('0')),
  ]);
  for (const rows of zeroVariants) assert.deepEqual(rows, [{ id: 'page-0' }]);
  assert.deepEqual(seenOffsets, [0]);
  assert.deepEqual([...storage.cache.keys()], [0]);

  const clampedMax = await Promise.all([
    storage.list('codex', 200_000),
    storage.list('codex', 300_000.7),
  ]);
  for (const rows of clampedMax) assert.deepEqual(rows, [{ id: 'page-100000' }]);
  assert.deepEqual(seenOffsets, [0, 100000]);
  assert.deepEqual([...storage.cache.keys()], [0, 100000]);
});

test('R022: real index worker matches fractional and clamped integer offset normalization without failing SQLite OFFSET', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codelync-index-b3-'));
  try {
    const file = join(root, 'state_5.sqlite');
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE threads(id TEXT, name TEXT, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, model_provider TEXT, archived INTEGER); INSERT INTO threads VALUES ('id-1','Title 1','','/fixture',1,2,'fixture',0)");
    db.close();
    const storage = new BundledCodexStorage({ codex: root });
    const rows = await storage.list('codex', 0.5);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'id-1');
    assert.deepEqual(await storage.list('codex', -3), rows);
    assert.equal(storage.cache.size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('R027: CodexIpcAdapter.dispose synchronously clears pending requests, caches, and frame buffers', async (t) => {
  /** @type {Frame[]} */ const statusFrames = [];
  const f = await ipcFixture(t, {
    timeoutMs: 60_000,
    onStatus: (frame) => statusFrames.push(frame),
  }, (frame) => frame.method === 'thread-follower-start-turn');

  await f.adapter.discover('session-dispose');
  assert.equal(f.adapter.generation('session-dispose'), 'local:desktop-owner');

  let settledSync = false;
  const inflight = f.adapter.send('session-dispose', 'fixture input', 'dispose-inflight');
  const settledCheck = inflight.catch((error) => {
    settledSync = true;
    return error;
  });

  // Wait until the write has actually queued the pending request on the adapter.
  await until(() => f.adapter.pending.size === 1 && f.frames.some((frame) => frame.method === 'thread-follower-start-turn'));
  assert.equal(f.adapter.pending.size, 1);

  f.adapter.frameBody = Buffer.alloc(64);
  f.adapter.headerOffset = 2;
  f.adapter.bodyOffset = 8;

  f.adapter.dispose();
  assert.equal(f.adapter.socket, null);
  assert.equal(f.adapter.pending.size, 0);
  assert.equal(f.adapter.owners.size, 0);
  assert.equal(f.adapter.attaching.size, 0);
  assert.equal(f.adapter.frameBody, null);
  assert.equal(f.adapter.headerOffset, 0);
  assert.equal(f.adapter.bodyOffset, 0);
  assert.equal(f.adapter.generation('session-dispose'), null);
  assert.equal(statusFrames.some((frame) => frame.status === 'disconnected'), true);

  const error = await settledCheck;
  assert.equal(settledSync, true);
  assert.equal(error.code, 'adapter-disposed');
  await assert.rejects(f.adapter.connect(), { code: 'adapter-disposed' });
});

test('R027: CodexIpcAdapter.dispose during initialize handshake fails connect with adapter-disposed without emitting connected', async (t) => {
  /** @type {Frame[]} */ const statusFrames = [];
  let holdInit = true;
  const f = await ipcFixture(t, {
    timeoutMs: 60_000,
    onStatus: (frame) => statusFrames.push(frame),
  }, (frame) => holdInit && frame.method === 'initialize');

  const connecting = f.adapter.connect();
  await until(() => f.adapter.pending.size === 1 && f.frames.some((frame) => frame.method === 'initialize'));
  f.adapter.dispose();
  holdInit = false;

  await assert.rejects(connecting, { code: 'adapter-disposed' });
  assert.equal(statusFrames.some((frame) => frame.status === 'connected'), false);
  assert.equal(f.adapter.socket, null);
  assert.equal(f.adapter.pending.size, 0);
});

test('R027: CodexIpcAdapter bounds completed commands while retaining pending and unknown-outcome commands', async (t) => {
  let holdMethod = /** @type {string|null} */ (null);
  let dropOnCmd = /** @type {string|null} */ (null);
  let dropTimeout = 250;
  const f = await ipcFixture(t, { timeoutMs: dropTimeout }, (frame, socket) => {
    if (frame.method === 'thread-follower-start-turn') {
      const cmdId = frame.params?.turnStart?.request?.clientUserMessageId;
      if (cmdId === dropOnCmd) { socket.destroy(); return true; }
      if (cmdId === 'timeout-cmd' || cmdId === holdMethod) return true;
    }
    return false;
  });

  // 1. Create an unknown-outcome command via timeout (reuse shorter timeout adapter or wait once).
  f.adapter.timeoutMs = 30;
  const timedOut = f.adapter.send('session-bound', 'timed out input', 'timeout-cmd');
  await assert.rejects(timedOut, { code: 'codex-outcome-unknown' });
  f.adapter.timeoutMs = 5_000;

  // 2. Create an unknown-outcome command via post-write disconnect.
  dropOnCmd = 'disconnect-cmd';
  const disconnected = f.adapter.send('session-bound', 'disconnect input', 'disconnect-cmd');
  await assert.rejects(disconnected, { code: 'codex-disconnected' });
  dropOnCmd = null;

  // 3. Reconnect and create an in-flight pending command.
  await f.adapter.connect();
  await f.adapter.discover('session-bound');
  holdMethod = 'inflight-cmd';
  const inflight = f.adapter.send('session-bound', 'inflight input', 'inflight-cmd');
  await until(() => f.adapter.pending.size === 1);

  // 4. Execute > 512 completed known-outcome commands in batches.
  for (let i = 0; i < 530; i += 20) {
    await Promise.all(
      Array.from({ length: Math.min(20, 530 - i) }, (_, offset) =>
        f.adapter.send('session-bound', `ok-${i + offset}`, `ok-cmd-${i + offset}`)),
    );
  }

  // 512 bounded completed + 2 unknown-outcome + 1 pending = 515.
  assert.equal(f.adapter.commands.size, 515);
  assert.equal(f.adapter.commands.has(JSON.stringify(['local', 'session-bound', 'timeout-cmd'])), true);
  assert.equal(f.adapter.commands.has(JSON.stringify(['local', 'session-bound', 'disconnect-cmd'])), true);
  assert.equal(f.adapter.commands.has(JSON.stringify(['local', 'session-bound', 'inflight-cmd'])), true);
  assert.equal(f.adapter.commands.has(JSON.stringify(['local', 'session-bound', 'ok-cmd-0'])), false);
  assert.equal(f.adapter.commands.has(JSON.stringify(['local', 'session-bound', 'ok-cmd-529'])), true);

  // Unknown-outcome operations remain deduplicated and reject conflicting reuse without wire replay.
  const sentBefore = f.frames.filter((frame) => frame.method === 'thread-follower-start-turn').length;
  assert.equal(f.adapter.send('session-bound', 'timed out input', 'timeout-cmd'), timedOut);
  assert.equal(f.adapter.send('session-bound', 'disconnect input', 'disconnect-cmd'), disconnected);
  assert.equal(f.adapter.send('session-bound', 'inflight input', 'inflight-cmd'), inflight);
  await assert.rejects(f.adapter.send('session-bound', 'altered input', 'timeout-cmd'), { code: 'command-conflict' });
  await assert.rejects(f.adapter.send('session-bound', 'altered input', 'disconnect-cmd'), { code: 'command-conflict' });
  assert.equal(f.frames.filter((frame) => frame.method === 'thread-follower-start-turn').length, sentBefore);

  // Clean up pending request by disposing adapter cleanly.
  f.adapter.dispose();
  await assert.rejects(inflight, { code: 'adapter-disposed' });
});
