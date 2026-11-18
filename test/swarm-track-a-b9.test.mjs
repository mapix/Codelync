import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { DeviceRegistry } from '../src/codelync/device-registry.mjs';
import { DeviceProofVerifier } from '../src/network/device-proof.mjs';
import { CommandReceipts } from '../src/commands.mjs';
import { CodelyncMachineConnection } from '../src/codelync/machine-presence.mjs';
import { encryptRecord } from '../src/codelync/session-transport.mjs';
import { BridgeError } from '../src/errors.mjs';

/** @typedef {Record<string,any>} Value */

function deferred() {
  /** @type {(value?:unknown)=>void} */ let resolve = () => {};
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

test('R081: DeviceRegistry.load skips invalid rows and authorize() surfaces background save() failures cleanly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-b9-r081-reg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const validFile = join(dir, 'devices.json');
  const invalidSeed = {
    version: 1,
    devices: [null, 42, ['bad'], { noId: true }, { id: 'valid-dev', name: 'Phone', revoked: false, createdAt: 1, lastSeen: 1 }],
  };
  await writeFile(validFile, JSON.stringify(invalidSeed), { mode: 0o600 });
  const loaded = await DeviceRegistry.load(validFile);
  assert.deepEqual(loaded.list().map(d => d.id), ['valid-dev']);

  // Create a deterministic ENOTDIR save target by putting a regular file at parent path.
  const blocker = join(dir, 'not-a-dir');
  await writeFile(blocker, 'blocking');
  const token = 'synthetic-b9-device-token';
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const devices = new DeviceRegistry(join(blocker, 'devices.json'), [
    { id: 'dev-1', publicKey: 'fixture', name: 'Phone', revoked: false, createdAt: 1, lastSeen: 1, tokenHash },
  ]);

  /** @type {Value[]} */ const diagnostics = [];
  devices.on('diagnostic', (/** @type {Value} */ event) => diagnostics.push(event));

  // Synchronous authorization still succeeds cleanly while background lastSeen persistence fails & surfaces diagnostics.
  assert.equal(devices.authorize(token), 'dev-1');
  await assert.rejects(devices.tail);
  assert.ok(devices.lastSaveError);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'device-registry-save-failed');
  assert.ok(['EEXIST', 'ENOTDIR'].includes(diagnostics[0].reason));
  assert.equal(JSON.stringify(diagnostics[0]).includes(dir), false);

  // Subsequent successful save clears lastSaveError cleanly.
  devices.path = join(dir, 'recovered-devices.json');
  await devices.save();
  assert.equal(devices.lastSaveError, null);
});

test('R081: DeviceProofVerifier performs O(1) FIFO head eviction, blocks replay before touching DeviceRegistry, and fails closed at 10k active nonces', () => {
  const mac = nacl.box.keyPair();
  const phone = nacl.box.keyPair();
  const publicKey = Buffer.from(phone.publicKey).toString('base64url');
  const expectedId = createHash('sha256').update(publicKey).digest('hex').slice(0, 24);
  const origin = 'http://192.168.1.2:8800';
  const token = 'synthetic-b9-proof-token';
  let now = 1_000_000;
  let authorizeCalls = 0;

  const verifier = new DeviceProofVerifier({
    key: mac.secretKey,
    devices: {
      authorize: (value) => {
        authorizeCalls++;
        return value === token ? expectedId : null;
      },
    },
    origins: () => [origin],
    now: () => now,
  });

  /** @param {number} seq @param {number} [at] */
  const makeHeader = (seq, at = now) => {
    const nonce = Buffer.alloc(24);
    nonce.writeUInt32BE(seq, 0);
    const payload = { version: 2, token, origin, method: 'GET', path: '/v1/updates', at };
    const ciphertext = Buffer.from(nacl.box(Buffer.from(JSON.stringify(payload)), nonce, mac.publicKey, phone.secretKey)).toString('base64url');
    return 'Codelync ' + Buffer.from(JSON.stringify({ publicKey, nonce: nonce.toString('base64url'), ciphertext })).toString('base64url');
  };

  // Replayed proof is rejected before calling devices.authorize().
  const firstHeader = makeHeader(1);
  assert.equal(verifier.authorize(firstHeader, 'GET', '/v1/updates')?.id, expectedId);
  assert.equal(authorizeCalls, 1);
  assert.equal(verifier.authorize(firstHeader, 'GET', '/v1/updates'), null);
  assert.equal(authorizeCalls, 1);

  // Fill remaining 9,999 slots at t=1_000_000 using direct valid nonces (already tested seal path above).
  for (let i = 2; i <= 10_000; i++) verifier.seen.set(`${publicKey}:seed-${i}`, now + 60_000);
  assert.equal(verifier.seen.size, 10_000);

  // At capacity with all 10,000 nonces unexpired, new proof is rejected fail-closed (no unexpired replay-eviction bypass) and does not hit devices.authorize.
  const overflowHeader = makeHeader(10_001);
  assert.equal(verifier.authorize(overflowHeader, 'GET', '/v1/updates'), null);
  assert.equal(authorizeCalls, 1);
  // First nonce still cannot be replayed.
  assert.equal(verifier.authorize(firstHeader, 'GET', '/v1/updates'), null);

  // Verify O(1) early-stop scanning on repeated authorize calls when map has 9,999 live entries + 1 older entry.
  verifier.seen.delete(`${publicKey}:seed-2`);
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) {
    verifier.seen.delete(`${publicKey}:probe`);
    const probeNonce = Buffer.alloc(24);
    probeNonce.writeUInt32BE(20_000 + i, 0);
    const probeKey = `${publicKey}:${probeNonce.toString('base64url')}`;
    const h = makeHeader(20_000 + i);
    assert.equal(verifier.authorize(h, 'GET', '/v1/updates')?.id, expectedId);
    verifier.seen.delete(probeKey);
  }
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 1000, `expected O(1) FIFO head check to stay fast across 200 calls with 9,999 entries, got ${elapsedMs}ms`);

  // Advance clock past TTL: expired entries flush in FIFO order and capacity recovers.
  now = 1_060_001;
  assert.equal(verifier.authorize(makeHeader(30_001), 'GET', '/v1/updates')?.id, expectedId);
  assert.equal(verifier.seen.size, 1);
});

test('R086: CommandReceipts.run hashes canonical JSON payloads deterministically and guards edge cases', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codelync-b9-r086-cmd-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storePath = join(dir, 'receipts.json');
  const receipts = await CommandReceipts.load(storePath);

  let executions = 0;
  const shared = { nestedB: 2, nestedA: 1 };
  const payloadA = {
    b: 2,
    a: { y: 'yes', x: undefined, z: 3 },
    list: [{ d: 4, c: 3 }, undefined],
    ref1: shared,
    ref2: shared,
  };
  const payloadB = {
    ref2: { nestedA: 1, nestedB: 2 },
    list: [{ c: 3, d: 4 }, null],
    a: { z: 3, y: 'yes' },
    b: 2,
    ref1: { nestedA: 1, nestedB: 2 },
  };

  const first = await receipts.run('scope-1', 'cmd-canonical-01', payloadA, async () => {
    executions++;
    return { done: true };
  });
  const second = await receipts.run('scope-1', 'cmd-canonical-01', payloadB, async () => {
    executions++;
    return { done: false };
  });
  assert.equal(executions, 1);
  assert.deepEqual(first, second);

  // Persisted reload preserves canonical digest match across restarts.
  const reloaded = await CommandReceipts.load(storePath);
  const third = await reloaded.run('scope-1', 'cmd-canonical-01', payloadB, async () => {
    executions++;
    return { done: false };
  });
  assert.equal(executions, 1);
  assert.equal(third.status, 'complete');

  // Modified value rejects with 409 command-conflict.
  await assert.rejects(
    reloaded.run('scope-1', 'cmd-canonical-01', { ...payloadB, b: 99 }, async () => ({})),
    (/** @type {unknown} */ e) => e instanceof BridgeError && e.code === 'command-conflict' && e.status === 409,
  );

  // Top-level undefined hashes safely and remains distinct from null.
  const undefReceipt = await reloaded.run('scope-1', 'cmd-undefined-01', undefined, async () => ({ ok: true }));
  assert.equal(undefReceipt.status, 'complete');
  await assert.rejects(
    reloaded.run('scope-1', 'cmd-undefined-01', null, async () => ({ ok: true })),
    (/** @type {unknown} */ e) => e instanceof BridgeError && e.code === 'command-conflict',
  );

  // Circular objects reject with typed BridgeError rather than uncaught TypeError.
  /** @type {Value} */ const circular = {};
  circular.self = circular;
  await assert.rejects(
    reloaded.run('scope-1', 'cmd-circular-01', circular, async () => ({})),
    (/** @type {unknown} */ e) => e instanceof BridgeError && e.code === 'invalid-command-payload',
  );
});

test('R086: CodelyncMachineConnection.updateMetadata enforces closed guards before, during, and after emitWithAck', async () => {
  const key = new Uint8Array(32).fill(5);
  /** @type {Value} */ const ackGate = deferred();
  /** @type {Value[]} */ const ackCalls = [];
  /** @type {string[]} */ const emitted = [];

  const fakeSocket = Object.assign(new EventEmitter(), {
    connected: true,
    volatile: { emit() {} },
    emit(/** @type {string} */ event, /** @type {unknown} */ _data) { emitted.push(event); return true; },
    disconnect() { this.connected = false; return this; },
    timeout() {
      return {
        emitWithAck: async (/** @type {string} */ event, /** @type {Value} */ body) => {
          ackCalls.push({ event, body });
          return ackGate.promise;
        },
      };
    },
  });

  const conn = /** @type {CodelyncMachineConnection} */ (Object.create(CodelyncMachineConnection.prototype));
  conn.options = { serverUrl: 'http://127.0.0.1:9', token: 'b9-tok', machineId: 'b9-machine', accountSecret: key, metadata: { host: 'local-mac', extra: 'keep' } };
  conn.closed = false;
  conn.timeoutMs = 5000;
  conn.metadataVersion = 1;
  conn.handlers = new Map();
  conn.timer = setInterval(() => {}, 60000);
  conn.socket = /** @type {any} */ (fakeSocket);

  // 1. In-flight close cancels post-ACK mutation & further retry attempts.
  const inflight = conn.updateMetadata();
  assert.equal(ackCalls.length, 1);
  conn.close();
  ackGate.resolve({
    result: 'version-mismatch',
    version: 2,
    metadata: encryptRecord({ host: 'stale', remoteOnly: 1 }, key, 'legacy'),
  });
  await inflight;
  assert.equal(ackCalls.length, 1);
  assert.equal(conn.metadataVersion, 1);
  assert.deepEqual(conn.options.metadata, { host: 'local-mac', extra: 'keep' });

  // 2. Subsequent updateMetadata() after close() is a strict no-op even if fake socket stays connected.
  fakeSocket.connected = true;
  await conn.updateMetadata();
  assert.equal(ackCalls.length, 1);

  // 3. Normal version-mismatch merge & success flow on an open connection + malformed reply error guard.
  conn.closed = false;
  let step = 0;
  fakeSocket.timeout = () => ({
    emitWithAck: async (/** @type {string} */ event, /** @type {Value} */ body) => {
      ackCalls.push({ event, body });
      step++;
      if (step === 1) return { result: 'version-mismatch', version: 4, metadata: encryptRecord({ remoteOnly: true, host: 'old' }, key, 'legacy') };
      if (step === 2) return { result: 'success', version: 5 };
      return null;
    },
  });
  await conn.updateMetadata();
  assert.equal(conn.metadataVersion, 5);
  assert.deepEqual(conn.options.metadata, { remoteOnly: true, host: 'local-mac', extra: 'keep' });
  await assert.rejects(conn.updateMetadata(), /Machine metadata could not be updated/);
  conn.close();
});
