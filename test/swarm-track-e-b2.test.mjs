import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macTranslations, macLocalNetworkDescriptions } from '../apps/mac/translations.mjs';
import { formatMacStrings, macSwiftCompilerArgs } from '../scripts/build-mac-app.mjs';

const execute = promisify(execFile);

test('R015: ConnectionStatus distinguishes starting from unavailable while preserving Off and reported channel states', { skip: process.platform !== 'darwin' }, async () => {
  const source = await readFile(new URL('../apps/mac/Codelync.swift', import.meta.url), 'utf8');
  const declarations = source.split('// BEGIN CODELYNC CONNECTION VALUES\n')[1]?.split('// END CODELYNC CONNECTION VALUES')[0];
  assert.ok(declarations);
  const directory = await mkdtemp(join(tmpdir(), 'codelync-r015-'));
  try {
    const script = join(directory, 'status.swift');
    await writeFile(script, 'import Foundation\n' + declarations + String.raw`
let decoder = JSONDecoder()
let config = try decoder.decode(ConnectionConfiguration.self, from: Data(#"{"enabledChannels":["local"],"relayConfigured":true,"serverUrl":"https://relay.example","hasToken":true}"#.utf8))
precondition(ConnectionStatus.label(kind: "local", configuration: config, channels: [], starting: true) == "Starting…")
precondition(ConnectionStatus.label(kind: "cloudflare", configuration: config, channels: [], starting: true) == "Off")
precondition(ConnectionStatus.label(kind: "relay", configuration: config, channels: [], starting: true) == "Off")
precondition(ConnectionStatus.label(kind: "local", configuration: config, channels: [], starting: false) == "Unavailable")
let ready = try decoder.decode([ConnectionChannel].self, from: Data(#"[{"id":"lan","kind":"local","url":"http://127.0.0.1:8080","state":"ready"}]"#.utf8))
precondition(ConnectionStatus.label(kind: "local", configuration: config, channels: ready, starting: true) == "Ready")
print("r015-status-passed")
`);
    const sdk = await execute('/usr/bin/xcrun', ['--show-sdk-path']);
    const result = await execute('/usr/bin/xcrun', ['swift', '-sdk', sdk.stdout.trim(), script], { timeout: 30000 });
    assert.match(result.stdout, /r015-status-passed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('R015: PublicAccessView passes starting state and RemoteDesktopSettingsView guards picker, fields and external URL/key', async () => {
  const swift = await readFile(new URL('../apps/mac/Codelync.swift', import.meta.url), 'utf8');
  assert.match(swift, /ConnectionStatus\.label\(kind: kind, configuration: service\.connectionConfiguration, channels: service\.connectionChannels, starting: service\.phase == \.starting\)/u);
  assert.match(swift, /Picker\("Media relay", selection: \$service\.desktopMode\)[\s\S]*?\.disabled\(!service\.desktopKnown \|\| !service\.settingsAvailable \|\| service\.desktopBusy\)/u);
  assert.match(swift, /TextField\("LiveKit server URL", text: \$service\.desktopServer[^)]*\)[\s\S]*?\.disabled\(service\.desktopBusy \|\| !service\.settingsAvailable\)/u);
  assert.match(swift, /Button\("Save media relay"\)[\s\S]*?service\.desktopMode == "external" && \(service\.desktopServer\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty \|\| service\.desktopAPIKey\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty\)/u);
  assert.match(swift, /if desktopMode == "external", \(trimmedServer\.isEmpty \|\| trimmedKey\.isEmpty\) \{ return \}/u);
});

test('R020: build-mac-app emits portable swiftc prefix maps and valid plutil-checked Mac .strings files', { skip: process.platform !== 'darwin' }, async () => {
  const args = macSwiftCompilerArgs({
    root: '/Users/private/codelync-repo',
    home: '/Users/private',
    source: '/Users/private/codelync-repo/apps/mac/Codelync.swift',
    output: '/tmp/Codelync',
  });
  assert.ok(args.includes('-file-prefix-map'));
  assert.ok(args.includes('/Users/private/codelync-repo=/codelync-build/source'));
  assert.ok(args.includes('/Users/private=/codelync-build/home'));
  assert.ok(args.includes('-debug-prefix-map'));
  assert.ok(args.includes('-file-compilation-dir'));
  assert.ok(args.includes('/codelync-build'));

  const directory = await mkdtemp(join(tmpdir(), 'codelync-r020-'));
  try {
    for (const [language, strings] of Object.entries(macTranslations)) {
      const localizable = join(directory, `${language}-Localizable.strings`);
      const infoStrings = join(directory, `${language}-InfoPlist.strings`);
      await writeFile(localizable, formatMacStrings(strings));
      await writeFile(infoStrings, formatMacStrings({ NSLocalNetworkUsageDescription: macLocalNetworkDescriptions[language] }));
      await execute('plutil', ['-lint', localizable]);
      await execute('plutil', ['-lint', infoStrings]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const builderSource = await readFile(new URL('../scripts/build-mac-app.mjs', import.meta.url), 'utf8');
  assert.match(builderSource, /inspect\('plutil', \['-lint', infoPlist\]\)/u);
  assert.match(builderSource, /inspect\('plutil', \['-lint', localizable\]\)/u);
  assert.match(builderSource, /inspect\('plutil', \['-lint', infoStrings\]\)/u);
});
