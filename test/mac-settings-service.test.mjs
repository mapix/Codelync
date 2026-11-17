import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacSettingsService } from '../src/codelync/mac-settings-service.mjs';
/** @typedef {Record<string,any>} Value */

test('paused settings persist all three kinds without creating identities or starting runtime binaries', async t => {
  const state = await mkdtemp(join(tmpdir(), 'codelync-settings-'));
  const child = spawn(process.execPath, ['src/codelync/mac-app-service.mjs', '--state=' + state, '--settings-only=1',
    '--node=/missing-settings-test-node', '--backend=/missing-settings-test-backend', '--cloudflared=/missing-settings-test-tunnel'],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exit; await rm(state, { recursive: true, force: true }); });
  let tail = ''; const frames = /** @type {Value[]} */ ([]);
  const observed = (/** @type {(frame:Value)=>boolean} */ predicate) => {
    const frame = frames.find(predicate); assert.ok(frame); return frame;
  };
  child.stdout.on('data', data => {
    tail += data.toString(); const lines = tail.split('\n'); tail = lines.pop() ?? '';
    for (const line of lines) if (line) frames.push(JSON.parse(line));
  });
  const wait = async (/** @type {()=>boolean} */ predicate) => {
    for (let i = 0; i < 500; i++) { if (predicate()) return; if (child.exitCode !== null) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.ok(predicate(), 'settings frame was not produced');
  };
  await wait(() => frames.some(frame => frame.type === 'settings-ready'));
  assert.deepEqual(observed(frame => frame.type === 'source-subscriptions').configuration.enabledApps, ['codex', 'antigravity', 'claude-desktop']);
  const commands = [
    { type: 'set-source-subscriptions', requestId: 'settings-source-1', apps: ['codex'] },
    { type: 'set-enabled-channels', requestId: 'settings-channel-1', channels: [] },
    { type: 'configure-desktop', requestId: 'settings-desktop-1', configuration: { enabled: true, mode: 'external',
      url: 'wss://media.example.com', apiKey: 'fixture-key', apiSecret: 'x'.repeat(64) } },
    { type: 'desktop-permission', requestId: 'settings-permission-1', permission: 'screen' },
  ];
  for (const command of commands) child.stdin.write(JSON.stringify(command) + '\n');
  await wait(() => commands.every(command => frames.some(frame => frame.requestId === command.requestId)));
  for (const command of commands.slice(0, 3)) assert.equal(observed(frame => frame.requestId === command.requestId).ok, true);
  assert.equal(observed(frame => frame.requestId === commands[3].requestId).code, 'settings-only-operation-unavailable');
  assert.deepEqual(JSON.parse(await readFile(join(state, 'source-subscriptions.json'), 'utf8')).enabledApps, ['codex']);
  assert.deepEqual(JSON.parse(await readFile(join(state, 'connection-channels.json'), 'utf8')).enabledChannels, []);
  const media = JSON.parse(await readFile(join(state, 'desktop/remote-desktop.json'), 'utf8'));
  assert.equal(media.enabled, true); assert.equal(media.apiSecret, 'x'.repeat(64));
  const names = await readdir(state);
  for (const forbidden of ['relay', 'connector', 'network-identity.json', 'mac-box-key.json', 'relay-key.json', 'devices.json']) assert.ok(!names.includes(forbidden));
  assert.equal(observed(frame => frame.type === 'desktop-status').status.connected, false);
  child.stdin.end(); child.kill('SIGTERM'); assert.equal((await exit)[0], 0);
  assert.ok(!(await readdir(state)).includes('service.source.lock'));
});

test('inactive Relay validation cancels on close and cannot leave a saved replacement', async t => {
  const state = await mkdtemp(join(tmpdir(), 'codelync-settings-relay-'));
  const frames = /** @type {Value[]} */ ([]); let validating = /** @type {AbortSignal|undefined} */ (undefined);
  const service = new MacSettingsService({ state, notify: frame => frames.push(frame), validateRelay: async (_url, signal) => {
    if (!signal) throw Error('validation signal missing');
    validating = signal; await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })); return _url;
  } });
  t.after(async () => { await service.close(); await rm(state, { recursive: true, force: true }); });
  await service.start();
  service.handle({ type: 'configure-relay', requestId: 'settings-relay-1', serverUrl: 'https://relay.example.com', token: 'a'.repeat(43) });
  for (let i = 0; i < 100 && !validating; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(validating); await service.close(); assert.equal(validating.aborted, true);
  const saved = JSON.parse(await readFile(join(state, 'connection-channels.json'), 'utf8'));
  assert.equal(saved.relay, null); assert.equal(service.connections.seed, null);
  const result = frames.find(frame => frame.requestId === 'settings-relay-1'); assert.ok(result);
  assert.equal(result.ok, false);
});
