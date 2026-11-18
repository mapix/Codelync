import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import sharp from 'sharp';
import { MacConnectionService } from '../src/codelync/mac-connection-service.mjs';
import { parseLanListenerPorts, readLanListenerPorts, writeLanListenerPorts } from '../src/codelync/lan-listener-ports.mjs';
import { ConnectionChannelsManager } from '../src/network/connection-channels.mjs';
import { PairingInvitations, createPairingGateway } from '../src/codelync/pairing-gateway.mjs';
import { DeviceRegistry } from '../src/codelync/device-registry.mjs';
import { NativeHappyConnector } from '../src/codelync/native-connector.mjs';
import { CommandReceipts } from '../src/commands.mjs';
import { decryptRecord } from '../src/codelync/session-transport.mjs';

/** @typedef {Record<string,any>} Value */

function deferred() {
  /** @type {(value?:unknown)=>void} */ let resolve = () => {};
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

/** @param {()=>boolean} predicate */
async function until(predicate) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate());
}

/** @param {import('node:test').TestContext} t */
async function connectionFixture(t) {
  const state = await mkdtemp(join(tmpdir(), 'codelync-swarm-b7-conn-'));
  const phone = nacl.box.keyPair(), mac = nacl.box.keyPair(), token = 'synthetic-b7-device-token';
  const account = { secret: randomBytes(32).toString('base64url') };
  const devices = new DeviceRegistry(join(state, 'devices.json'));
  const deviceId = await devices.approve(Buffer.from(phone.publicKey).toString('base64url'), 'B7 phone', token);
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { ...account, token, deviceId } });
  const backend = createServer((_req, res) => { res.end('ok'); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const address = backend.address(); assert.ok(address && typeof address !== 'string');
  const daemon = /** @type {import('../src/codelync/mac-daemon.mjs').CodelyncMacDaemon} */ (/** @type {unknown} */ ({
    sources: new Map(), actors: new Map(), closed: false, ownsLease: true, inventoryAvailable: true, registrationAvailable: true,
    machine: { id: 'machine-b7' },
  }));
  /** @type {import('node:http').Server[]} */ const gateways = [];
  let managerRef = /** @type {ConnectionChannelsManager|null} */ (null);
  const service = new MacConnectionService({
    state, cloudflared: 'unused', upstream: 'http://127.0.0.1:' + address.port, account, devices, invitations, daemon, networkWatchMs: 0,
    interfaces: () => ({ en0: [{ address: '192.168.50.2', family: 'IPv4', internal: false }] }),
    gatewayFactory: options => {
      const server = createPairingGateway(options), listen = server.listen.bind(server);
      gateways.push(server);
      server.listen = /** @type {typeof server.listen} */ ((/** @type {number} */ port, /** @type {string} */ _host) => listen(port, '127.0.0.1'));
      return server;
    },
    managerFactory: options => {
      managerRef = new ConnectionChannelsManager({
        ...options,
        transportFactory: config => ({ async start() { return config.kind === 'relay' ? 'https://b7-relay.example/r/aaaabbbbccccddddeeeeffff' : 'https://b7-cf.example'; }, activate() {}, close() {}, on() {} }),
        probesFor: () => ({ verify: async () => {} }),
      });
      return managerRef;
    },
  });
  t.after(async () => {
    await service.close(); invitations.close(); backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve));
    await rm(state, { recursive: true, force: true });
  });
  await service.start();
  await until(() => service.candidates().some(row => row.kind === 'local'));
  assert.ok(managerRef);
  return { state, service, deviceId, gateways, manager: managerRef };
}

test('R061: refreshNetwork contains malformed local candidate URLs without throwing and triggers local refresh', async t => {
  const f = await connectionFixture(t);
  const entry = f.manager.entries.get('local');
  assert.ok(entry);
  let refreshed = 0;
  const originalRefreshLocal = f.manager.refreshLocal.bind(f.manager);
  f.manager.refreshLocal = async () => { refreshed++; return originalRefreshLocal(); };
  entry.channels = [{ id: 'lan_bad', kind: 'local', url: 'not-a-valid-url', label: 'Local network' }];
  // Force a live refresh by resetting the entry URL without changing interfaces.
  const changed = await f.service.refreshNetwork();
  assert.equal(changed, true);
  assert.equal(refreshed, 1);
  const restored = f.service.candidates().filter(row => row.kind === 'local');
  assert.equal(restored.length, 1);
  assert.equal(new URL(restored[0].url).hostname, '192.168.50.2');
});

test('R061: startLocal needsRefresh handles malformed hosts safely and aborts close newly bound listeners cleanly', async t => {
  const state = await mkdtemp(join(tmpdir(), 'codelync-swarm-b7-local-'));
  const phone = nacl.box.keyPair(), mac = nacl.box.keyPair(), token = 'synthetic-b7-local-token';
  const account = { secret: randomBytes(32).toString('base64url') };
  const devices = new DeviceRegistry(join(state, 'devices.json'));
  await devices.approve(Buffer.from(phone.publicKey).toString('base64url'), 'B7 phone', token);
  const invitations = new PairingInvitations({ key: mac.secretKey, credentials: { ...account, token } });
  let hosts = ['192.168.50.2'];
  const bindGate = deferred();
  let holdSecond = false;
  /** @type {import('node:http').Server[]} */ const boundServers = [];
  const service = new MacConnectionService({
    state, cloudflared: 'unused', upstream: 'http://127.0.0.1:9', account, devices, invitations, networkWatchMs: 0,
    daemon: /** @type {any} */ ({ sources: new Map(), actors: new Map(), closed: false, ownsLease: true, inventoryAvailable: true }),
    interfaces: () => ({ en0: hosts.map(address => ({ address, family: 'IPv4', internal: false })) }),
    gatewayFactory: options => {
      const server = createPairingGateway(options), listen = server.listen.bind(server);
      boundServers.push(server);
      server.listen = /** @type {typeof server.listen} */ ((/** @type {number} */ port, /** @type {string} */ host) => {
        if (holdSecond && host === '10.20.30.2') {
          void bindGate.promise.then(() => listen(port, '127.0.0.1'));
          return server;
        }
        return listen(port, '127.0.0.1');
      });
      return server;
    },
  });
  t.after(async () => { bindGate.resolve(); await service.close(); invitations.close(); await rm(state, { recursive: true, force: true }); });
  const transport = await service.startLocal(new AbortController().signal);
  assert.equal(transport.needsRefresh(/** @type {any} */ (null)), true);
  assert.equal(transport.needsRefresh(['192.168.50.2']), false);
  // Aborting a concurrent refresh closes any newly bound listener before resolving/rejecting.
  hosts = ['192.168.50.2', '10.20.30.2'];
  holdSecond = true;
  const abortController = new AbortController();
  const refreshPromise = transport.refresh(abortController.signal);
  await until(() => boundServers.length === 2);
  abortController.abort();
  bindGate.resolve();
  await assert.rejects(refreshPromise, /local-network-unavailable/);
  assert.equal(boundServers[1].listening, false);
  assert.equal(boundServers[0].listening, true);
});

test('R061: peerApi rejects malformed URLs or invalid percent escapes with typed BridgeError', async t => {
  const f = await connectionFixture(t);
  await assert.rejects(f.service.peerApi('http://[::bad', 'GET', {}, f.deviceId), { code: 'invalid-peer-route' });
  await assert.rejects(f.service.peerApi('/api/peer/sessions/%ZZ/recent', 'POST', { limit: 1 }, f.deviceId), { code: 'invalid-session' });
});

test('R061: writeLanListenerPorts serializes overlapping state writes and validates malformed inputs cleanly', async t => {
  const state = await mkdtemp(join(tmpdir(), 'codelync-swarm-b7-ports-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  await assert.rejects(writeLanListenerPorts(state, /** @type {any} */ (null)), /invalid-lan-listener-ports/);
  await assert.rejects(writeLanListenerPorts(state, /** @type {any} */ ([{ host: 123, port: 50000 }])), /invalid-lan-listener-ports/);
  assert.deepEqual(parseLanListenerPorts(Object.assign(Object.create({ leaked: true }), { version: 1, listeners: [{ host: '192.168.50.2', port: 50000 }] })), []);

  // Overlapping concurrent writes for the same directory execute sequentially so the latest write wins deterministically.
  await Promise.all([
    writeLanListenerPorts(state, [{ host: '192.168.50.2', port: 50101 }]),
    writeLanListenerPorts(state, [{ host: '192.168.50.2', port: 50102 }, { host: '10.20.30.2', port: 50103 }]),
    writeLanListenerPorts(state, [{ host: '192.168.50.2', port: 50104 }]),
  ]);
  const saved = await readLanListenerPorts(state);
  assert.equal(saved.size, 1);
  assert.equal(saved.get('192.168.50.2'), 50104);

  // A failed write does not poison subsequent serialized writes for the same state dir.
  const target = join(state, 'lan-listeners.json');
  await rm(target);
  await mkdir(target);
  await assert.rejects(writeLanListenerPorts(state, [{ host: '192.168.50.2', port: 50105 }]));
  await rm(target, { recursive: true, force: true });
  await writeLanListenerPorts(state, [{ host: '192.168.50.2', port: 50106 }]);
  assert.equal((await readLanListenerPorts(state)).get('192.168.50.2'), 50106);
});

class ImageTransport extends EventEmitter {
  constructor() {
    super();
    this.sessionId = 'happy-b7-fixture';
    this.inbox = /** @type {Value[]} */ ([]);
    this.records = /** @type {Value[]} */ ([]);
    this.handlers = /** @type {Map<string,(params:unknown)=>Promise<any>>} */ (new Map());
    this.metadata = /** @type {Value} */ ({});
    this.agentState = /** @type {Value} */ ({});
    /** @type {(bytes:Buffer,options:Value)=>Promise<Value>} */
    this.uploadAttachment = async () => ({ ref: 'sessions/happy-b7-fixture/attachments/default.enc' });
  }
  async start() {}
  status() { return { pendingInbox: this.inbox.length, pendingOutbox: 0 }; }
  listInbox() { return structuredClone(this.inbox); }
  async ackInbox(/** @type {string} */ id) { this.inbox = this.inbox.filter(item => item.id !== id); }
  registerRpc(/** @type {string} */ method, /** @type {(params:unknown)=>Promise<any>} */ handler) { this.handlers.set(method, handler); return () => this.handlers.delete(method); }
  async updateMetadata(/** @type {(value:Value)=>Value} */ change) { this.metadata = change(this.metadata); }
  async updateAgentState(/** @type {(value:Value)=>Value|Promise<Value>} */ change) { this.agentState = await change(this.agentState); }
  async publish(/** @type {string} */ localId, /** @type {Value} */ record) { this.records.push({ localId, record: structuredClone(record) }); return { id: `log-${localId}` }; }
  async rpc(/** @type {string} */ method, /** @type {Value} */ params) { const handler = this.handlers.get(method); assert.ok(handler); return handler(params); }
}

/** @param {import('node:test').TestContext} t */
async function connectorFixture(t, view = {}, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-swarm-b7-conn-obs-'));
  const transport = new ImageTransport();
  const calls = /** @type {Value[]} */ ([]);
  let currentEpoch = 'owner-1', currentLease = true;
  const adapter = {
    supportsNativeModelSettings: false,
    view: /** @type {Value} */ ({ status: 'idle', currentTurnId: null, rows: [], requests: [], revision: 1, ...view }),
    snapshot: async () => structuredClone(adapter.view),
    subscribe: async (/** @type {string} */ _id, /** @type {(value:Value)=>void} */ callback) => { callback(structuredClone(adapter.view)); return () => {}; },
    command: async (/** @type {string} */ nativeId, /** @type {string} */ action, /** @type {Value} */ payload, /** @type {string} */ commandId) => {
      calls.push({ nativeId, action, payload, commandId });
      return { requested: true };
    },
  };
  const receipts = await CommandReceipts.load(join(directory, 'receipts.json'));
  const connector = new NativeHappyConnector({
    transport,
    adapter: /** @type {any} */ (adapter),
    nativeId: 'original-native-id',
    sourceIdentity: { app: 'codex', id: 'original-native-id', hostId: 'local' },
    bindingId: 'b7-binding',
    statePath: join(directory, 'connector.json'),
    encryptionKey: new Uint8Array(32).fill(7),
    getGeneration: () => currentEpoch,
    assertLease: () => currentLease,
    receipts,
    ...overrides,
  });
  t.after(async () => { await connector.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, transport, adapter, calls, connector, receipts, setEpoch: (/** @type {string} */ e) => { currentEpoch = e; }, setLease: (/** @type {boolean} */ l) => { currentLease = l; } };
}

test('R066: close() awaits in-flight native-image-read upload before releasing checkpoint ownership and aborts persistence/return cleanly', async t => {
  const f = await connectorFixture(t);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#112233' } }).png().toBuffer();
  const imagePath = join(f.directory, 'photo.png');
  await writeFile(imagePath, png);
  f.adapter.view.rows = [{ id: 'img-row', role: 'tool', text: '', turnId: 'turn-1', tools: [{ id: 'img-1', name: 'view_image', imagePath, output: '', status: 'completed' }] }];

  const enteredUpload = deferred();
  const releaseUpload = deferred();
  let uploads = 0;
  f.transport.uploadAttachment = async () => {
    uploads++;
    enteredUpload.resolve();
    await releaseUpload.promise;
    return { ref: 'sessions/happy-b7-fixture/attachments/late.enc' };
  };

  await f.connector.start();
  const readPromise = f.transport.rpc('native-image-read', { imageId: 'img-1' });
  await enteredUpload.promise;

  // An active image flight blocks idle retirement.
  assert.equal(await f.connector.tryCloseIfIdle(), false);
  assert.equal(f.connector.status().closed, false);

  let closeSettled = false;
  const closePromise = f.connector.close().then(() => { closeSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(closeSettled, false, 'close() must wait for in-flight image read before releasing state lock');

  releaseUpload.resolve();
  await assert.rejects(readPromise, { code: 'source-unavailable' });
  await closePromise;
  assert.equal(closeSettled, true);
  assert.equal(uploads, 1);

  // Checkpoint ownership was released after the in-flight image read settled; no ref was cached.
  const file = JSON.parse(await readFile(join(f.directory, 'connector.json'), 'utf8'));
  const saved = /** @type {Value} */ (decryptRecord(file.ciphertext, new Uint8Array(32).fill(7)));
  assert.equal(saved.nativeImages, undefined);

  const next = new NativeHappyConnector({
    transport: f.transport,
    adapter: /** @type {any} */ (f.adapter),
    nativeId: 'original-native-id',
    sourceIdentity: { app: 'codex', id: 'original-native-id', hostId: 'local' },
    bindingId: 'b7-binding',
    statePath: join(f.directory, 'connector.json'),
    encryptionKey: new Uint8Array(32).fill(7),
    getGeneration: () => 'owner-1',
    assertLease: () => true,
    receipts: f.receipts,
  });
  await next.start();
  await next.close();
});

test('R066: close() during assertLease/assertOwner inside native-image-read aborts before reading or uploading', async t => {
  const leaseEntered = deferred();
  const leaseRelease = deferred();
  let pauseLease = false;
  const f = await connectorFixture(t, {}, {
    assertLease: () => {
      if (!pauseLease) return true;
      leaseEntered.resolve();
      return leaseRelease.promise.then(() => true);
    },
  });
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#abcdef' } }).png().toBuffer();
  const imagePath = join(f.directory, 'gated.png');
  await writeFile(imagePath, png);
  f.adapter.view.rows = [{ id: 'img-row', role: 'tool', text: '', turnId: 'turn-1', tools: [{ id: 'img-gate', name: 'view_image', imagePath, output: '', status: 'completed' }] }];

  let uploads = 0;
  f.transport.uploadAttachment = async () => { uploads++; return { ref: 'never' }; };
  await f.connector.start();

  pauseLease = true;
  const readPromise = f.transport.rpc('native-image-read', { imageId: 'img-gate' });
  await leaseEntered.promise;
  const closing = f.connector.close();
  pauseLease = false;
  leaseRelease.resolve();

  await assert.rejects(readPromise, { code: 'source-unavailable' });
  await closing;
  assert.equal(uploads, 0);
});

test('R066: closing/retiring during async RPC epoch or snapshot guard cancels before journal admission or native dispatch', async t => {
  // Case A: pause in getGeneration during #rpc preparation before command journal admission.
  const genEntered = deferred();
  const genRelease = deferred();
  let pauseGen = false;
  const fA = await connectorFixture(t, {}, {
    getGeneration: () => {
      if (!pauseGen) return 'owner-1';
      genEntered.resolve();
      return genRelease.promise.then(() => 'owner-1');
    },
  });
  await fA.connector.start();
  pauseGen = true;
  const pendingRpc = fA.transport.rpc('open-desktop', { commandId: 'rpc-aborted-in-epoch' });
  await genEntered.promise;
  const closingA = fA.connector.close();
  pauseGen = false;
  genRelease.resolve();
  await assert.rejects(pendingRpc, { code: 'source-unavailable' });
  await closingA;
  assert.equal(fA.calls.length, 0);
  const fileA = JSON.parse(await readFile(join(fA.directory, 'connector.json'), 'utf8'));
  const savedA = /** @type {Value} */ (decryptRecord(fileA.ciphertext, new Uint8Array(32).fill(7)));
  assert.equal(savedA.commands.length, 0);

  // Case B: pause in adapter.snapshot inside #guard after plan admission, then close before dispatch.
  const snapEntered = deferred();
  const snapRelease = deferred();
  let pauseSnap = false;
  const fB = await connectorFixture(t, { status: 'active', currentTurnId: 'turn-live' });
  const origSnapshot = fB.adapter.snapshot;
  fB.adapter.snapshot = async () => {
    if (!pauseSnap) return origSnapshot();
    snapEntered.resolve();
    await snapRelease.promise;
    return origSnapshot();
  };
  await fB.connector.start();
  pauseSnap = true;
  const abortRpc = fB.transport.rpc('abort', { commandId: 'rpc-aborted-in-guard', turnId: 'turn-live' });
  await snapEntered.promise;
  const closingB = fB.connector.close();
  pauseSnap = false;
  snapRelease.resolve();
  await assert.rejects(abortRpc, { code: 'source-unavailable' });
  await closingB;
  assert.equal(fB.calls.length, 0);
});
