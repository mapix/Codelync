import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TmuxControlParser, TmuxControlClient, decodeTmuxOutput } from '../src/tui/tmux-control.mjs';
/** @typedef {Record<string,any>} Value */

test('native control blocks and literal notification-looking screen lines survive one-byte framing', () => {
  const parser = new TmuxControlParser();
  /** @type {Value[]} */ const blocks = [];
  /** @type {Value[]} */ const events = [];
  parser.on('block', value => blocks.push(value)); parser.on('notification', value => events.push(value));
  const native = Buffer.from('%begin 10 4 1\n%output %0 literal screen text\n%begin 10 88 1\n%end 10 4 1\n%output %0 \\344\\275\\240\\345\\245\\275\\360\\237\\214\\215\\015\\012\n');
  for (const byte of native) parser.feed(Buffer.from([byte]));
  parser.finish();
  assert.deepEqual(blocks[0].lines, ['%output %0 literal screen text', '%begin 10 88 1']);
  assert.equal(events[0].paneId, '%0'); assert.equal(events[0].bytes.toString('utf8'), '你好🌍\r\n');
});

test('extended output, literal backslash and malformed byte escapes are distinguished', () => {
  const parser = new TmuxControlParser();
  /** @type {Value[]} */ const events = []; parser.on('notification', value => events.push(value));
  parser.feed('%extended-output %2 18 extra : path\\134name\n%pause %2\n');
  assert.equal(events[0].bytes.toString(), 'path\\name'); assert.equal(events[0].ageMs, 18); assert.equal(events[1].kind, 'paused');
  for (const value of ['\\12', '\\xyz', '\\777']) assert.throws(() => decodeTmuxOutput(value), { code: 'tui-malformed-output' });
});

test('frame, response and unfinished stream bounds fail explicitly', () => {
  assert.throws(() => new TmuxControlParser({ maxLineBytes: 4 }).feed('12345'), { code: 'tui-frame-too-large' });
  const block = new TmuxControlParser({ maxBlockBytes: 3 }); block.feed('%begin 1 1 0\n');
  assert.throws(() => block.feed('1234\n'), { code: 'tui-block-too-large' });
  const partial = new TmuxControlParser(); partial.feed('%begin 1 1 0\n'); assert.throws(() => partial.finish(), { code: 'tui-incomplete-frame' });
  assert.throws(() => new TmuxControlParser().feed('%end 1 1 0\n'), { code: 'tui-protocol-desync' });
});

function fakeProcess() {
  const child = /** @type {Value} */ (new EventEmitter()); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
  /** @type {string[]} */ const chunks = []; child.stdin.on('data', (/** @type {Buffer} */ data) => chunks.push(data.toString()));
  return { child, chunks };
}

test('a native guarded branch is not accepted on the guard first end; the trailing marker fences all commands', async () => {
  const f = fakeProcess(); const client = new TmuxControlClient({ binaryPath: '/private/tmux', socketPath: '/private/socket', sessionId: '$0', spawn: /** @type {any} */ (() => f.child) });
  const connecting = client.connect(); f.child.stdout.write('%begin 10 317 0\n%end 10 317 0\n'); await connecting;
  let resolved = false; const pending = client.run('if-shell -F 1 "display-message OK"').then(value => { resolved = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  const marker = /CODELIGHT_TMUX_DONE_[a-f0-9]+/u.exec(f.chunks[0])?.[0]; assert.ok(marker);
  f.child.stdout.write('%begin 10 320 1\n%end 10 320 1\n%begin 10 321 1\nOK\n%end 10 321 1\n');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
  f.child.stdout.write(`%begin 10 322 1\n${marker}\n%end 10 322 1\n`);
  const result = await pending; assert.equal(result.commandNumber, 322); assert.equal(result.blocks.length, 2); assert.equal(result.blocks[1].lines[0], 'OK'); client.close();
});

test('an emitted native command interrupted before trailing receipt stays unknown and queued commands never dispatch', async () => {
  const f = fakeProcess(), client = new TmuxControlClient({ binaryPath: '/private/tmux', socketPath: '/private/socket', sessionId: '$0', spawn: /** @type {any} */ (() => f.child) });
  const connecting = client.connect(); f.child.stdout.write('%begin 1 1 0\n%end 1 1 0\n'); await connecting;
  const first = client.run('display-message ONE'), second = client.run('display-message TWO');
  await new Promise(resolve => setImmediate(resolve)); const rejectFirst = assert.rejects(first, { code: 'tui-command-unknown', effectMayHaveOccurred: true });
  const rejectSecond = assert.rejects(second, { code: 'tui-command-unavailable', effectMayHaveOccurred: false }); client.close();
  await Promise.all([rejectFirst, rejectSecond]); assert.equal(f.chunks.length, 1); assert.ok(!f.chunks[0].includes('TWO'));
});
