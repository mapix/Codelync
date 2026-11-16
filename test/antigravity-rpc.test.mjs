import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityRpcClient, readAntigravityRuntime, antigravityOwnerGeneration } from '../src/adapters/antigravity-rpc.mjs';

/** @typedef {Record<string,any>} Value */

test('a private runtime manifest must match the original process lifetime and a loopback origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antigravity-runtime-')), binary = join(directory, 'language_server'), path = join(directory, 'runtime.json');
  await writeFile(binary, 'fixture, never executed');
  const identity = { pid: 123, parentPid: 122, executable: binary, startTime: 'fixture stable process start' };
  const manifest = { version: 1, ...identity, binary, origin: 'http://127.0.0.1:12345', csrfToken: 'fixture-private-csrf', home: directory, appDataDir: 'antigravity' };
  try {
    await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
    const actual = await readAntigravityRuntime(path, async () => identity); assert.equal(actual.generation, antigravityOwnerGeneration({ ...identity, executable: await realpath(binary) }));
    await assert.rejects(readAntigravityRuntime(path, async () => ({ ...identity, startTime: 'reused PID' })), { code: 'source-epoch-changed' });
    await chmod(path, 0o644); await assert.rejects(readAntigravityRuntime(path, async () => identity), { code: 'invalid-antigravity-runtime' }); await chmod(path, 0o600);
    await writeFile(path, JSON.stringify({ ...manifest, origin: 'https://external.invalid:12345' })); await assert.rejects(readAntigravityRuntime(path, async () => identity), { code: 'invalid-antigravity-runtime' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Connect native requests retain local credentials and fence stale commands before fetch', async () => {
  const runtime = { origin: 'http://127.0.0.1:12345', csrfToken: 'fixture-private-csrf', generation: 'owner-one' }; let calls = 0;
  const rpc = new AntigravityRpcClient({ readRuntime: async () => runtime, fetch: /** @type {typeof fetch} */ (async (url, options) => {
    calls++; assert.equal(url, runtime.origin + '/exa.language_server_pb.LanguageServerService/GetCapabilities');
    const headers = /** @type {Value} */ (options?.headers); assert.equal(headers['Connect-Protocol-Version'], '1'); assert.equal(headers['X-Codeium-Csrf-Token'], runtime.csrfToken);
    assert.equal(headers['X-Jetski-Via-Remote-Control'], 'true'); assert.equal(options?.redirect, 'error'); return new Response('{}');
  }) });
  await assert.rejects(rpc.call('SendUserCascadeMessage', {}, { expectedGeneration: 'stale', mutation: true }), { code: 'source-epoch-changed', effectMayHaveOccurred: false }); assert.equal(calls, 0);
  assert.deepEqual(await rpc.call('GetCapabilities'), {}); assert.equal(calls, 1);
});

test('failed native responses never disclose response bodies and mutations remain uncertain', async () => {
  const rpc = new AntigravityRpcClient({ readRuntime: async () => ({ origin: 'http://127.0.0.1:1', csrfToken: 'private', generation: 'owner-one' }),
    fetch: /** @type {typeof fetch} */ (async () => new Response('private conversation and token', { status: 502 })) });
  await assert.rejects(rpc.call('SendUserCascadeMessage', {}, { mutation: true }), error => { assert.equal(/** @type {Value} */ (error).code, 'delivery-unknown'); assert.equal(String(error).includes('private conversation'), false); return true; });
  await assert.rejects(rpc.call('GetCapabilities'), { code: 'antigravity-rpc-unavailable' });
});

test('an oversized declared native response cancels its read stream and keeps the bounded failure explicit', async () => {
  let cancelled = false;
  const rpc = new AntigravityRpcClient({ readRuntime: async () => ({ origin: 'http://127.0.0.1:1', csrfToken: 'fixture', generation: 'owner-one' }),
    fetch: /** @type {typeof fetch} */ (async () => new Response(new ReadableStream({ cancel: () => { cancelled = true; } }),
      { headers: { 'content-length': String(16 * 1024 * 1024 + 1) } })) });
  await assert.rejects(rpc.call('GetCascadeTrajectorySteps', { cascadeId: 'fixture', stepOffset: 10 }), { code: 'antigravity-response-too-large' });
  assert.equal(cancelled, true);
});
