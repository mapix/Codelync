import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apnsDeliveryOrigin } from '../src/codelync/apns-sender.mjs';
import { DeviceRegistry } from '../src/codelync/device-registry.mjs';
import { NotificationDispatcher } from '../src/codelync/notification-dispatcher.mjs';

test('approved development and beta tokens route to their own Apple environments without replacing the saved sender setting', async t => {
  assert.equal(apnsDeliveryOrigin('development'), 'https://api.sandbox.push.apple.com');
  assert.equal(apnsDeliveryOrigin('production'), 'https://api.push.apple.com');
  assert.throws(() => apnsDeliveryOrigin('invalid'), /invalid-apns-environment/);
  const directory = await mkdtemp(join(tmpdir(), 'codelync-push-environments-'));
  const devices = await DeviceRegistry.load(join(directory, 'devices.json'));
  const dev = await devices.approve('development-device', 'Development', 'dev-credential');
  const beta = await devices.approve('beta-device', 'Beta', 'beta-credential');
  await devices.registerPush(dev, { enabled: true, token: 'a'.repeat(64), environment: 'development' });
  await devices.registerPush(beta, { enabled: true, token: 'b'.repeat(64), environment: 'production' });
  const sent = /** @type {{token:string,environment:string}[]} */ ([]);
  const sender = { environment: 'development', multiEnvironment: true,
    send: async (/** @type {string} */ token, /** @type {unknown} */ _event, /** @type {string} */ environment) => {
      sent.push({ token, environment }); return { ok: true };
    } };
  const dispatcher = new NotificationDispatcher({ path: join(directory, 'notifications.json'), devices, sender, origin: () => '' });
  t.after(async () => { await dispatcher.close(); await rm(directory, { recursive: true, force: true }); });
  await dispatcher.start();
  await dispatcher.observe('source', 'session', { epoch: 'owner', currentTurnId: 'turn', turns: {}, requests: [] });
  await dispatcher.observe('source', 'session', { epoch: 'owner', currentTurnId: null, turns: { turn: 'completed' }, requests: [] });
  assert.deepEqual(sent, [{ token: 'a'.repeat(64), environment: 'development' }, { token: 'b'.repeat(64), environment: 'production' }]);
  assert.equal(sender.environment, 'development');
});
