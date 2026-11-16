import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile), script = fileURLToPath(new URL('../scripts/codelight-daemon.mjs', import.meta.url));

test('daemon rejects unsupported and empty Desktop scopes before profile creation or pairing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codelight-cli-scope-')), profile = join(directory, 'not-created');
  try {
    for (const only of ['zcode:window-id', 'claude:cli-id', 'codex:', 'antigravity:', 'claude-desktop:', 'Codex:case-sensitive', 'codex: padded-id ']) {
      await assert.rejects(run(process.execPath, [script, '--server=http://127.0.0.1:1', `--profile=${profile}`, `--only=${only}`, '--account-file=/fixture-do-not-read.json']),
        error => /** @type {Record<string,any>} */ (error).stderr.includes('Unsupported native Desktop session scope'));
      await assert.rejects(stat(profile), { code: 'ENOENT' });
    }
    await assert.rejects(run(process.execPath, [script, '--help', '--only=terminal:window']),
      error => /** @type {Record<string,any>} */ (error).stderr.includes('Unsupported native Desktop session scope'));
    for (const app of ['codex', 'antigravity', 'claude-desktop']) {
      const help = await run(process.execPath, [script, '--help', `--only=${app}:fixture-native-id`, '--claude-runtime=/fixture-do-not-read.json']);
      assert.match(help.stdout, /CodeLight Mac:/);
      assert.match(help.stdout, /--claude-runtime=/);
      await assert.rejects(stat(profile), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
