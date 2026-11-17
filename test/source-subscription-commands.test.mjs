import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopSourceSubscriptions } from '../src/codelync/source-subscriptions.mjs';
import { SourceSubscriptionCommands } from '../src/codelync/source-subscription-commands.mjs';
import { BridgeError } from '../src/errors.mjs';
/** @typedef {Record<string,any>} Value */

/** @param {Value} [controls] */
async function fixture(controls = {}) {
  const counts = { writes: 0, fences: 0, reconciles: 0, changed: 0 }, messages = /** @type {Value[]} */ ([]);
  const settings = new DesktopSourceSubscriptions({ path: '/fixture/source-choices.json', read: async () => null,
    write: async () => { counts.writes++; if (controls.failWrite) throw Error('Synthetic save failure'); } }); await settings.reload();
  const daemon = { fenceSourceSubscriptions: () => { counts.fences++; }, reconcileSourceSubscriptions: async () => {
    counts.reconciles++; if (controls.wait) await controls.wait; if (controls.failApply) throw new BridgeError('source-subscriptions-apply-pending', 'Fixture');
  } };
  const commands = new SourceSubscriptionCommands({ settings, daemon: () => daemon, notify: message => messages.push(message), changed: () => { counts.changed++; } });
  return { settings, counts, messages, commands, controls };
}

test('local source save failure leaves the gate unchanged and does not enter discovery/observation changes', async () => {
  const f = await fixture({ failWrite: true });
  assert.equal(f.commands.handle({ type: 'set-source-subscriptions', requestId: 'fixture-save-failed', apps: [] }), true); await f.commands.idle();
  assert.equal(f.settings.isEnabled('codex'), true); assert.equal(f.counts.fences, 0); assert.equal(f.counts.reconciles, 0);
  assert.deepEqual(f.messages.at(-1), { type: 'source-subscriptions-result', requestId: 'fixture-save-failed', ok: false, code: 'source-subscriptions-save-failed' });
  assert.equal(f.commands.handle({ type: 'set-source-subscriptions', requestId: 'fixture-invalid', apps: ['terminal'] }), true); await f.commands.idle();
  assert.equal(f.counts.writes, 1); assert.equal(f.counts.fences, 0);
});

test('a saved choice stays effective during apply failure and explicit retry repeats only reconciliation', async () => {
  const f = await fixture({ failApply: true });
  f.commands.handle({ type: 'set-source-subscriptions', requestId: 'fixture-apply-failed', apps: [] }); await f.commands.idle();
  assert.deepEqual(f.settings.snapshot().enabledApps, []); assert.equal(f.settings.isEnabled('codex'), false); assert.equal(f.counts.writes, 1);
  assert.deepEqual(f.messages.at(-1), { type: 'source-subscriptions-result', requestId: 'fixture-apply-failed', ok: false, code: 'source-subscriptions-apply-pending' });
  f.controls.failApply = false; f.commands.handle({ type: 'set-source-subscriptions', requestId: 'fixture-retry', apps: [] }); await f.commands.idle();
  assert.equal(f.counts.writes, 1); assert.equal(f.counts.reconciles, 2); assert.equal(f.messages.at(-1)?.ok, true);
});

test('local transitions stay serialized through cleanup and old results cannot overwrite a newer choice', async () => {
  let finish = () => {}; const wait = new Promise(resolve => { finish = () => resolve(undefined); });
  const f = await fixture({ wait });
  f.commands.handle({ type: 'set-source-subscriptions', requestId: 'fixture-first', apps: ['codex'] });
  f.commands.handle({ type: 'set-source-subscriptions', requestId: 'fixture-second', apps: ['antigravity'] });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(f.counts.writes, 1); assert.deepEqual(f.settings.snapshot().enabledApps, ['codex']);
  finish(); await f.commands.idle(); assert.equal(f.counts.writes, 2); assert.deepEqual(f.settings.snapshot().enabledApps, ['antigravity']);
  assert.equal(f.messages.at(-1)?.requestId, 'fixture-second'); assert.equal(f.messages.at(-1)?.ok, true);
});
