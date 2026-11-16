import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AntigravityBackend } from '../src/adapters/antigravity-backend.mjs';
import { antigravityArchivedIds } from '../src/adapters/antigravity-history.mjs';
import { SourceRegistry, sourceKey } from '../src/happy/source-registry.mjs';
import { CodeLightMacDaemon } from '../src/happy/mac-daemon.mjs';
import { recentCatalogPage } from '../src/happy/recent-data.mjs';
import { decryptRecord } from '../src/happy/session-transport.mjs';

/** @typedef {Record<string,any>} Value */
const source = { app: 'antigravity', id: 'native-parent', hostId: 'local:antigravity:' + 'a'.repeat(64), kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: 'original-owner', title: 'Native source', workspace: '/fixture/project' };

test('native archives hide descendants while ordinary forks, missing parents and cycles remain visible', () => {
  const summaries = { archive: { annotations: { archived: true } }, child: { trajectoryMetadata: { parentConversationId: 'archive' } },
    nested: { trajectoryMetadata: { parentConversationId: 'child' } }, fork: { forkParentConversationId: 'visible' }, visible: {},
    orphan: { trajectoryMetadata: { parentConversationId: 'missing' } }, cycleA: { forkParentConversationId: 'cycleB' }, cycleB: { forkParentConversationId: 'cycleA' } };
  assert.deepEqual([...antigravityArchivedIds(summaries)].sort(), ['archive', 'child', 'nested']);
});

test('default backend catalog excludes resident/search archives without loading their metadata or bodies', async () => {
  const calls = /** @type {Value[]} */ ([]), runtime = { binary: '/fixture/Antigravity.app/Contents/Resources/bin/language_server', home: '/fixture/home', appDataDir: 'antigravity' };
  const rpc = { latestRuntime: runtime, generation: () => 'owner', dispose: async () => {}, call: async (/** @type {string} */ method, /** @type {Value} */ body = {}) => {
    calls.push({ method, body });
    if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: { archived: { annotations: { archived: true } }, child: { trajectoryMetadata: { parentConversationId: 'archived' } }, visible: {} } };
    if (method === 'SearchConversations') return { results: body.filters.archivedOnly ? [{ cascadeId: 'search-archive', archived: true }] : [{ cascadeId: 'search-archive', archived: true }] };
    throw Error('An archived catalog must not hydrate metadata or conversation bodies.');
  } };
  const backend = new AntigravityBackend({ rpc });
  try {
    assert.deepEqual((await backend.list({ fresh: true })).map(s => s.id), ['visible']);
    assert.deepEqual(backend.excludedSources.map(s => s.id).sort(), ['archived', 'child', 'search-archive']);
    const searchCount = calls.filter(c => c.method === 'SearchConversations').length;
    await backend.list({ fresh: true });
    assert.equal(calls.filter(c => c.method === 'SearchConversations').length, searchCount);
  } finally { await backend.dispose(); }
});

test('catalog visibility rejects archive flags even before the stored catalogueAvailable flag catches up', () => {
  const entry = (/** @type {string} */ id, /** @type {Value} */ flags = {}) => ({ source: { ...source, id, ...flags },
    binding: { happySessionId: 'mirror-' + id, metadata: { bridge: { source }, nativeSession: { catalogueAvailable: true, ...flags } } } });
  const page = recentCatalogPage([entry('visible'), entry('source-archive', { archived: true }), entry('hidden', { catalogueAvailable: false })]);
  assert.deepEqual(page.sessions.map(s => s.id), ['mirror-visible']);
});

test('archive CAS hides an existing mirror once and unarchive restores the same key, history and binding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-archive-registry-')); let stored = /** @type {Value|null} */ (null), writes = 0;
  const registry = new SourceRegistry({ directory, account: { serverUrl: 'http://127.0.0.1:1', token: 'fixture', secret: randomBytes(32).toString('base64') },
    fetch: /** @type {typeof fetch} */ (async (_url, request) => { stored ??= { id: 'registered-mirror', ...JSON.parse(/** @type {string} */ (request?.body)) }; return new Response(JSON.stringify({ session: stored })); }) });
  try {
    const binding = await registry.register(source, 'machine'), key = binding.sessionKey;
    const socket = { timeout: () => ({ emitWithAck: async (/** @type {string} */ _event, /** @type {Value} */ body) => { writes++; return { result: 'success', version: body.expectedVersion + 1, metadata: body.metadata }; } }) };
    const currentHeader = { ...source, isSubagent: true, parentId: 'original-parent', agentName: 'Coordinator' };
    await registry.markArchived(binding, /** @type {any} */ (socket), currentHeader);
    await registry.markArchived(binding, /** @type {any} */ (socket)); assert.equal(writes, 1);
    const saved = JSON.parse(await readFile(join(directory, sourceKey(source) + '.json'), 'utf8'));
    assert.equal(saved.sessionKey, key); assert.equal(saved.happySessionId, 'registered-mirror'); assert.equal(saved.metadata.nativeSession.archived, true); assert.equal(saved.metadata.nativeSession.catalogueAvailable, false);
    assert.equal(saved.metadata.nativeSession.isSubagent, true); assert.equal(saved.metadata.nativeSession.parentId, 'original-parent');
    assert.equal((/** @type {Value} */ (decryptRecord(saved.metadata ? stored?.metadata : '', new Uint8Array(Buffer.from(key, 'base64')))))?.bridge?.source?.id, source.id);
    assert.throws(() => registry.register({ ...source, archived: true }, 'machine'), { code: 'source-archived' });
    await registry.refreshMetadata(binding, source, /** @type {any} */ (socket));
    assert.equal(binding.sessionKey, key); assert.equal(binding.metadata.nativeSession.archived, false); assert.equal(binding.metadata.nativeSession.catalogueAvailable, true); assert.equal(binding.metadata.bridge.source.archived, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('confirmed archive evidence hides a saved binding despite incomplete native inventory and starts no observer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-archive-daemon-')), archived = { ...source, archived: true };
  let registered = 0, started = 0, marked = 0;
  const binding = { happySessionId: 'old-mirror', source, metadata: { bridge: { source }, nativeSession: { catalogueAvailable: true } } };
  const connection = { socket: {}, registerRpc: () => {}, waitForConnect: async () => {}, close: () => {} };
  const daemon = new CodeLightMacDaemon({ directory, account: { secret: randomBytes(32).toString('base64'), serverUrl: 'http://127.0.0.1:1' },
    discovery: { discover: async () => ({ sources: [], hiddenSources: [archived], errors: ['antigravity-index-unavailable'] }), adapter: () => ({}) },
    registry: { machine: async () => ({ id: 'machine', metadata: {} }), register: async () => { registered++; return binding; }, existingBinding: async () => binding,
      markArchived: async () => { if ((/** @type {Value} */ (binding.metadata.nativeSession)).archived !== true) marked++; binding.metadata.nativeSession = /** @type {any} */ ({ archived: true, catalogueAvailable: false }); } },
    machineConnection: () => connection, sourceFactory: async () => { started++; return {}; } });
  try {
    await daemon.start(); await daemon.scan(); assert.equal(marked, 1);
    binding.metadata.nativeSession = /** @type {any} */ ({ archived: false, catalogueAvailable: true });
    await daemon.scan(); assert.equal(marked, 2);
    assert.equal(registered, 0); assert.equal(started, 0); assert.equal(daemon.sources.size, 0); assert.equal(binding.metadata.nativeSession.catalogueAvailable, false);
  }
  finally { await daemon.close(); await rm(directory, { recursive: true, force: true }); }
});
