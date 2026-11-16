import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopSourceSubscriptions, DESKTOP_SOURCE_APPS } from '../src/happy/source-subscriptions.mjs';

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-source-choices-')), path = join(directory, 'sources.json');
  t.after(() => rm(directory, { recursive: true, force: true })); return { path, settings: new DesktopSourceSubscriptions({ path }) };
}

test('a missing choice defaults to all three without writing; explicit empty survives restart', async t => {
  const f = await fixture(t);
  assert.equal(f.settings.isEnabled('codex'), false);
  assert.deepEqual((await f.settings.reload()).enabledApps, DESKTOP_SOURCE_APPS);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  await f.settings.setEnabledApps([]);
  const next = new DesktopSourceSubscriptions({ path: f.path });
  const snapshot = await next.reload(); assert.equal(snapshot.known, true); assert.deepEqual(snapshot.enabledApps, []);
  assert.equal(next.isEnabled('codex'), false); assert.equal(next.isEnabled('antigravity'), false);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
});

test('subset choice persists in stable order and does not allow an external caller to change the gate', async t => {
  const f = await fixture(t); await f.settings.reload();
  const snapshot = await f.settings.setEnabledApps(['claude-desktop', 'codex']);
  assert.deepEqual(snapshot.enabledApps, ['codex', 'claude-desktop']);
  assert.equal(Reflect.set(snapshot.enabledApps, '0', 'antigravity'), false);
  assert.equal(f.settings.isEnabled('antigravity'), false);
  const restored = new DesktopSourceSubscriptions({ path: f.path });
  assert.deepEqual((await restored.reload()).enabledApps, ['codex', 'claude-desktop']);
});

test('invalid or unreadable choices fail closed, retain the original bytes and recover only after a valid read', async t => {
  const f = await fixture(t); await f.settings.reload();
  for (const original of ['{invalid', JSON.stringify({ version: 1, enabledApps: ['codex', 'codex'] }),
    JSON.stringify({ version: 1, enabledApps: ['unknown'] }), JSON.stringify({ version: 1, enabledApps: [], extra: true }),
    JSON.stringify({ version: 2, enabledApps: DESKTOP_SOURCE_APPS })]) {
    await writeFile(f.path, original);
    const result = await f.settings.reload(); assert.equal(result.known, false); assert.deepEqual(result.enabledApps, []);
    assert.equal(f.settings.isEnabled('codex'), false); assert.equal(await readFile(f.path, 'utf8'), original);
  }
  await writeFile(f.path, JSON.stringify({ version: 1, enabledApps: ['antigravity'] }));
  const recovered = await f.settings.reload(); assert.equal(recovered.known, true); assert.deepEqual(recovered.enabledApps, ['antigravity']);
});

test('a failed durable save does not change the previous effective gate or revision and a later retry works', async () => {
  let failing = true, writes = 0;
  const settings = new DesktopSourceSubscriptions({ path: '/fixture/source-choices.json', read: async () => null,
    write: async () => { writes++; if (failing) throw Error('synthetic write failure'); } });
  const before = await settings.reload();
  await assert.rejects(settings.setEnabledApps([]), { code: 'source-subscriptions-save-failed' });
  assert.deepEqual(settings.snapshot(), before); assert.equal(settings.isEnabled('codex'), true);
  failing = false; const after = await settings.setEnabledApps([]);
  assert.equal(after.known, true); assert.deepEqual(after.enabledApps, []); assert.ok(after.revision > before.revision); assert.equal(writes, 2);
});

test('a held reload finishes before a queued user choice, so a late older read cannot overwrite the choice', async () => {
  /** @type {(value:unknown)=>void} */ let finishRead = () => {};
  const waiting = new Promise(resolve => { finishRead = resolve; });
  /** @type {unknown[]} */ const writes = [];
  const settings = new DesktopSourceSubscriptions({ path: '/fixture/source-choices.json', read: () => waiting,
    write: async (_path, value) => { writes.push(value); } });
  const reload = settings.reload(), selected = settings.setEnabledApps(['codex']);
  await Promise.resolve(); assert.equal(writes.length, 0);
  finishRead({ version: 1, enabledApps: ['antigravity'] });
  await reload; await selected; assert.deepEqual(settings.snapshot().enabledApps, ['codex']); assert.equal(writes.length, 1);
});

test('concurrent selections fence only after each save and the newest persisted choice wins', async () => {
  let finishFirst = () => {}, calls = 0;
  const held = new Promise(resolve => { finishFirst = () => resolve(undefined); });
  const settings = new DesktopSourceSubscriptions({ path: '/fixture/source-choices.json', read: async () => null,
    write: async () => { if (++calls === 1) await held; } });
  await settings.reload();
  const first = settings.setEnabledApps(['codex']), second = settings.setEnabledApps([]);
  await Promise.resolve(); assert.equal(calls, 1); assert.equal(settings.isEnabled('antigravity'), true);
  finishFirst(); await first; await second;
  assert.equal(calls, 2); assert.deepEqual(settings.snapshot().enabledApps, []);
});


test('an unchanged app retains its lease revision when another source is toggled', async () => {
  const settings = new DesktopSourceSubscriptions({ path: '/fixture/source-choices.json', read: async () => null, write: async () => {} });
  await settings.reload(); const codex = settings.appRevision('codex'), antigravity = settings.appRevision('antigravity');
  await settings.setEnabledApps(['codex', 'claude-desktop']);
  assert.equal(settings.appRevision('codex'), codex); assert.ok(settings.appRevision('antigravity') > antigravity);
  const disabled = settings.appRevision('antigravity'); await settings.setEnabledApps(DESKTOP_SOURCE_APPS);
  assert.ok(settings.appRevision('antigravity') > disabled);
});
