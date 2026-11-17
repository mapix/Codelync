import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { APNsConfiguration } from '../src/codelync/apns-configuration.mjs';
import { DeviceRegistry } from '../src/codelync/device-registry.mjs';

test('imports an independent private publisher key and rejects invalid replacement without altering configuration', async t => {
  const state = await mkdtemp(join(tmpdir(), 'codelync-apns-config-')); t.after(() => rm(state, { recursive: true, force: true }));
  const devices = await DeviceRegistry.load(join(state, 'devices.json'));
  const keyPath = join(state, 'input.p8'), key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(keyPath, key);
  const changed = [], statuses = /** @type {Record<string,any>[]} */ ([]);
  const settings = new APNsConfiguration({ state, devices, peerId: () => 'peer', origin: () => '', changed: async sender => { changed.push(sender); }, notify: value => statuses.push(value) });
  await settings.configure({ keyPath, keyId: 'AAAAAAAAAA', teamId: 'BBBBBBBBBB', environment: 'development' });
  const saved = JSON.parse(await readFile(join(state, 'apns.json'), 'utf8'));
  assert.notEqual(saved.keyPath, keyPath); assert.equal((await stat(saved.keyPath)).mode & 0o777, 0o600);
  await rm(keyPath); assert.equal(await readFile(saved.keyPath, 'utf8'), key);
  assert.equal(settings.status().available, true); assert.equal(settings.status().lastTestAccepted, false);
  assert.ok(!JSON.stringify(statuses).includes('PRIVATE KEY')); assert.equal(changed.length, 1);
  await assert.rejects(settings.configure({ keyId: 'invalid', teamId: 'BBBBBBBBBB', environment: 'production' }));
  assert.deepEqual(JSON.parse(await readFile(join(state, 'apns.json'), 'utf8')), saved);
});

test('test alerts require registered active devices with a matching environment and report provider rejection', async t => {
  const state = await mkdtemp(join(tmpdir(), 'codelync-apns-test-')); t.after(() => rm(state, { recursive: true, force: true }));
  const devices = await DeviceRegistry.load(join(state, 'devices.json'));
  const id = await devices.approve('device', 'Phone', 'credential');
  const settings = new APNsConfiguration({ state, devices, peerId: () => 'stable-peer', origin: () => 'old-origin', changed: async () => {}, notify: () => {} });
  settings.sender = { environment: 'development', send: async () => ({ ok: true }) };
  await assert.rejects(settings.test(id), /not-registered/);
  await devices.registerPush(id, { enabled: true, token: 'a'.repeat(64), environment: 'production' });
  await assert.rejects(settings.test(id), /environment-mismatch/);
  await devices.registerPush(id, { enabled: true, token: 'a'.repeat(64), environment: 'development' });
  settings.sender.send = async (/** @type {string} */ _token, /** @type {Record<string,any>} */ event) => { assert.equal(event.peerId, 'stable-peer'); assert.equal(event.kind, 'test'); return { ok: true }; };
  await settings.test(id); assert.equal(settings.status().lastTestAccepted, true);
  settings.sender.send = async () => ({ ok: false, invalidToken: true, reason: 'BadDeviceToken' });
  await assert.rejects(settings.test(id), /BadDeviceToken/); assert.equal(devices.notificationDevices().length, 0);
  assert.equal(devices.authorize('credential'), id); assert.equal(settings.status().lastTestAccepted, false);
  await devices.revoke(id); await assert.rejects(settings.test(id), /not-registered/);
});
