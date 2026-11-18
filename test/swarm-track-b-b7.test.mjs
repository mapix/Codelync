import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadNativeCodexModelCatalog } from '../src/adapters/codex-backend.mjs';
import { AntigravityRpcClient, antigravityHostId } from '../src/adapters/antigravity-rpc.mjs';

/** @typedef {Record<string, any>} Value */

test('R062: loadNativeCodexModelCatalog enforces 2 MiB size limit and valid JSON object shape on model_catalog_json', async t => {
  const home = await mkdtemp(join(tmpdir(), 'codelync-b7-catalog-size-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const largePath = join(home, 'large-catalog.json');
  await writeFile(largePath, '{}');
  await truncate(largePath, 2 * 1024 * 1024 + 1);
  await writeFile(join(home, 'config.toml'), `model_catalog_json = ${JSON.stringify(largePath)}\n`);

  await assert.rejects(
    loadNativeCodexModelCatalog(null, 'gpt-5', { home }),
    { code: 'native-model-catalog-unavailable' },
  );

  // Valid catalog under 2 MiB works; primitive JSON (`null`) rejects cleanly with BridgeError.
  const validPath = join(home, 'valid-catalog.json');
  await writeFile(validPath, 'null');
  await writeFile(join(home, 'config.toml'), `model_catalog_json = ${JSON.stringify(validPath)}\n`);
  await assert.rejects(
    loadNativeCodexModelCatalog(null, 'gpt-5', { home }),
    { code: 'native-model-catalog-unavailable' },
  );

  await writeFile(validPath, JSON.stringify({
    models: [{ slug: 'gpt-5', display_name: 'GPT-5', supported_reasoning_levels: [{ effort: 'medium' }], default_reasoning_level: 'medium' }],
  }));
  const loaded = await loadNativeCodexModelCatalog(null, 'gpt-5', { home });
  assert.equal(loaded.catalogSource, 'original-config-catalog');
  assert.deepEqual(loaded.models.map((/** @type {Value} */ m) => m.id), ['gpt-5']);
});

test('R062: loadNativeCodexModelCatalog bounds nativeCatalogCache in LRU order and prunes expired entries', async t => {
  const home = await mkdtemp(join(tmpdir(), 'codelync-b7-catalog-lru-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);

  const providers = Array.from({ length: 33 }, (_, i) => `p${i}`);
  const toml = [
    ...providers.map(p => `[model_providers.${p}]\nmodel_catalog_url = "https://fixture.invalid/${p}"\nexperimental_bearer_token = "tok-${p}"`),
  ].join('\n');
  await writeFile(join(home, 'config.toml'), toml);

  /** @type {string[]} */
  const fetched = [];
  /** @type {typeof fetch} */
  const mockFetch = async url => {
    const u = String(url);
    fetched.push(u.slice(u.lastIndexOf('/') + 1));
    return new Response(JSON.stringify({
      models: [{ slug: 'model-a', supported_reasoning_levels: [{ effort: 'low' }], default_reasoning_level: 'low' }],
    }));
  };

  // Populate 32 entries (p0..p31).
  for (let i = 0; i < 32; i += 1) {
    await loadNativeCodexModelCatalog(`p${i}`, 'model-a', { home, fetch: mockFetch });
  }
  assert.equal(fetched.length, 32);

  // Re-access p0 -> cache hit (0 fetches) and promotes p0 above p1 in LRU.
  fetched.length = 0;
  await loadNativeCodexModelCatalog('p0', 'model-a', { home, fetch: mockFetch });
  assert.equal(fetched.length, 0);

  // Insert p32 -> evicts p1 (LRU), keeps p0.
  await loadNativeCodexModelCatalog('p32', 'model-a', { home, fetch: mockFetch });
  assert.deepEqual(fetched, ['p32']);

  fetched.length = 0;
  await loadNativeCodexModelCatalog('p0', 'model-a', { home, fetch: mockFetch });
  assert.equal(fetched.length, 0);

  await loadNativeCodexModelCatalog('p1', 'model-a', { home, fetch: mockFetch });
  assert.deepEqual(fetched, ['p1']);

  // Advance past 300s TTL -> expired entries are pruned and refetched.
  now += 300_001;
  fetched.length = 0;
  await loadNativeCodexModelCatalog('p0', 'model-a', { home, fetch: mockFetch });
  assert.deepEqual(fetched, ['p0']);
});

test('R067: AntigravityRpcClient coalesces concurrent runtime/discovery flights without skipping sequential owner checks', async () => {
  const runtime = {
    version: 1,
    pid: 42,
    binary: '/fixture/app/server',
    home: '/fixture/home',
    appDataDir: 'antigravity',
    origin: 'http://127.0.0.1:4567',
    csrfToken: 'fixture-csrf',
    generation: 'owner-1',
  };

  let reads = 0;
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise(resolve => { release = () => resolve(undefined); });

  const rpc = new AntigravityRpcClient({
    readRuntime: async () => {
      reads += 1;
      if (reads === 1) await gate;
      return runtime;
    },
    fetch: /** @type {typeof fetch} */ (async () => new Response('{}')),
  });

  // 4 concurrent runtime() / call() lookups coalesce into 1 readRuntime() invocation.
  const p1 = rpc.runtime();
  const p2 = rpc.runtime();
  const p3 = rpc.call('GetCapabilities');
  const p4 = rpc.call('GetUserStatus');
  await Promise.resolve();
  assert.equal(reads, 1);

  release();
  await Promise.all([p1, p2, p3, p4]);
  // 1 coalesced pre-check read + 1 coalesced post-fetch read (not 8 reads).
  assert.equal(reads, 2);

  // Concurrent fallback discoverRuntime() shares an active discoveryFlight and rejects once disposed.
  const shared = Promise.resolve(runtime);
  rpc.discoveryFlight = shared;
  assert.equal(rpc.discoverRuntime(), shared);
  rpc.discoveryFlight = null;

  await rpc.dispose();
  await assert.rejects(rpc.discoverRuntime(), { code: 'antigravity-unavailable' });
  await assert.rejects(rpc.call('GetCapabilities', {}, { mutation: true }), {
    code: 'antigravity-unavailable',
    effectMayHaveOccurred: false,
  });
});

test('R067: AntigravityRpcClient.dispose() aborts and cancels both active and in-handshake subscribeSummaries streams cleanly', async () => {
  const runtime = {
    version: 1,
    pid: 42,
    binary: '/fixture/app/server',
    home: '/fixture/home',
    appDataDir: 'antigravity',
    origin: 'http://127.0.0.1:4567',
    csrfToken: 'fixture-csrf',
    generation: 'owner-1',
  };
  const scope = { expectedHostId: antigravityHostId(runtime), expectedGeneration: runtime.generation };

  // Case 1: Active stream opened, then rpc.dispose() cancels body stream & aborts signal.
  let activeCancelled = false;
  /** @type {AbortSignal | undefined} */
  let activeSignal;
  const rpc1 = new AntigravityRpcClient({
    readRuntime: async () => runtime,
    fetch: async (_url, options = {}) => {
      activeSignal = /** @type {AbortSignal} */ (options.signal);
      return new Response(new ReadableStream({ cancel: () => { activeCancelled = true; } }), {
        headers: { 'content-type': 'application/connect+json' },
      });
    },
  });

  const sub = await rpc1.subscribeSummaries(scope);
  assert.equal(rpc1.summaryClosers.size, 1);
  await rpc1.dispose();
  assert.equal(activeSignal?.aborted, true);
  assert.equal(activeCancelled, true);
  assert.equal(rpc1.summaryClosers.size, 0);
  assert.equal(rpc1.summaryControllers.size, 0);
  // Caller close() after dispose() remains idempotent.
  await sub.close();

  // Case 2: dispose() called during post-fetch runtime verification rejects before returning stream handle.
  let runtimeCalls = 0;
  let midHandshakeCancelled = false;
  /** @type {() => void} */
  let finishSecondRead = () => {};
  const secondGate = new Promise(resolve => { finishSecondRead = () => resolve(undefined); });
  const rpc2 = new AntigravityRpcClient({
    readRuntime: async () => {
      runtimeCalls += 1;
      if (runtimeCalls === 2) await secondGate;
      return runtime;
    },
    fetch: async () => new Response(new ReadableStream({ cancel: () => { midHandshakeCancelled = true; } }), {
      headers: { 'content-type': 'application/connect+json' },
    }),
  });

  const pendingSub = rpc2.subscribeSummaries(scope);
  while (runtimeCalls < 2) await new Promise(resolve => setTimeout(resolve, 5));
  const disposing = rpc2.dispose();
  finishSecondRead();

  await assert.rejects(pendingSub, { code: 'antigravity-unavailable' });
  await disposing;
  assert.equal(midHandshakeCancelled, true);
  assert.equal(rpc2.summaryClosers.size, 0);
});
