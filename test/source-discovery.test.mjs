import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSourceDiscovery } from '../src/codelync/discovery.mjs';

/** @typedef {Record<string,any>} Value */
function fixture(allowDeferredSources = false, failIndex = false) {
  const source = { app: 'zcode', id: 'preserved-window', hostId: 'local', kind: 'window' };
  let windows = 0, adapters = 0, disposed = 0;
  const backend = { dispose: async () => {}, marker: 'original-codex-adapter' };
  const discovery = new LocalSourceDiscovery({
    allowDeferredSources, antigravityBackend: false,
    storage: { list: async (app) => { assert.equal(app, 'codex'); if (failIndex) throw Error('fixture unreadable index'); return [{ id: 'original-session', title: 'Fixture' }]; } },
    codexBackend: /** @type {import('../src/adapters/codex-backend.mjs').CodexBackend} */ (/** @type {unknown} */ (backend)),
    localWindows: async () => { windows++; return [source]; },
    createWindowAdapter: () => { adapters++; return { dispose: async () => { disposed++; } }; },
  });
  return { source, backend, discovery, counts: () => ({ windows, adapters, disposed }) };
}

test('default discovery reads only Codex and does not invoke the window scanner or adapter', async () => {
  const f = fixture();
  try {
    const result = await f.discovery.discover();
    assert.deepEqual(result.errors, []); assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].app, 'codex'); assert.equal(result.sources[0].kind, 'session');
    assert.equal(f.discovery.adapter(result.sources[0]), f.backend);
    assert.throws(() => f.discovery.adapter(f.source), { code: 'unsupported-source' });
    assert.deepEqual(f.counts(), { windows: 0, adapters: 0, disposed: 0 });
  } finally { await f.discovery.close(); }
});

test('index failure stays explicit and cannot be mistaken for a successful empty catalogue', async () => {
  const f = fixture(false, true);
  try {
    const result = await f.discovery.discover();
    assert.deepEqual(result.sources, []); assert.deepEqual(result.errors, ['codex-index-unavailable']);
    assert.equal(f.counts().windows, 0);
  } finally { await f.discovery.close(); }
});

test('historical window research requires an explicit constructor option and retains adapter ownership', async () => {
  const f = fixture(true);
  try {
    const result = await f.discovery.discover(); assert.equal(result.sources.length, 2);
    assert.equal(f.discovery.adapter(f.source), f.discovery.adapter(f.source));
    assert.deepEqual(f.counts(), { windows: 1, adapters: 1, disposed: 0 });
  } finally { await f.discovery.close(); }
  assert.equal(f.counts().disposed, 1);
});

test('both proven native sources are discovered without window research and use their original adapters', async () => {
  let windows = 0;
  const agy = { app: 'antigravity', id: 'same-native-id', hostId: 'local:antigravity:' + 'a'.repeat(64), kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: 'owner-one' };
  const backend = { list: async () => [agy], dispose: async () => {} };
  const discovery = new LocalSourceDiscovery({ storage: { list: async () => [{ id: 'same-native-id' }] }, antigravityBackend: backend, localWindows: async () => { windows++; return []; } });
  try {
    const found = await discovery.discover(); assert.deepEqual(found.errors, []); assert.deepEqual(found.sources.map(source => source.app), ['codex', 'antigravity']);
    assert.equal(discovery.adapter(agy), backend); assert.equal(windows, 0);
    assert.throws(() => discovery.adapter({ ...agy, protocol: undefined }), { code: 'unsupported-source' });
  } finally { await discovery.close(); }
});

test('a failed configured Antigravity inventory remains distinct from the successful Codex index', async () => {
  const discovery = new LocalSourceDiscovery({ storage: { list: async () => [{ id: 'codex-id' }] }, antigravityBackend: { list: async () => { throw Object.assign(Error('fixture'), { code: 'antigravity-discovery-unavailable' }); }, dispose: async () => {} } });
  try { const found = await discovery.discover(); assert.deepEqual(found.errors, ['antigravity-index-unavailable']); assert.equal(found.sources[0].app, 'codex'); } finally { await discovery.close(); }
});

test('current native activity readiness is independent of incomplete historical catalog authority', async () => {
  const agy = { app: 'antigravity', id: 'native-current', hostId: 'local:antigravity:' + 'a'.repeat(64), kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: 'owner' };
  const backend = { list: async () => [agy], inventoryComplete: false, activityInventoryComplete: true, dispose: async () => {} };
  const discovery = new LocalSourceDiscovery({ storage: { list: async () => [] }, antigravityBackend: backend });
  try {
    const result = await discovery.discover();
    assert.ok(result.errors.includes('antigravity-index-unavailable'));
    assert.ok(result.activityInventoryApps.includes('antigravity'));
    assert.equal(result.sources[0].id, agy.id);
    backend.activityInventoryComplete = false;
    assert.equal((await discovery.discover()).activityInventoryApps.includes('antigravity'), false);
  } finally { await discovery.close(); }
});

test('explicit Claude native modes retain collection identity and do not scan windows or create runners', async () => {
  let windows = 0, disposed = 0;
  const adapters = ['code', 'chat'].map((appMode, index) => {
    const hostId = 'local:claude-desktop:' + String(index + 1).repeat(64);
    return { appMode, hostId: () => hostId, list: async () => [{ app: 'claude-desktop', kind: 'session', id: 'same-id', protocol: 'claude-desktop-native',
      appMode, hostId, runtimeGeneration: 'owner', nativeCollection: appMode === 'code' ? 'claude-code-sessions' : 'local-agent-mode-sessions' }], dispose: async () => { disposed++; } };
  });
  const discovery = new LocalSourceDiscovery({ storage: { list: async () => [] }, antigravityBackend: false, claudeBackends: adapters, localWindows: async () => { windows++; return []; } });
  try {
    const result = await discovery.discover(); assert.equal(result.sources.length, 2); assert.deepEqual(result.errors, []); assert.deepEqual(result.inventoryApps, ['codex', 'claude-desktop']);
    for (let index = 0; index < 2; index++) assert.equal(discovery.adapter(result.sources[index]), adapters[index]);
    assert.throws(() => discovery.adapter({ ...result.sources[0], hostId: result.sources[1].hostId }), { code: 'unsupported-source' });
    assert.equal(windows, 0);
    adapters[1].list = async () => { throw Error('Unavailable original Chat inventory'); };
    const partial = await discovery.discover(); assert.equal(partial.sources.length, 1); assert.deepEqual(partial.errors, ['claude-desktop-index-unavailable']); assert.deepEqual(partial.inventoryApps, ['codex']);
  } finally { await discovery.close(); }
  assert.equal(disposed, 2);
});

test('an unconfigured or malformed Claude collection cannot authorize removing its saved sources', async () => {
  const malformed = { appMode: 'code', hostId: () => 'local:claude-desktop:' + 'a'.repeat(64), list: async () => [{ app: 'claude-desktop', id: 'cloud' }], dispose: async () => {} };
  for (const claudeBackends of [false, [malformed]]) {
    const discovery = new LocalSourceDiscovery({ storage: { list: async () => [] }, antigravityBackend: false, claudeBackends: /** @type {false|Value[]} */ (claudeBackends) });
    try { const found = await discovery.discover(); assert.deepEqual(found.sources, []); assert.deepEqual(found.inventoryApps, ['codex']);
      assert.deepEqual(found.errors, claudeBackends === false ? [] : ['claude-desktop-index-unavailable']); }
    finally { await discovery.close(); }
  }
});
