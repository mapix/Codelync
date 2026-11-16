import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopSourceSubscriptions, DESKTOP_SOURCE_APPS } from '../src/happy/source-subscriptions.mjs';
import { LocalSourceDiscovery } from '../src/happy/discovery.mjs';
/** @typedef {Record<string,any>} Value */
const ag = { app: 'antigravity', kind: 'session', id: 'fixture-ag', hostId: 'local:antigravity:' + 'a'.repeat(64), protocol: 'antigravity-connect', runtimeGeneration: 'fixture-owner' };
const claude = { app: 'claude-desktop', kind: 'session', id: 'fixture-claude', hostId: 'local:claude-desktop:' + 'b'.repeat(64), protocol: 'claude-desktop-native', runtimeGeneration: 'fixture-owner', appMode: 'code', nativeCollection: 'claude-code-sessions' };
async function fixture() {
  const settings = new DesktopSourceSubscriptions({ path: '/fixture/source-choices.json', read: async () => null, write: async () => {} }); await settings.reload();
  const calls = { codex: 0, antigravity: 0, claude: 0, disposed: 0, created: 0, windows: 0 };
  const discovery = new LocalSourceDiscovery({ sourceSubscriptions: settings, storage: { list: async () => { calls.codex++; return [{ id: 'fixture-codex' }]; } },
    codexBackendFactory: () => { calls.created++; return { dispose: () => { calls.disposed++; } }; },
    antigravityBackendFactory: () => { calls.created++; return { list: async () => { calls.antigravity++; return [ag]; }, dispose: () => { calls.disposed++; } }; },
    claudeBackendsFactory: () => { calls.created++; return [{ appMode: 'code', hostId: () => claude.hostId, list: async () => { calls.claude++; return [claude]; }, dispose: () => { calls.disposed++; } }]; },
    localWindows: async () => { calls.windows++; return []; } });
  return { settings, discovery, calls };
}

test('disabled sources have no provider construction or reads, and empty choices are known without native authority', async t => {
  const f = await fixture(); t.after(() => f.discovery.close());
  await f.settings.setEnabledApps(['codex']);
  const first = await f.discovery.discover(); assert.deepEqual(first.sources.map(source => source.app), ['codex']); assert.deepEqual(first.inventoryApps, ['codex']);
  assert.deepEqual(f.calls, { codex: 1, antigravity: 0, claude: 0, disposed: 0, created: 1, windows: 0 });
  assert.throws(() => f.discovery.adapter(ag), { code: 'source-disabled' }); assert.throws(() => f.discovery.adapter(claude), { code: 'source-disabled' });
  await f.settings.setEnabledApps([]); await f.discovery.reconcileSubscriptions();
  const none = await f.discovery.discover(); assert.deepEqual(none.sources, []); assert.deepEqual(none.inventoryApps, []); assert.deepEqual(none.enabledApps, []); assert.deepEqual(none.errors, []);
  assert.equal(f.calls.codex, 1); assert.equal(f.calls.created, 1); assert.equal(f.calls.disposed, 1);
});

test('re-enable creates new CodeLight providers instead of reviving disposed clients', async t => {
  const f = await fixture(); t.after(() => f.discovery.close());
  const first = await f.discovery.discover(); assert.deepEqual(first.inventoryApps, DESKTOP_SOURCE_APPS);
  const oldCodex = f.discovery.codex, oldAG = f.discovery.antigravity, oldClaude = f.discovery.claude[0];
  await f.settings.setEnabledApps([]); await f.discovery.reconcileSubscriptions(); assert.equal(f.calls.disposed, 3);
  await f.settings.setEnabledApps(DESKTOP_SOURCE_APPS); const resumed = await f.discovery.discover(); assert.equal(resumed.sources.length, 3);
  assert.notEqual(f.discovery.codex, oldCodex); assert.notEqual(f.discovery.antigravity, oldAG); assert.notEqual(f.discovery.claude[0], oldClaude);
  assert.equal(f.calls.created, 6); assert.equal(f.calls.windows, 0);
});

test('an index result held across disable and re-enable cannot become current authority', async t => {
  const f = await fixture(); t.after(() => f.discovery.close());
  let finish = () => {}; const held = new Promise(resolve => { finish = () => resolve([{ id: 'old-codex' }]); });
  f.discovery.storage = { list: () => held };
  const scan = f.discovery.discover(); await Promise.resolve();
  await f.settings.setEnabledApps([]); await f.settings.setEnabledApps(DESKTOP_SOURCE_APPS); finish();
  const result = await scan; assert.equal(result.stale, true); assert.deepEqual(result.sources, []); assert.deepEqual(result.inventoryApps, []);
});

test('provider cleanup failure remains pending until the owned client is actually closed', async t => {
  const f = await fixture(); t.after(() => f.discovery.close()); await f.discovery.discover();
  let attempts = 0;
  assert.ok(f.discovery.antigravity);
  f.discovery.antigravity.dispose = async () => { if (++attempts === 1) throw Error('Synthetic close failure'); };
  await f.settings.setEnabledApps([]);
  await assert.rejects(f.discovery.reconcileSubscriptions(), { code: 'source-subscriptions-apply-pending' });
  assert.equal(f.discovery.pendingProviderDisposals.size, 1); assert.throws(() => f.discovery.adapter(ag), { code: 'source-disabled' });
  await f.discovery.reconcileSubscriptions(); assert.equal(attempts, 2); assert.equal(f.discovery.pendingProviderDisposals.size, 0);
});
