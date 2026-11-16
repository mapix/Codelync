import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeDesktopRpcClient, readClaudeDesktopRuntime, claudeDesktopHostId, claudeDesktopOwnerGeneration } from '../src/adapters/claude-desktop-rpc.mjs';

test('native owner manifest binds a private profile, executable, process lifetime and boot epoch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-owner-')), executable = join(dir, 'Claude'), storagePath = join(dir, 'profile'), path = join(dir, 'runtime.json');
  await writeFile(executable, 'fixture only'); await mkdir(storagePath);
  const value = { version: 1, protocol: 'claude-desktop-native', pid: 44, parentPid: 1, startTime: 'stable', executable, storagePath, origin: 'http://127.0.0.1:5555', bootEpoch: 'a'.repeat(32), accessToken: 'b'.repeat(64) };
  try {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    const owner = await readClaudeDesktopRuntime(path, async () => ({ ...value })); assert.equal(owner.generation, claudeDesktopOwnerGeneration({ ...value, executable: await realpath(executable) }));
    assert.notEqual(claudeDesktopHostId(owner), claudeDesktopHostId({ ...owner, storagePath: storagePath + '-other' }));
    await assert.rejects(readClaudeDesktopRuntime(path, async () => ({ ...value, startTime: 'reused-pid' })), { code: 'source-epoch-changed' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('RPC validates current owner before dispatch and treats unconfirmed native effects as unknown', async () => {
  const runtime = { origin: 'http://127.0.0.1:5555', generation: 'original', storagePath: '/fixture/profile', accessToken: 'private' }; let sent = 0;
  const client = new ClaudeDesktopRpcClient({ readRuntime: async () => runtime, fetch: async () => { sent++; return new Response('private failure body', { status: 502 }); } });
  await assert.rejects(client.call('code.send', {}, { mutation: true, commandId: 'operation-one', expectedGeneration: 'old' }), { code: 'source-epoch-changed' }); assert.equal(sent, 0);
  await assert.rejects(client.call('code.send', {}, { mutation: true, commandId: 'operation-one', expectedGeneration: 'original' }), error => error instanceof Error && /** @type {Error & {code?:string}} */ (error).code === 'delivery-unknown' && !String(error).includes('private failure body')); assert.equal(sent, 1);
});

test('native response must carry this exact owner and storage namespace', async () => {
  const runtime = { origin: 'http://127.0.0.1:5555', generation: 'original', storagePath: '/fixture/profile', accessToken: 'private' };
  const client = new ClaudeDesktopRpcClient({ readRuntime: async () => runtime, fetch: async () => new Response(JSON.stringify({ version: 1, ok: true, ownerGeneration: 'original', hostId: claudeDesktopHostId(runtime), result: { nativeSessions: 2 } })) });
  assert.deepEqual(await client.call('code.list'), { nativeSessions: 2 });
  runtime.generation = 'next'; await assert.rejects(client.call('code.list', {}, { expectedGeneration: 'original' }), { code: 'source-epoch-changed' });
});

test('native record collections fence identical imported IDs while sharing one desktop transport', async () => {
  const runtime = { origin: 'http://127.0.0.1:5555', generation: 'original', storagePath: '/fixture/profile', accessToken: 'private' };
  const code = claudeDesktopHostId(runtime, 'claude-code-sessions'), lam = claudeDesktopHostId(runtime, 'local-agent-mode-sessions');
  assert.notEqual(code, lam); let sends = 0;
  const client = new ClaudeDesktopRpcClient({ readRuntime: async () => runtime, fetch: async () => { sends++; return new Response(JSON.stringify({ version: 1, ok: true, ownerGeneration: runtime.generation, hostId: claudeDesktopHostId(runtime), result: { sessions: [] } })); } });
  await client.call('code.list', {}, { collection: 'claude-code-sessions', expectedHostId: code });
  await assert.rejects(client.call('code.list', {}, { collection: 'claude-code-sessions', expectedHostId: lam }), { code: 'source-epoch-changed' });
  assert.equal(sends, 1);
});

test('task RPC allowlist rejects arbitrary task controls, unbounded reads and misclassified mutations before network admission', async () => {
  const runtime = { origin: 'http://127.0.0.1:5555', generation: 'original', storagePath: '/fixture/profile', accessToken: 'private' }; let sends = 0;
  const client = new ClaudeDesktopRpcClient({ readRuntime: async () => runtime, fetch: async () => { sends++; return new Response(JSON.stringify({ version: 1, ok: true, ownerGeneration: runtime.generation, hostId: claudeDesktopHostId(runtime), result: {} })); } });
  for (const method of ['code.taskResume', 'cowork.taskOutput', 'chat.taskFeed', 'code.getTaskOutput']) await assert.rejects(client.call(method, { sessionId: 'parent' }), { code: 'unsupported-action' });
  await assert.rejects(client.call('code.taskFeed', { sessionId: 'parent', limit: 129 }), { code: 'invalid-task-request' });
  await assert.rejects(client.call('code.taskFeed', { sessionId: 'parent', cursor: -1 }), { code: 'invalid-task-request' });
  await assert.rejects(client.call('code.taskFeed', { sessionId: 'parent', message: 'private' }), { code: 'invalid-task-request' });
  await assert.rejects(client.call('code.stopTask', { sessionId: 'parent', taskId: 'task', expectedOwnerGeneration: 'owner', expectedExecutionToken: 'query' }), { code: 'invalid-task-request' });
  await assert.rejects(client.call('code.taskOutput', { sessionId: 'parent', taskId: 'task' }), { code: 'invalid-task-request' });
  assert.equal(sends, 0);
  await client.call('code.taskFeed', { sessionId: 'parent', cursor: 0, limit: 128 });
  assert.equal(sends, 1);
});
