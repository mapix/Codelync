import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = promisify(execFile);

test('R055: NDJSONLineSplitter discards only oversized lines across chunks and recovers subsequent valid lines', { skip: process.platform !== 'darwin' }, async () => {
  const source = await readFile(new URL('../apps/mac/Codelync.swift', import.meta.url), 'utf8');
  const declarations = source.split('// BEGIN CODELYNC NDJSON FRAMER\n')[1]?.split('// END CODELYNC NDJSON FRAMER')[0];
  assert.ok(declarations);
  const directory = await mkdtemp(join(tmpdir(), 'codelync-r055-'));
  try {
    const script = join(directory, 'framer.swift');
    await writeFile(script, 'import Foundation\n' + declarations + String.raw`
var splitter = NDJSONLineSplitter(maxLineBytes: 64)
let oversized = Data(repeating: 65, count: 80) + Data([10]) + Data(#"{"type":"ready"}"#.utf8) + Data([10])
let first = splitter.append(oversized)
precondition(first.count == 1 && String(decoding: first[0], as: UTF8.self) == #"{"type":"ready"}"#)

let part1 = Data(repeating: 66, count: 50)
let part2 = Data(repeating: 67, count: 30) + Data([10]) + Data(#"{"type":"metrics"}"#.utf8) + Data([10])
precondition(splitter.append(part1).isEmpty)
let second = splitter.append(part2)
precondition(second.count == 1 && String(decoding: second[0], as: UTF8.self) == #"{"type":"metrics"}"#)

let twoValid = Data(repeating: 68, count: 50) + Data([10]) + Data(repeating: 69, count: 50) + Data([10])
let third = splitter.append(twoValid)
precondition(third.count == 2 && third[0].count == 50 && third[1].count == 50)

precondition(splitter.append(Data(repeating: 70, count: 70)).isEmpty)
splitter.reset()
let recovered = splitter.append(Data(#"{"type":"paused"}"#.utf8) + Data([10]))
precondition(recovered.count == 1 && String(decoding: recovered[0], as: UTF8.self) == #"{"type":"paused"}"#)
print("r055-framer-passed")
`);
    const sdk = await execute('/usr/bin/xcrun', ['--show-sdk-path']);
    const result = await execute('/usr/bin/xcrun', ['swift', '-sdk', sdk.stdout.trim(), script], { timeout: 30000 });
    assert.match(result.stdout, /r055-framer-passed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('R055 & R060: ServiceController clears transient errors across Start/Pause and preserves Relay/Media drafts', async () => {
  const swift = await readFile(new URL('../apps/mac/Codelync.swift', import.meta.url), 'utf8');
  assert.match(swift, /resetTransientErrors\(\)/u);
  assert.match(swift, /func resetTransientErrors\(\)[\s\S]*operationError = ""[\s\S]*sourcesError = ""[\s\S]*channelsError = ""[\s\S]*accessError = ""[\s\S]*desktopError = ""[\s\S]*notificationsError = ""[\s\S]*notificationTestAccepted = false/u);
  assert.match(swift, /terminateOwnedProcess\(\)[\s\S]*?resetTransientErrors\(\)/u);
  assert.match(swift, /launch\(_ mode: LaunchMode\)[\s\S]*?lineFramer\.reset\(\)[\s\S]*?resetTransientErrors\(\)/u);

  assert.match(swift, /TextField\("Relay server address"[^)]*\)[\s\S]*?\.disabled\(service\.accessBusy \|\| !service\.settingsAvailable\)/u);
  assert.match(swift, /SecureField\("Access key"[^)]*\)[\s\S]*?\.disabled\(service\.accessBusy \|\| !service\.settingsAvailable\)/u);
  assert.match(swift, /if !relayDraftInitialized[\s\S]*else if !accessBusy, relayServer == previousServer/u);
  assert.match(swift, /if !desktopDraftInitialized[\s\S]*else if !desktopBusy, desktopMode == previousDesktop\.mode, desktopServer == previousDesktop\.url/u);
  assert.match(swift, /if pendingKind == "relay"[\s\S]*desktopAPISecret = ""/u);
  assert.match(swift, /desktopCommand\(\["type": "configure-desktop", "configuration": configuration\], kind: enabled == nil \? "relay" : "toggle"\)/u);
});
