import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { macTranslations } from '../apps/mac/translations.mjs';

test('R005: Mac push key button uses LocalizedStringKey and all three locales define both states', async () => {
  const swift = await readFile(new URL('../apps/mac/Codelync.swift', import.meta.url), 'utf8');
  assert.match(
    swift,
    /Button\(LocalizedStringKey\(service\.pushKeyPath\.isEmpty \? "Choose Apple push key…" : "Push key selected"\)\)/u,
  );
  for (const locale of /** @type {const} */ (['en', 'zh-Hans', 'ja'])) {
    assert.ok(macTranslations[locale]['Choose Apple push key…']?.trim(), `${locale} missing Choose Apple push key…`);
    assert.ok(macTranslations[locale]['Push key selected']?.trim(), `${locale} missing Push key selected`);
  }
});

test('R005: Mac device actions, rename field, notifications save and refresh guard paused/revoked/whitespace states', async () => {
  const swift = await readFile(new URL('../apps/mac/Codelync.swift', import.meta.url), 'utf8');
  assert.match(swift, /struct DeviceRow: View \{\s*let device: ServiceController\.Device\s*@ObservedObject var service: ServiceController/u);
  assert.match(swift, /func refresh\(\)\s*\{\s*guard running else \{ return \}/u);
  assert.match(swift, /func deviceAction\([^)]*\)\s*\{\s*guard running, let input else \{ return \}/u);
  assert.match(swift, /let trimmed = name\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\s*guard !trimmed\.isEmpty else \{ return \}/u);
  assert.match(swift, /\.disabled\(device\.revoked \|\| !service\.running\)/u);
  assert.match(swift, /Button\("Disconnect"\)\s*\{[^}]+\}\.disabled\(!service\.running\)/u);
  assert.match(swift, /Button\("Test notification"\)\s*\{[^}]+\}\.disabled\(service\.notificationsBusy \|\| !service\.notificationsAvailable \|\| device\.notifications != true \|\| !service\.running\)/u);
  assert.match(swift, /service\.pushKeyID\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty \|\| service\.pushTeamID\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty/u);
});

test('R010: EN/ZH/JA READMEs cross-link all three languages and keep three-Desktop + non-affiliation + dynamic TestFlight copy aligned', async () => {
  const [en, zh, ja] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.zh-CN.md', import.meta.url), 'utf8'),
    readFile(new URL('../README.ja.md', import.meta.url), 'utf8'),
  ]);

  assert.match(en, /README\.zh-CN\.md/u);
  assert.match(en, /README\.ja\.md/u);
  assert.match(zh, /README\.md/u);
  assert.match(zh, /README\.ja\.md/u);
  assert.match(ja, /README\.md/u);
  assert.match(ja, /README\.zh-CN\.md/u);

  for (const doc of [en, zh, ja]) {
    for (const desktop of ['Codex', 'Antigravity Desktop', 'Claude Desktop']) {
      assert.ok(doc.includes(desktop), `README missing ${desktop}`);
    }
    assert.match(doc, /TestFlight/u);
    assert.ok(!doc.includes('0.6.1'), 'README must not hardcode stale 0.6.1 download version');
  }
  assert.ok(!zh.includes('尚无公开 App Store/TestFlight'), 'ZH README must not contradict dynamic website TestFlight status');
  for (const vendor of ['OpenAI', 'Anthropic', 'Google']) {
    assert.ok(zh.includes(vendor), `ZH README missing non-affiliation vendor ${vendor}`);
    assert.ok(ja.includes(vendor), `JA README missing non-affiliation vendor ${vendor}`);
  }
});

test('R010: CONTRIBUTING.md and SECURITY.md align with Codex, Antigravity Desktop and Claude Desktop (Gateway) scope', async () => {
  const [contributing, security] = await Promise.all([
    readFile(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8'),
    readFile(new URL('../SECURITY.md', import.meta.url), 'utf8'),
  ]);
  for (const doc of [contributing, security]) {
    for (const desktop of ['Codex', 'Antigravity Desktop', 'Claude Desktop']) {
      assert.ok(doc.includes(desktop), `Doc missing ${desktop}`);
    }
  }
  assert.ok(!contributing.includes('currently supports existing desktop Codex sessions connected through\ngateway mode. Other harnesses'));
  for (const vendor of ['OpenAI', 'Anthropic', 'Google']) {
    assert.ok(security.includes(vendor), `SECURITY.md missing non-affiliation vendor ${vendor}`);
  }
  assert.ok(!security.includes('its exposed Codex sessions'));
});
