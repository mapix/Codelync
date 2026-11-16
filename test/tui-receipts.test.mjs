import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalReceiptJournal, terminalCommandDigest } from '../src/tui/receipts.mjs';

test('private durable terminal receipts preserve unknown across restart and reject ID target/payload reuse', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-tui-receipt-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new TerminalReceiptJournal(directory), commandId = 'terminal-native-0001';
  const operation = { commandId, paneId: '%3', ownerGeneration: 'native-owner', action: 'input', digest: terminalCommandDigest('input', { text: 'private terminal input' }, '%3', 'native-owner') };
  const admissions = await Promise.all([first.begin(operation), first.begin(operation)]); assert.equal(admissions.filter(value => value.created).length, 1);
  const restarted = new TerminalReceiptJournal(directory); assert.equal((await restarted.get(commandId)).status, 'unknown');
  const file = (await readdir(directory)).find(value => value.endsWith('.json')); assert.ok(file);
  assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600); assert.ok(!(await readFile(join(directory, file), 'utf8')).includes('private terminal input'));
  await assert.rejects(restarted.begin({ ...operation, paneId: '%4' }), { code: 'tui-command-id-conflict' });
  await assert.rejects(restarted.begin({ ...operation, digest: terminalCommandDigest('input', { text: 'different' }, '%3', 'native-owner') }), { code: 'tui-command-id-conflict' });
  await restarted.finish(operation, { status: 'completed', commandId, acceptedBy: 'tmux-server', applicationAccepted: null });
  assert.equal((await first.get(commandId)).status, 'completed'); assert.equal((await first.begin(operation)).created, false);
});

test('receipt paths cannot be selected through command IDs', async () => {
  const journal = new TerminalReceiptJournal('/private/state');
  for (const id of ['../receipt', '/tmp/input', 'tiny', 'a'.repeat(129)]) await assert.rejects(journal.get(id), { code: 'tui-invalid-command-id' });
});

test('terminal payload order does not change a stable resize operation identity', () => {
  assert.equal(terminalCommandDigest('resize', { columns: 80, rows: 24 }, '%1', 'owner'), terminalCommandDigest('resize', { rows: 24, columns: 80 }, '%1', 'owner'));
});
