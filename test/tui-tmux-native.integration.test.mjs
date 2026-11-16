import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TuiTmuxBackend } from '../src/tui/tmux-backend.mjs';
import { TmuxControlClient } from '../src/tui/tmux-control.mjs';

/** @typedef {Record<string,any>} Value */
const execute = promisify(execFile), binaryPath = process.env.CODELIGHT_TMUX_TEST_BINARY;
const env = { PATH: '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'en_US.UTF-8' };
/** @param {string} value */
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

/** @param {any} t @param {Value} [options] */
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-native-tui-')), socketPath = join(directory, 'tmux.sock'), file = join(directory, 'fixture.txt');
  await writeFile(file, 'BEGIN\nSECOND\n', { mode: 0o600 });
  const run = async (/** @type {string[]} */ args) => (await execute(/** @type {string} */ (binaryPath), ['-S', socketPath, ...args], { env, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout;
  await run(['-f', '/dev/null', 'new-session', '-d', '-s', 'codelight-native-proof', '-x', '80', '-y', '24', `/usr/bin/vim -Nu NONE -n ${shellQuote(file)}`]);
  const backend = new TuiTmuxBackend({ binaryPath: /** @type {string} */ (binaryPath), socketPath, stateDirectory: join(directory, 'receipts'), ...options });
  t.after(async () => { await backend.dispose(); await run(['kill-server']).catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const pane = (await backend.list())[0]; assert.ok(pane); return { directory, socketPath, file, run, backend, pane };
}

/** @template T @param {()=>Promise<T>|T} read @param {(value:T)=>boolean} check @returns {Promise<T>} */
async function until(read, check) {
  const deadline = Date.now() + 5000; let value;
  do { value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
  assert.fail('The native TUI did not produce the required observed state.');
}

test('actual original vim pane supports Unicode, controls, resize, live deltas and same-owner reconnect without duplicate input', { skip: !binaryPath }, async t => {
  const f = await fixture(t), owner = f.pane.runtimeGeneration;
  /** @type {Value[]} */ const events = [];
  const initial = await until(() => f.backend.snapshot(f.pane.id, { expectedOwnerGeneration: owner }), view => view.screen.includes('BEGIN'));
  assert.equal(initial.alternate, true); assert.equal(initial.columns, 80); assert.equal(initial.rows, 24);
  const stop = await f.backend.subscribe(f.pane.id, event => { events.push(event); }, { expectedOwnerGeneration: owner });
  const intended = { text: 'i你好🌍\x1b' };
  const sending = f.backend.command(f.pane.id, 'input', intended, 'native-tui-unicode-0001', owner);
  intended.text = 'iALTERED\x1b';
  const input = await sending;
  assert.equal(input.status, 'completed'); assert.equal(input.acceptedBy, 'tmux-server'); assert.equal(input.applicationAccepted, null);
  const duplicate = await f.backend.command(f.pane.id, 'input', { text: 'i你好🌍\x1b' }, 'native-tui-unicode-0001', owner);
  assert.equal(duplicate.nativeCommandNumber, input.nativeCommandNumber);
  const edited = await until(() => f.backend.snapshot(f.pane.id, { expectedOwnerGeneration: owner }), view => view.screen.includes('你好🌍'));
  assert.ok(!edited.screen.includes('ALTERED'));
  assert.equal(edited.screen.split('你好🌍').length - 1, 1);
  await until(() => events, values => values.some(event => event.type === 'terminal-output'));
  const output = events.filter(event => event.type === 'terminal-output').map(event => Buffer.from(event.data, 'base64')).reduce((all, bytes) => Buffer.concat([all, bytes]), Buffer.alloc(0));
  assert.ok(output.length > 0); assert.ok(events.every(event => event.ownerGeneration === owner));
  const before = edited.cursor.x;
  await f.backend.command(f.pane.id, 'key', { key: 'left' }, 'native-tui-left-0001', owner);
  const moved = await until(() => f.backend.snapshot(f.pane.id), view => view.cursor.x < before); assert.ok(moved.cursor.x >= 0);
  const resize = await f.backend.command(f.pane.id, 'resize', { columns: 100, rows: 30 }, 'native-tui-resize-0001', owner);
  assert.equal(resize.status, 'completed'); assert.equal(resize.applied, true); assert.equal(resize.columns, 100); assert.equal(resize.rows, 30);
  const previousStream = (await f.backend.snapshot(f.pane.id)).streamId;
  const observer = f.backend.observers.get(f.pane.id); assert.ok(observer); observer.client.child.kill('SIGKILL');
  const resumed = await until(() => events, values => values.findLast(event => event.type === 'terminal-screen')?.streamId !== previousStream);
  assert.ok(resumed.some(event => event.type === 'connection' && event.connected === false));
  const latest = resumed.findLast(event => event.type === 'terminal-screen'); assert.ok(latest); assert.equal(latest.ownerGeneration, owner); assert.ok(latest.screen.includes('你好🌍'));
  const panesAfterReconnect = await f.backend.list(); assert.equal(panesAfterReconnect[0].nativePane.pid, f.pane.nativePane.pid);
  assert.equal(panesAfterReconnect[0].nativePane.serverPid, f.pane.nativePane.serverPid);
  stop(); await f.backend.dispose(); assert.ok((await f.run(['list-panes', '-a', '-F', '#{pane_pid}'])).includes(String(f.pane.nativePane.pid)));
});

test('actual native write with a dropped trailing receipt stays unknown; re-entry/repeat never inserts it again', { skip: !binaryPath }, async t => {
  const fault = { dropNextMarker: false, dropped: false };
  class LostReceiptClient extends TmuxControlClient {
    /** @param {string} command @param {Value} [options] */
    run(command, options = {}) { if (command.startsWith('if-shell') && !fault.dropped) fault.dropNextMarker = true; return super.run(command, options); }
  }
  /** @param {string} file @param {string[]} args @param {Value} options */
  function faultSpawn(file, args, options) {
    const child = spawn(file, args, options), original = child.stdout; let pending = '';
    const filtered = new Transform({ transform(chunk, _encoding, callback) {
      pending += chunk.toString('utf8'); let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (fault.dropNextMarker && line.startsWith('CODELIGHT_TMUX_DONE_')) { fault.dropNextMarker = false; fault.dropped = true; continue; }
        this.push(`${line}\n`);
      }
      callback();
    } });
    original.pipe(filtered); Object.assign(child, { stdout: filtered }); return child;
  }
  const f = await fixture(t, { timeoutMs: 600, clientFactory: (/** @type {Value} */ options) => new LostReceiptClient({ binaryPath: options.binaryPath,
    socketPath: options.socketPath, sessionId: options.sessionId, timeoutMs: options.timeoutMs, spawn: /** @type {any} */ (faultSpawn) }) }), owner = f.pane.runtimeGeneration;
  const initial = await until(() => f.backend.snapshot(f.pane.id), view => view.screen.includes('BEGIN'));
  const operation = { text: 'iACKLOSS\x1b' }, commandId = 'native-tui-ackloss-0001';
  const receipt = await f.backend.command(f.pane.id, 'input', operation, commandId, owner);
  assert.equal(fault.dropped, true); assert.equal(receipt.status, 'unknown'); assert.equal(receipt.effectMayHaveOccurred, true);
  const before = await until(() => f.backend.snapshot(f.pane.id), view => view.screen.includes('ACKLOSS'));
  assert.notEqual(before.streamId, initial.streamId);
  const same = await f.backend.command(f.pane.id, 'input', operation, commandId, owner); assert.equal(same.status, 'unknown');
  assert.equal((await f.backend.getReceipt(commandId)).status, 'unknown');
  const after = await f.backend.snapshot(f.pane.id); assert.equal(after.screen.split('ACKLOSS').length - 1, 1); assert.equal(after.screen, before.screen);
  await assert.rejects(f.backend.command(f.pane.id, 'input', { text: 'different' }, commandId, owner), { code: 'tui-command-id-conflict' });
  await assert.rejects(f.backend.command(f.pane.id, 'key', { key: '__proto__' }, 'native-tui-badkey-0001', owner), { code: 'tui-invalid-key' });
  await assert.rejects(f.backend.command(f.pane.id, 'input', { text: 'never' }, 'native-tui-oldowner-0001', `${owner}-stale`), { code: 'tui-owner-changed' });
});

test('native owner guard rejects a pane respawn between local preflight and terminal write', { skip: !binaryPath }, async t => {
  /** @type {Value} */ let f; let replace = true;
  class ReplacedPaneClient extends TmuxControlClient {
    /** @param {string} command @param {Value} [options] */
    async run(command, options = {}) {
      if (command.startsWith('if-shell') && replace) {
        replace = false;
        await writeFile(f.file, 'NEWOWNER\n', { mode: 0o600 });
        await f.run(['respawn-pane', '-k', '-t', f.pane.id, `/usr/bin/vim -Nu NONE -n ${shellQuote(f.file)}`]);
      }
      return super.run(command, options);
    }
  }
  f = await fixture(t, { clientFactory: (/** @type {Value} */ options) => new ReplacedPaneClient({ binaryPath: options.binaryPath, socketPath: options.socketPath, sessionId: options.sessionId }) });
  const owner = f.pane.runtimeGeneration;
  await until(() => f.backend.snapshot(f.pane.id), view => view.screen.includes('BEGIN'));
  const result = await f.backend.command(f.pane.id, 'input', { text: 'iNEVER\x1b' }, 'native-tui-owner-race-0001', owner);
  assert.equal(result.status, 'rejected'); assert.equal(result.effectMayHaveOccurred, false); assert.equal(result.acceptedBy, null);
  const current = (await f.backend.list())[0]; assert.notEqual(current.runtimeGeneration, owner); assert.notEqual(current.nativePane.pid, f.pane.nativePane.pid);
  const snapshot = await until(() => f.backend.snapshot(f.pane.id), view => view.screen.includes('NEWOWNER')); assert.ok(!snapshot.screen.includes('NEVER'));
});

test('native resize layout guard refuses a split created after local preflight', { skip: !binaryPath }, async t => {
  /** @type {Value} */ let f; let split = true;
  class ChangedLayoutClient extends TmuxControlClient {
    /** @param {string} command @param {Value} [options] */
    async run(command, options = {}) {
      if (command.startsWith('if-shell') && split) { split = false; await f.run(['split-window', '-d', '-h', '-t', f.pane.id, '/bin/cat']); }
      return super.run(command, options);
    }
  }
  f = await fixture(t, { clientFactory: (/** @type {Value} */ options) => new ChangedLayoutClient({ binaryPath: options.binaryPath, socketPath: options.socketPath, sessionId: options.sessionId }) });
  const owner = f.pane.runtimeGeneration;
  const result = await f.backend.command(f.pane.id, 'resize', { columns: 120, rows: 40 }, 'native-tui-layout-race-0001', owner);
  assert.equal(result.status, 'rejected'); assert.equal(result.effectMayHaveOccurred, false);
  assert.equal((await f.run(['display-message', '-p', '-t', f.pane.id, '#{window_width},#{window_height}'])).trim(), '80,24');
  await assert.rejects(f.backend.command(f.pane.id, 'resize', { columns: 120, rows: 40 }, 'native-tui-split-resize-0001', owner), { code: 'tui-split-resize-unsupported' });
});
