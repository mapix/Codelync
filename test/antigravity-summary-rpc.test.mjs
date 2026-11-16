import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityRpcClient, antigravityHostId } from '../src/adapters/antigravity-rpc.mjs';
const runtime = { generation: 'original-owner', binary: '/fixture/app/server', home: '/fixture/home', appDataDir: 'Antigravity', origin: 'http://127.0.0.1:4567', csrfToken: 'public-fixture' };
const scope = { expectedHostId: antigravityHostId(runtime), expectedGeneration: runtime.generation };
test('local summary observation sends only the bounded Connect {} request with original scope', async () => {
  /** @type {Record<string,any>} */ let seen = {}; const rpc = new AntigravityRpcClient({ readRuntime: async () => runtime, fetch: async (url, options = {}) => {
    seen = { url, options }; return new Response(new ReadableStream(), { headers: { 'content-type': 'application/connect+json' } });
  } });
  const value = await rpc.subscribeSummaries(scope); assert.ok(seen.url.endsWith('/JetboxSubscribeToSummaries'));
  assert.equal(seen.options.headers['Content-Type'], 'application/connect+json'); assert.equal(seen.options.redirect, 'error');
  assert.deepEqual([...seen.options.body], [0, 0, 0, 0, 2, 123, 125]); assert.equal(value.scope.hostId, scope.expectedHostId);
  await rpc.dispose(); assert.equal(seen.options.signal.aborted, true); await value.close();
});
test('foreign original host/generation cannot dispatch a summary stream', async () => {
  let calls = 0; const rpc = new AntigravityRpcClient({ readRuntime: async () => runtime, fetch: async () => { calls++; throw Error('No fetch expected'); } });
  await assert.rejects(rpc.subscribeSummaries({ ...scope, expectedGeneration: 'other' }), { code: 'source-epoch-changed' }); assert.equal(calls, 0);
});
test('a native owner change after headers cancels the stream before publishing response authority', async () => {
  let count = 0;
  /** @type {Record<string,any>} */ const observed = {};
  const rpc = new AntigravityRpcClient({ readRuntime: async () => ++count === 1 ? runtime : { ...runtime, generation: 'other' },
    fetch: async (_url, options = {}) => { observed.signal = options.signal; return new Response(new ReadableStream(), { headers: { 'content-type': 'application/connect+json' } }); } });
  await assert.rejects(rpc.subscribeSummaries(scope), { code: 'source-epoch-changed' }); assert.ok(observed.signal); assert.equal(observed.signal.aborted, true);
});
test('unary content or HTTP error cannot masquerade as a readable Connect stream', async () => {
  for (const response of [new Response('{}', { headers: { 'content-type': 'application/json' } }), new Response('private input must never enter errors', { status: 403 })]) {
    const rpc = new AntigravityRpcClient({ readRuntime: async () => runtime, fetch: async () => response });
    await assert.rejects(rpc.subscribeSummaries(scope), error => error instanceof Error && /** @type {{code?:string}} */ (error).code === 'antigravity-summary-stream-unavailable' && !error.message.includes('private input'));
  }
});
