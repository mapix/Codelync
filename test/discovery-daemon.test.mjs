import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Socket } from 'node:net';
import nacl from 'tweetnacl';
import { pairCodeLight } from '../src/happy/discovery-pairing.mjs';
import { CodeLightMacDaemon } from '../src/happy/mac-daemon.mjs';
import { createBoundSource } from '../src/happy/bound-source.mjs';
import { sourceKey } from '../src/happy/source-registry.mjs';
import { BridgeError } from '../src/errors.mjs';
import { DeviceRegistry } from '../src/happy/device-registry.mjs';

/** @typedef {Record<string,any>} Value */
test('pairing uses an ephemeral public key, decrypts the approved account and preserves server identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-pair-')), path = join(directory, 'account.json'), secret = randomBytes(32); let calls = 0, link = '';
  const fakeFetch = /** @type {typeof fetch} */ (async (_url, request) => {
    const body = JSON.parse(/** @type {string} */ (request?.body)); assert.equal(body.supportsV2, false);
    const key = new Uint8Array(Buffer.from(body.publicKey, 'base64')); assert.equal(key.length, 32);
    if (++calls === 1) return new Response(JSON.stringify({ state: 'requested' }));
    const ephemeral = nacl.box.keyPair(), nonce = randomBytes(24), cipher = nacl.box(secret, nonce, key, ephemeral.secretKey);
    return new Response(JSON.stringify({ state: 'authorized', token: 'fixture-token', response: Buffer.concat([Buffer.from(ephemeral.publicKey), nonce, Buffer.from(cipher)]).toString('base64') }));
  });
  try {
    const account = await pairCodeLight({ accountPath: path, serverUrl: 'http://127.0.0.1:9999', fetch: fakeFetch, pollMs: 1, onLink: value => { link = value; } });
    assert.ok(link.startsWith('codelight://terminal?')); assert.equal(account.secret, secret.toString('base64')); assert.equal((await stat(path)).mode & 0o777, 0o600);
    const again = await pairCodeLight({ accountPath: path, serverUrl: account.serverUrl, fetch: fakeFetch }); assert.equal(again.token, account.token); assert.equal(calls, 2);
    await assert.rejects(pairCodeLight({ accountPath: path, serverUrl: 'http://127.0.0.1:9998', fetch: fakeFetch }), /another server/); assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unreadable or invalid pairing reply cannot save a credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-pair-invalid-')), path = join(directory, 'account.json');
  try {
    await assert.rejects(pairCodeLight({ accountPath: path, serverUrl: 'http://127.0.0.1:9999', fetch: /** @type {typeof fetch} */ (async () => new Response(JSON.stringify({ state: 'authorized', token: 'fixture', response: Buffer.alloc(80).toString('base64') }))) }), /could not be decrypted/);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function machineFixture() {
  const handlers = /** @type {Map<string,(params:unknown)=>Promise<any>>} */ (new Map());
  return { handlers, connection: { registerRpc: (/** @type {string} */ method, /** @type {(params:unknown)=>Promise<any>} */ handler) => { handlers.set(method, handler); }, waitForConnect: async () => {}, close: () => {} } };
}
async function daemonFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-daemon-')), source = { app: 'codex', hostId: 'local', id: 'fixture-original-source', kind: 'session' }, key = sourceKey(source);
  const binding = { happySessionId: 'fixture-projection', source, sessionKey: randomBytes(32).toString('base64'), metadata: { bridge: { source } } };
  const machine = machineFixture(); let created = 0, opened = 0, started = 0, fail = false;
  const options = { directory, account: { serverUrl: 'http://127.0.0.1:9999', token: 'fixture-token', secret: randomBytes(32).toString('base64') },
    discovery: { discover: async () => ({ sources: [source] }), adapter: () => ({}) },
    registry: { machine: async () => ({ id: 'fixture-machine', metadata: {} }), register: async () => binding },
    machineConnection: () => machine.connection, sourceFactory: async () => { created++; return { openDesktop: async () => { opened++; if (fail) throw new BridgeError('delivery-unknown', 'Fixture lost open ACK'); }, start: async () => { started++; }, status: () => ({ sourceStatus: 'connected' }), close: async () => {} }; } };
  return { directory, source, key, options, machine, counts: () => ({ created, opened, started }), fail: (/** @type {boolean} */ value) => { fail = value; } };
}

test('without background notification observation, remembered quiescent history stays lazy while pending inbox restores', async () => {
  const f = await daemonFixture();
  await writeFile(join(f.directory, 'active-sources.json'), JSON.stringify({ version: 1, keys: [f.key] }));
  let daemon = new CodeLightMacDaemon({ ...f.options, observeBackground: false });
  try {
    await daemon.start(); assert.equal(f.counts().created, 0); await daemon.close();
    await mkdir(join(f.directory, 'active', f.key), { recursive: true });
    await writeFile(join(f.directory, 'active', f.key, 'transport.json'), JSON.stringify({ inbox: [{ id: 'queued-phone-input' }], outbox: [] }));
    daemon = new CodeLightMacDaemon({ ...f.options, observeBackground: false });
    await daemon.start(); await Promise.all([...daemon.activating.values()]);
    assert.equal(f.counts().created, 1); assert.equal(f.counts().opened, 0);
  } finally { await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('fresh HTTP foreground keeps an idle Antigravity observer across socket loss and releases it only after expiry or revocation', async () => {
  const f = await daemonFixture();
  const source = { app: 'antigravity', id: 'fixture-native-antigravity', hostId: 'local:antigravity:' + 'a'.repeat(64),
    kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: 'fixture-owner' }, key = sourceKey(source);
  const binding = { happySessionId: 'fixture-antigravity-projection', source, sessionKey: randomBytes(32).toString('base64'), metadata: { bridge: { source, controlMode: 'session' } } };
  const devices = new DeviceRegistry(join(f.directory, 'devices.json'), [{ id: 'fixture-device', publicKey: 'fixture-only', revoked: false }]);
  const socket = new Socket(); devices.connected('fixture-device', socket);
  let retired = 0, starts = 0;
  const daemon = new CodeLightMacDaemon({ ...f.options, observeBackground: false, viewedSessions: () => devices.viewedSessions(),
    discovery: { discover: async () => ({ sources: [source] }), adapter: () => ({}) },
    registry: { ...f.options.registry, register: async () => binding },
    sourceFactory: async () => ({ supportsDesktopNavigation: false, start: async () => { starts++; }, close: async () => {},
      status: () => ({ sourceStatus: 'connected' }), tryCloseIfIdle: async () => { retired++; return true; } }) });
  try {
    await daemon.start(); await daemon.observeSource({ sourceKey: key, commandId: 'fixture-observe-http-foreground' }); await Promise.all([...daemon.starts.values()]);
    devices.viewingPresence('fixture-device', { active: true, sessionId: binding.happySessionId, sequence: 7 });
    daemon.lastUsed.set(key, Date.now() - 31000); socket.emit('close');
    assert.equal(devices.list()[0].connected, false); assert.deepEqual([...devices.viewedSessions()], [binding.happySessionId]);
    await daemon.retireUnviewed(); assert.equal(retired, 0); assert.equal(daemon.actors.has(key), true);
    assert.equal(devices.viewingPresence('fixture-device', { active: false, sessionId: 'old-screen', sequence: 6 }), false);
    await daemon.retireUnviewed(); assert.equal(retired, 0);
    devices.rows[0].presence.at = Date.now() - 45001;
    await daemon.retireUnviewed(); assert.equal(retired, 1); assert.equal(daemon.actors.has(key), false);
    devices.viewingPresence('fixture-device', { active: true, sessionId: binding.happySessionId, sequence: 8 });
    await daemon.observeSource({ sourceKey: key, commandId: 'fixture-observe-new-http-foreground' }); await Promise.all([...daemon.starts.values()]);
    daemon.lastUsed.set(key, Date.now() - 31000); await devices.revoke('fixture-device');
    await daemon.retireUnviewed(); assert.equal(retired, 2); assert.equal(daemon.actors.has(key), false);
    assert.equal(starts, 2); assert.equal(daemon.status().modelRunnersStarted, 0);
  } finally { socket.destroy(); await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('discovery stays lazy, repeated machine RPC dispatches one original open and unknown receipt never replays', async () => {
  const f = await daemonFixture(), daemon = new CodeLightMacDaemon(f.options);
  try {
    await daemon.start(); assert.deepEqual(f.counts(), { created: 0, opened: 0, started: 0 }); assert.equal(daemon.status().sources, 1);
    const request = { sourceKey: f.key, commandId: 'fixture-open-once' };
    const results = await Promise.all([daemon.openSource(request), daemon.openSource(request)]); assert.equal(results[0].receipt.status, 'complete'); assert.deepEqual(f.counts(), { created: 1, opened: 1, started: 1 });
    await daemon.openSource(request); assert.equal(f.counts().opened, 1);
    f.fail(true); const unknown = { sourceKey: f.key, commandId: 'fixture-open-unknown' }; assert.equal((await daemon.openSource(unknown)).receipt.status, 'unknown');
    await daemon.openSource(unknown); assert.equal(f.counts().opened, 2);
    await assert.rejects(daemon.openSource({ sourceKey: 'a'.repeat(64), commandId: 'fixture-unregistered' }), { code: 'source-unavailable' });
    assert.equal(f.counts().opened, 2);
  } finally { await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('daemon restart restores observation but never repeats the prior desktop open or unknown operation', async () => {
  const f = await daemonFixture(); let daemon = new CodeLightMacDaemon(f.options);
  try {
    await daemon.start(); f.fail(true); const request = { sourceKey: f.key, commandId: 'fixture-restart-unknown' };
    assert.equal((await daemon.openSource(request)).receipt.status, 'unknown'); await daemon.close(); f.fail(false);
    daemon = new CodeLightMacDaemon(f.options); await daemon.start(); await Promise.all([...daemon.activating.values()]);
    assert.equal(f.counts().opened, 1); assert.equal(f.counts().started, 1);
    assert.equal((await daemon.openSource(request)).receipt.status, 'unknown'); assert.equal(f.counts().opened, 1);
  } finally { await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('each explicit selection navigates before a slow initial snapshot; stale selection cannot switch back', async () => {
  const f = await daemonFixture(); let finish = () => {}; const hydration = new Promise(resolve => { finish = () => resolve(undefined); });
  let opened = 0, started = 0;
  f.options.sourceFactory = async () => ({ openDesktop: async () => { opened++; }, start: async () => { started++; await hydration; }, status: () => ({ sourceStatus: 'connected' }), close: async () => {} });
  const daemon = new CodeLightMacDaemon(f.options);
  try {
    await daemon.start();
    const selection = { sourceKey: f.key, commandId: 'selection-first', selectionClient: 'phone-fixture', selectionSeq: 1 };
    assert.equal((await daemon.selectSource(selection)).receipt.status, 'complete');
    await Promise.resolve(); assert.equal(opened, 1);
    assert.equal((await daemon.selectSource({ ...selection, commandId: 'selection-second', selectionSeq: 2 })).receipt.status, 'complete'); assert.equal(opened, 2);
    const stale = await daemon.selectSource({ ...selection, commandId: 'selection-stale' }); assert.equal(stale.receipt.error, 'selection-superseded'); assert.equal(opened, 2);
    await daemon.selectSource(selection); assert.equal(opened, 2);
    finish(); await Promise.all([...daemon.starts.values()]); assert.equal(started, 1);
    await daemon.observeSource({ sourceKey: f.key, commandId: 'observe-foreground' }); assert.equal(opened, 2);
  } finally { finish(); await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('close-source releases only its CodeLight observer and does not resume it on restart', async () => {
  const f = await daemonFixture(); let daemon = new CodeLightMacDaemon(f.options);
  try {
    await daemon.start(); await daemon.openSource({ sourceKey: f.key, commandId: 'fixture-open-before-close' });
    const reply = await daemon.closeSource({ sourceKey: f.key, commandId: 'fixture-close-observer' });
    assert.equal(/** @type {Value} */ (reply.receipt.result).originalAgentStopped, false); assert.equal(daemon.status().activeSources, 0);
    await daemon.close(); daemon = new CodeLightMacDaemon(f.options); await daemon.start();
    assert.equal(daemon.activating.size, 0); assert.equal(f.counts().opened, 1); assert.equal(f.counts().started, 1);
  } finally { await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('a source lease prevents another profile from acquiring a second writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-source-lease-'));
  const common = { account: { serverUrl: 'http://127.0.0.1:9999', token: 'fixture' }, binding: { source: { app: 'codex', hostId: 'local', id: 'fixture-source' }, happySessionId: 'fixture-session', sessionKey: randomBytes(32).toString('base64'), metadata: {} }, leaseDirectory: join(directory, 'leases'), adapter: {} };
  const first = await createBoundSource({ ...common, directory: join(directory, 'first') });
  try { await assert.rejects(createBoundSource({ ...common, directory: join(directory, 'second') }), error => /** @type {Value} */ (error).code === 'ELOCKED'); }
  finally { await first.close(); await rm(directory, { recursive: true, force: true }); }
});

test('project activity RPC stays read-only and closes its separate observation service', async () => {
  const f = await daemonFixture();
  /** @type {Value[]} */
  const calls = []; let closed = 0;
  const daemon = new CodeLightMacDaemon({ ...f.options, activityFactory: () => ({ poll: (/** @type {Value} */ input) => { calls.push(input); return { ok: true, version: 1 }; }, close: async () => { closed++; } }) });
  try {
    await daemon.start();
    const request = { clientId: 'phone-project-status', requestSeq: 1, groups: [] };
    const handler = f.machine.handlers.get('codelight-project-activity');
    assert.ok(handler); assert.deepEqual(await handler(request), { ok: true, version: 1 });
    assert.deepEqual(calls, [request]); assert.deepEqual(f.counts(), { created: 0, opened: 0, started: 0 });
  } finally { await daemon.close(); assert.equal(closed, 1); await rm(f.directory, { recursive: true, force: true }); }
});

test('failed inventory preserves sources; a complete empty inventory marks only the catalog unavailable', async () => {
  const f = await daemonFixture();
  /** @type {{sources:Value[],errors:string[]}} */
  let result = { sources: [f.source], errors: [] }; let unavailable = 0;
  const daemon = new CodeLightMacDaemon({ ...f.options,
    discovery: { ...f.options.discovery, discover: async () => result },
    registry: { ...f.options.registry, markUnavailable: async () => { unavailable++; } },
  });
  try {
    await daemon.start();
    result = { sources: [], errors: ['codex-index-unavailable'] }; await daemon.scan();
    assert.equal(daemon.sources.size, 1); assert.equal(unavailable, 0); assert.equal(daemon.inventoryAvailable, false);
    result = { sources: [], errors: [] }; await daemon.scan();
    assert.equal(daemon.sources.size, 0); assert.equal(unavailable, 1); assert.deepEqual(f.counts(), { created: 0, opened: 0, started: 0 });
  } finally { await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('three-app completeness and cold reconciliation respect configured native application authority', async () => {
  const f = await daemonFixture();
  const claude = { app: 'claude-desktop', kind: 'session', id: 'native', hostId: 'local:claude-desktop:' + 'a'.repeat(64), protocol: 'claude-desktop-native',
    runtimeGeneration: 'owner', appMode: 'code', nativeCollection: 'claude-code-sessions' };
  const savedClaude = { happySessionId: 'cached-claude', machineId: 'fixture-machine', source: claude, metadata: { nativeSession: { catalogueAvailable: true } } };
  let result = /** @type {{sources:Value[],errors:string[],inventoryApps:string[]}} */ ({ sources: [f.source], errors: [], inventoryApps: [] });
  const removed = /** @type {string[]} */ ([]);
  const daemon = new CodeLightMacDaemon({ ...f.options, discovery: { ...f.options.discovery, discover: async () => result },
    registry: { ...f.options.registry, savedBindings: async () => [savedClaude], markUnavailable: async (/** @type {Value} */ binding) => { removed.push(binding.source.app); } } });
  try {
    await daemon.start(); assert.equal(daemon.inventoryAvailable, true); assert.equal(daemon.registrationAvailable, true); assert.deepEqual(removed, []);
    result = { sources: [], errors: ['claude-desktop-index-unavailable'], inventoryApps: [] }; await daemon.scan();
    assert.equal(daemon.inventoryAvailable, false); assert.equal(daemon.inventoryApps.has('claude-desktop'), false);
    assert.equal(daemon.sources.has(sourceKey(claude)), true); assert.equal(savedClaude.metadata.nativeSession.catalogueAvailable, true);
    assert.equal(removed.filter(app => app === 'claude-desktop').length, 0); assert.equal(daemon.registrationAvailable, true);
    result = { sources: [], errors: [], inventoryApps: ['claude-desktop'] }; await daemon.scan();
    assert.equal(daemon.inventoryAvailable, true); assert.equal(daemon.inventoryApps.size, 3);
    assert.equal(removed.filter(app => app === 'claude-desktop').length, 1);
    await daemon.scan(); assert.equal(removed.filter(app => app === 'claude-desktop').length, 1);
  } finally { await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('registered descriptors load before native discovery without observers or runtime-state authority', async () => {
  const f = await daemonFixture();
  const child = { app: 'antigravity', id: 'native-child', hostId: 'local:antigravity:' + 'b'.repeat(64), kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: 'fixture-owner' };
  const metadata = { path: '/fixture/child', nativeSession: { title: 'Child reader', updatedAt: 12345, parentId: 'native-parent', agentName: 'Auditor', isSubagent: true,
    projectKey: 'fixture-project', projectPath: '/fixture', projectLabel: 'Fixture', catalogueAvailable: true } };
  const binding = { happySessionId: 'registered-child', source: child, machineId: 'fixture-machine', metadata };
  const saved = [binding,
    { ...binding, source: { ...child, id: 'foreign-machine' }, machineId: 'other-machine' },
    { ...binding, source: { ...child, id: 'archived' }, metadata: { nativeSession: { archived: true } } },
    { ...binding, source: { ...child, id: 'unavailable' }, metadata: { nativeSession: { catalogueAvailable: false } } },
    { ...binding, source: { app: 'zcode', hostId: 'local', id: 'deferred-window', kind: 'window' } },
    { ...binding, source: { ...child, id: 'filtered' } }];
  let finish = (/** @type {Value[]} */ _bindings) => {}, entered = () => {}, discoveryCalls = 0;
  const loaded = new Promise(/** @param {(value:Value[])=>void} resolve */ resolve => { finish = resolve; });
  const loading = new Promise(resolve => { entered = () => resolve(undefined); });
  const daemon = new CodeLightMacDaemon({ ...f.options, only: source => source.id !== 'filtered',
    registry: { ...f.options.registry, savedBindings: async () => { entered(); return loaded; } },
    discovery: { ...f.options.discovery, discover: async () => { discoveryCalls++; assert.equal(daemon.registrationAvailable, true);
      return { sources: [], errors: ['codex-index-unavailable', 'antigravity-index-unavailable', 'claude-desktop-index-unavailable'] }; } } });
  const starting = daemon.start();
  try {
    await loading; assert.equal(daemon.registrationAvailable, false); assert.equal(daemon.sources.size, 0); assert.equal(discoveryCalls, 0);
    finish(saved); await starting;
    assert.equal(daemon.registrationAvailable, true); assert.equal(daemon.inventoryAvailable, false); assert.equal(daemon.sources.size, 1);
    assert.deepEqual(daemon.sources.get(sourceKey(child)), { binding, source: { ...child, title: 'Child reader', updatedAt: 12345, workspace: '/fixture/child',
      parentId: 'native-parent', agentName: 'Auditor', isSubagent: true, project: { key: 'fixture-project', path: '/fixture', label: 'Fixture' } } });
    assert.deepEqual(f.counts(), { created: 0, opened: 0, started: 0 });
    assert.equal(daemon.activityInventoryAvailable, false); assert.equal(daemon.actors.size, 0);
  } finally { finish(saved); await starting.catch(() => {}); await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('missing registration loading leaves catalog authority unavailable even after healthy discovery', async () => {
  const f = await daemonFixture(), daemon = new CodeLightMacDaemon(f.options);
  try {
    await daemon.start(); assert.equal(daemon.registrationAvailable, false); assert.equal(daemon.inventoryAvailable, true);
    assert.equal(daemon.sources.size, 1); assert.deepEqual(f.counts(), { created: 0, opened: 0, started: 0 });
  } finally { await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('invalid registration results and lease loss during loading cannot publish a source map', async t => {
  for (const failure of ['invalid-map', 'lost-lease']) await t.test(failure, async () => {
    const f = await daemonFixture(); let finish = () => {}, entered = () => {};
    const loading = new Promise(resolve => { entered = () => resolve(undefined); });
    const saved = new Promise(resolve => { finish = () => resolve(failure === 'invalid-map' ? null : [{ source: f.source, machineId: 'fixture-machine' }]); });
    const daemon = new CodeLightMacDaemon({ ...f.options, registry: { ...f.options.registry, savedBindings: async () => { entered(); return saved; } } });
    const starting = daemon.start();
    try {
      await loading; assert.equal(daemon.registrationAvailable, false);
      if (failure === 'lost-lease') daemon.ownsLease = false;
      finish(); await assert.rejects(starting, { code: 'source-unavailable' });
      assert.equal(daemon.registrationAvailable, false); assert.equal(daemon.sources.size, 0); assert.equal(daemon.closed, true);
      assert.deepEqual(f.counts(), { created: 0, opened: 0, started: 0 });
    } finally { finish(); await starting.catch(() => {}); await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
  });
});

test('restored foreign harness and explicit Codex window bindings cannot start current product observers', async () => {
  const f = await daemonFixture(), sources = [
    { app: 'zcode', hostId: 'local', id: 'old-window', kind: 'window' },
    { app: 'codex', hostId: 'local', id: 'old-codex-window', kind: 'window' },
  ];
  await mkdir(join(f.directory, 'sources'), { recursive: true });
  for (const source of sources) await writeFile(join(f.directory, 'sources', sourceKey(source) + '.json'), JSON.stringify({
    happySessionId: 'old-projection', machineId: 'fixture-machine', serverUrl: f.options.account.serverUrl, source,
    metadata: { bridge: { source, controlMode: 'window' } },
  }));
  await writeFile(join(f.directory, 'active-sources.json'), JSON.stringify({ keys: sources.map(sourceKey) }));
  const daemon = new CodeLightMacDaemon(f.options);
  try {
    await daemon.start(); assert.equal(daemon.sources.size, 1);
    assert.deepEqual(f.counts(), { created: 0, opened: 0, started: 0 });
  } finally { await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('seventeen project selections recycle idle observers without restoring the retired one', async () => {
  const f = await daemonFixture(), sources = Array.from({ length: 17 }, (_, n) => ({ ...f.source, id: `fixture-${n}` }));
  let created = 0, retired = 0;
  const daemon = new CodeLightMacDaemon({ ...f.options,
    discovery: { ...f.options.discovery, discover: async () => ({ sources }) },
    registry: { ...f.options.registry, register: async (/** @type {Value} */ source) => ({ source, happySessionId: `projection-${source.id}`, metadata: { bridge: { controlMode: 'session' } } }) },
    sourceFactory: async () => {
      created++;
      return { start: async () => {}, openDesktop: async () => {}, close: async () => {}, status: () => ({}), tryCloseIfIdle: async () => { retired++; return true; } };
    },
  });
  try {
    await daemon.start();
    for (const [index, source] of sources.entries()) {
      await daemon.observeSource({ sourceKey: sourceKey(source), commandId: `switch-fixture-${index}` });
      await Promise.all([...daemon.starts.values()]);
      assert.ok(daemon.actors.size <= 16);
    }
    assert.equal(created, 17); assert.equal(retired, 1); assert.equal(daemon.starts.size, 0);
    assert.equal(daemon.restored.has(sourceKey(sources[0])), false);
    await daemon.scan(); assert.equal(created, 17);
    await daemon.observeSource({ sourceKey: sourceKey(sources[0]), commandId: 'switch-revisit-0' });
    await Promise.all([...daemon.starts.values()]); assert.equal(created, 18); assert.equal(retired, 2);
  } finally { await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test('capacity recycling protects the other foreground viewer and serializes factory reservations', async () => {
  const f = await daemonFixture(), sources = Array.from({ length: 4 }, (_, n) => ({ ...f.source, id: `fixture-${n}` }));
  const viewed = new Set(['projection-fixture-0']);
  /** @type {string[]} */
  const retired = [];
  let factories = 0, peak = 0;
  const daemon = new CodeLightMacDaemon({ ...f.options, maxActiveSources: 2, viewedSessions: () => viewed,
    discovery: { ...f.options.discovery, discover: async () => ({ sources }) },
    registry: { ...f.options.registry, register: async (/** @type {Value} */ source) => ({ source, happySessionId: `projection-${source.id}`, metadata: { bridge: { controlMode: 'session' } } }) },
    sourceFactory: async options => {
      factories++; peak = Math.max(peak, factories); await Promise.resolve(); factories--;
      return { start: async () => {}, close: async () => {}, status: () => ({}), tryCloseIfIdle: async () => { retired.push(options.binding.source.id); return true; } };
    },
  });
  try {
    await daemon.start();
    for (const [n, source] of sources.slice(0, 3).entries()) {
      await daemon.observeSource({ sourceKey: sourceKey(source), commandId: `view-protect-${n}` }); await Promise.all([...daemon.starts.values()]);
    }
    assert.deepEqual(retired, ['fixture-1']); assert.ok(daemon.actors.has(sourceKey(sources[0])));
    viewed.clear();
    await Promise.all([daemon.prepareSource(sourceKey(sources[1])), daemon.prepareSource(sourceKey(sources[3]))]);
    assert.equal(peak, 1); assert.equal(daemon.actors.size, 2);
  } finally { await daemon.close(); await rm(f.directory, { recursive: true, force: true }); }
});
