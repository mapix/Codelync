import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopSourceSubscriptions, DESKTOP_SOURCE_APPS } from '../src/codelync/source-subscriptions.mjs';
import { CodelyncMacDaemon } from '../src/codelync/mac-daemon.mjs';
import { MacConnectionService } from '../src/codelync/mac-connection-service.mjs';
import { SourceRegistry, sourceKey } from '../src/codelync/source-registry.mjs';
/** @typedef {Record<string,any>} Value */

const nativeSources = [
  { app: 'codex', id: 'fixture-codex', hostId: 'local', kind: 'session', workspace: '/fixture/project' },
  { app: 'antigravity', id: 'fixture-ag', hostId: 'local:antigravity:' + 'a'.repeat(64), kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: 'fixture-owner', workspace: '/fixture/project' },
  { app: 'claude-desktop', id: 'fixture-claude', hostId: 'local:claude-desktop:' + 'b'.repeat(64), kind: 'session', protocol: 'claude-desktop-native', runtimeGeneration: 'fixture-owner', appMode: 'code', nativeCollection: 'claude-code-sessions', workspace: '/fixture/project' },
];
/** @param {Value} source @returns {Value} */
function bindingFor(source) { return { source, machineId: 'fixture-machine', happySessionId: 'relay-' + source.id, sessionKey: randomBytes(32).toString('base64'), metadata: {
  client: { id: 'noninvasive-bridge' }, machineId: 'fixture-machine', path: source.workspace, bridge: { source, controlMode: 'session', sourceStatus: 'connected' },
  nativeSession: { title: source.id, updatedAt: 1, parentId: null, agentName: '', catalogueAvailable: true, archived: false }, capabilities: { steering: true, abort: true, rpcMethods: ['abort'] },
} }; }
function gate() { let finish = () => {}; const promise = new Promise(resolve => { finish = () => resolve(undefined); }); return { promise, finish }; }
async function flush() { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); }
/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-subscription-daemon-'));
  const settings = new DesktopSourceSubscriptions({ path: join(directory, 'source-choices.json') }); await settings.reload();
  const sources = nativeSources.map(source => ({ ...source })), bindings = new Map(sources.map(source => [sourceKey(source), bindingFor(source)]));
  const controls = /** @type {Value} */ ({}), counts = { created: 0, started: 0, closed: 0, navigated: 0, markedDisabled: 0, scans: 0, providersClosed: 0 };
  const actors = /** @type {Value[]} */ ([]), activity = { current: /** @type {string[]} */ ([]), closed: false };
  const connection = { socket: { connected: true }, registerRpc() {}, waitForConnect: async () => {}, close() {} };
  const registry = /** @type {Value} */ ({ machine: async () => ({ id: 'fixture-machine', metadata: {} }), savedBindings: async () => [...bindings.values()],
    register: async (/** @type {Value} */ source) => { let binding = bindings.get(sourceKey(source)); if (!binding) { binding = bindingFor(source); bindings.set(sourceKey(source), binding); } if (controls.registration) await controls.registration; return binding; },
    queueMetadata: async (/** @type {Value} */ binding, /** @type {Value} */ _socket, /** @type {(value:Value)=>Value} */ update) => { binding.metadata = update(binding.metadata); },
    markDisabled: async (/** @type {Value} */ binding, /** @type {Value} */ socket) => { counts.markedDisabled++; await SourceRegistry.prototype.markDisabled.call(/** @type {any} */ (registry), binding, /** @type {any} */ (socket)); },
    markEnabled: async (/** @type {Value} */ binding, /** @type {Value} */ socket) => SourceRegistry.prototype.markEnabled.call(/** @type {any} */ (registry), binding, /** @type {any} */ (socket)) });
  const options = { directory: join(directory, 'connector'), leaseDirectory: join(directory, 'leases'), sourceSubscriptions: settings,
    account: { serverUrl: 'http://127.0.0.1:9', token: 'fixture-account', secret: randomBytes(32).toString('base64url') }, registry,
    machineConnection: () => connection,
    activityFactory: (/** @type {Value} */ config) => ({ intrinsicRefresh: () => { activity.current = config.sources().map((/** @type {Value} */ source) => source.app); }, close: () => { activity.closed = true; } }),
    discovery: { discover: async () => { counts.scans++; const enabled = DESKTOP_SOURCE_APPS.filter(app => settings.isEnabled(app)), captured = sources.filter(source => settings.isEnabled(source.app));
      if (controls.scan) await controls.scan; return { sources: captured, inventoryApps: enabled, activityInventoryApps: enabled, errors: [] }; },
      adapter: () => ({}), reconcileSubscriptions: async () => { counts.providersClosed++; } },
    sourceFactory: async (/** @type {Value} */ input) => {
      counts.created++; const actor = { sourceApp: input.binding.source.app, lease: input.assertHostLease, closed: false,
        openDesktop: async () => { counts.navigated++; }, start: async () => { counts.started++; if (controls.start) await controls.start; },
        close: async () => { if (!actor.closed) { actor.closed = true; counts.closed++; } }, status: () => ({ sourceStatus: actor.closed ? 'disconnected' : 'connected' }) };
      actors.push(actor); if (controls.factory) await controls.factory; return actor;
    } };
  const daemon = new CodelyncMacDaemon(options); await daemon.start();
  t.after(async () => { controls.scan = null; await daemon.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, settings, daemon, counts, actors, bindings, sources, controls, activity, options };
}

test('disable preserves receipts/inbox, stops Codelync observations and re-enable never resumes the old full actor', async t => {
  const f = await fixture(t), source = nativeSources[1], key = sourceKey(source);
  await f.daemon.observeSource({ sourceKey: key, commandId: 'fixture-observe-ag' }); await Promise.all([...f.daemon.starts.values()]);
  const folder = join(f.directory, 'connector', 'active', key); await mkdir(folder, { recursive: true });
  const receipts = '{"commands":[{"id":"fixture-native-unknown","status":"unknown"}]}', inbox = '{"inbox":[{"id":"fixture-pending"}],"outbox":[]}';
  await writeFile(join(folder, 'receipts.json'), receipts); await writeFile(join(folder, 'transport.json'), inbox);
  await f.settings.setEnabledApps([]); await f.daemon.reconcileSourceSubscriptions();
  assert.equal(f.daemon.actors.size, 0); assert.equal(f.daemon.sources.size, 0); assert.equal(f.actors[0].lease(), false); assert.deepEqual(f.activity.current, []);
  assert.equal(await readFile(join(folder, 'receipts.json'), 'utf8'), receipts); assert.equal(await readFile(join(folder, 'transport.json'), 'utf8'), inbox);
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'connector', 'active-sources.json'), 'utf8')).keys, []);
  await f.settings.setEnabledApps(['antigravity']); await f.daemon.reconcileSourceSubscriptions();
  assert.equal(f.daemon.sources.size, 1); assert.equal(f.daemon.actors.size, 0); assert.equal(f.counts.created, 1); assert.equal(f.counts.started, 1); assert.equal(f.counts.navigated, 0);
  assert.deepEqual(f.activity.current, ['antigravity']);
});

test('an unchanged source actor and lease remain live when another desktop is disabled', async t => {
  const f = await fixture(t);
  for (const source of nativeSources.slice(0, 2)) await f.daemon.observeSource({ sourceKey: sourceKey(source), commandId: 'fixture-observe-' + source.app });
  await Promise.all([...f.daemon.starts.values()]); const codex = f.daemon.actors.get(sourceKey(nativeSources[0]));
  assert.ok(codex);
  await f.settings.setEnabledApps(['codex', 'claude-desktop']); await f.daemon.reconcileSourceSubscriptions();
  assert.equal(f.daemon.actors.get(sourceKey(nativeSources[0])), codex); assert.equal(codex.lease(), true); assert.equal(f.counts.closed, 1); assert.equal(f.counts.created, 2);
  assert.equal(f.counts.navigated, 0); assert.equal(f.daemon.inventoryApps.has('antigravity'), false);
});

test('partial historical inventory cannot retain activity authority across a source disable', async t => {
  const f = await fixture(t);
  f.options.discovery.discover = async () => ({ sources: f.sources, inventoryApps: ['codex', 'claude-desktop'], activityInventoryApps: [...DESKTOP_SOURCE_APPS], errors: [] });
  await f.daemon.scan(); assert.equal(f.daemon.inventoryApps.has('antigravity'), false); assert.equal(f.daemon.activityInventoryApps.has('antigravity'), true);
  await f.settings.setEnabledApps(['codex', 'claude-desktop']); f.daemon.fenceSourceSubscriptions();
  assert.equal(f.daemon.activityInventoryApps.has('antigravity'), false);
  await f.settings.setEnabledApps(DESKTOP_SOURCE_APPS); f.daemon.fenceSourceSubscriptions();
  assert.equal(f.daemon.activityInventoryApps.has('antigravity'), false);
});

test('a held scan cannot reinsert disabled descriptors or supply native inventory authority', async t => {
  const f = await fixture(t), held = gate(); f.controls.scan = held.promise;
  const scanning = f.daemon.scan(); await flush(); await f.settings.setEnabledApps([]); f.daemon.fenceSourceSubscriptions(); held.finish(); await scanning;
  assert.equal(f.daemon.sources.size, 0); assert.equal(f.daemon.inventoryApps.size, 0); assert.equal(f.counts.created, 0); assert.equal(f.counts.markedDisabled, 0);
  f.controls.scan = null; await f.settings.setEnabledApps(['codex']); await f.daemon.reconcileSourceSubscriptions(); assert.equal(f.daemon.sources.size, 1);
});

test('a registration sent before disable is retained as unavailable and cannot start an observer', async t => {
  const f = await fixture(t), held = gate(), source = { ...nativeSources[0], id: 'fixture-new-codex' }; f.sources.push(source); f.controls.registration = held.promise;
  const scanning = f.daemon.scan(); await flush(); await f.settings.setEnabledApps([]); f.daemon.fenceSourceSubscriptions(); held.finish(); await scanning;
  const binding = f.bindings.get(sourceKey(source)); assert.ok(binding);
  assert.equal(binding.metadata.nativeSession.sourceDisabled, true); assert.equal(binding.metadata.nativeSession.archived, false);
  assert.equal(f.daemon.sources.has(sourceKey(source)), false); assert.equal(f.counts.created, 0);
});

test('a preparation held across disable/re-enable closes its old actor before native observation starts', async t => {
  const f = await fixture(t), held = gate(); f.controls.factory = held.promise;
  const preparing = f.daemon.prepareSource(sourceKey(nativeSources[0])); await flush();
  await f.settings.setEnabledApps([]); f.daemon.fenceSourceSubscriptions(); await f.settings.setEnabledApps(DESKTOP_SOURCE_APPS); await f.daemon.reconcileSourceSubscriptions(); held.finish();
  await assert.rejects(preparing, { code: 'source-unavailable' }); assert.equal(f.counts.closed, 1); assert.equal(f.counts.started, 0); assert.equal(f.daemon.actors.size, 0);
});

test('a start waiting for the active-hint save cannot begin observation after disable', async t => {
  const f = await fixture(t), key = sourceKey(nativeSources[0]), actor = await f.daemon.prepareSource(key), held = gate();
  const originalSave = f.daemon.saveRestored; f.daemon.saveRestored = () => held.promise;
  const starting = f.daemon.startSource(key, actor); await flush(); await f.settings.setEnabledApps([]); f.daemon.fenceSourceSubscriptions(); held.finish();
  await assert.rejects(starting, { code: 'source-unavailable' }); assert.equal(f.counts.started, 0); assert.equal(f.counts.navigated, 0);
  f.daemon.saveRestored = originalSave;
});

test('a machine action queued before disable/re-enable cannot navigate the original desktop later', async t => {
  const f = await fixture(t), key = sourceKey(nativeSources[0]), held = gate();
  const receipts = /** @type {Value} */ (f.daemon.receipts);
  receipts.run = async (/** @type {string} */ _scope, /** @type {string} */ _id, /** @type {unknown} */ _payload, /** @type {()=>Promise<unknown>} */ execute) => { await held.promise; return execute(); };
  const opening = f.daemon.openSource({ sourceKey: key, commandId: 'fixture-queued-open' }); await flush();
  await f.settings.setEnabledApps([]); f.daemon.fenceSourceSubscriptions(); await f.settings.setEnabledApps(DESKTOP_SOURCE_APPS); await f.daemon.reconcileSourceSubscriptions(); held.finish();
  await assert.rejects(opening, { code: 'source-unavailable' }); assert.equal(f.counts.created, 0); assert.equal(f.counts.navigated, 0);
});

test('prepared catalog and selected reads reject a disabled source immediately, while bad preferences cannot publish an empty success', async t => {
  const f = await fixture(t), pair = { publicKey: randomBytes(32), secretKey: randomBytes(32) };
  const manager = Object.assign(new EventEmitter(), { candidates: () => [], close: async () => {} });
  const service = new MacConnectionService({ state: f.directory, cloudflared: '/fixture/cloudflared', upstream: 'http://127.0.0.1:9',
    account: f.options.account, daemon: f.daemon, devices: /** @type {any} */ ({ publicKey: () => null }), invitations: /** @type {any} */ ({ pair }),
    managerFactory: () => /** @type {any} */ (manager) });
  t.after(() => service.close()); service.recent.startCatalogMaintenance(); const first = service.recent.catalog({ catalogVersion: 2 }); assert.equal(first.sessions.length, 3);
  const binding = f.bindings.get(sourceKey(nativeSources[1])); assert.ok(binding); const id = binding.happySessionId;
  await f.settings.setEnabledApps(['codex', 'claude-desktop']); assert.throws(() => service.source(id), { code: 'source-unavailable' });
  f.daemon.fenceSourceSubscriptions(); const delta = service.recent.catalog({ catalogVersion: 2, since: first.watermark }); assert.deepEqual(delta.removedIds, [id]);
  assert.equal(f.counts.markedDisabled, 0, 'unviewed historical descriptors are not individually rewritten');
  await writeFile(f.settings.path, '{invalid'); await f.settings.reload(); f.daemon.fenceSourceSubscriptions();
  assert.throws(() => service.recent.catalog({ catalogVersion: 2 }), { code: 'source-unavailable' });
});
