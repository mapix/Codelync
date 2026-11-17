import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AntigravityBackend } from '../src/adapters/antigravity-backend.mjs';

/** @typedef {Record<string,any>} Value */
/** @param {string} workspace */
const summary = workspace => ({ status: 'CASCADE_RUN_STATUS_IDLE', workspaces: [{ workspaceFolderAbsoluteUri: pathToFileURL(workspace).href }] });

test('resident and durable Antigravity projects use only the native runtime managed home', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'codelync-agy-project-home-'));
  let backend;
  try {
    const root = await realpath(temporary), home = join(root, 'native-home'), main = join(root, 'projects', 'fixture-repository');
    const managed = join(home, '.gemini/antigravity/worktrees/fixture-repository', 'old-resident');
    const historical = join(home, '.gemini/antigravity/worktrees/fixture-repository', 'old-history');
    const otherHome = join(root, 'other-home/.gemini/antigravity/worktrees/fixture-repository', 'unrelated');
    await mkdir(join(main, '.git'), { recursive: true });
    await writeFile(join(main, '.git/HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(main, '.git/config'), '[core]\n\tbare = false\n');
    const summaries = { main: summary(main), managed: summary(managed), unrelated: summary(otherHome) };
    /** @type {string[]} */ const methods = [];
    const rpc = { latestRuntime: { binary: '/fixture/Antigravity.app/Contents/Resources/bin/language_server', home, appDataDir: 'antigravity' },
      generation: () => 'fixture-owner', dispose: async () => {}, call: async (/** @type {string} */ method) => {
        methods.push(method); assert.equal(method, 'GetAllCascadeTrajectories'); return { trajectorySummaries: summaries };
      } };
    const historyIndex = { merge: async (/** @type {Value} */ resident) => ({ summaries: { ...resident, historical: summary(historical) }, complete: true, stamp: 'fixture', archivedIds: [] }), dispose: () => {} };
    backend = new AntigravityBackend({ rpc, historyIndex });
    const resident = await backend.list({ history: false });
    const catalogue = await backend.list();
    for (const rows of [resident, catalogue]) {
      const mainRow = rows.find(row => row.id === 'main'), managedRow = rows.find(row => row.id === 'managed'), unrelated = rows.find(row => row.id === 'unrelated');
      assert.ok(mainRow && managedRow && unrelated);
      assert.equal(managedRow.project.key, mainRow.project.key); assert.equal(managedRow.project.path, main);
      assert.equal(managedRow.workspace, managed); assert.notEqual(unrelated.project.key, mainRow.project.key);
      assert.equal(unrelated.project.path, otherHome);
    }
    assert.equal(catalogue.find(row => row.id === 'historical')?.project.path, main);
    assert.deepEqual(methods, ['GetAllCascadeTrajectories']);
  } finally { await backend?.dispose(); await rm(temporary, { recursive: true, force: true }); }
});
