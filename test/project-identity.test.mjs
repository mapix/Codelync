import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCodeLightProjects, resolveLocalGitProjects } from '../src/happy/project-identity.mjs';

test('a retained git pointer traces a pruned worktree leaf to its verified common repository', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-pruned-pointer-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), tree = join(root, 'tree'); await mkdir(join(repo, '.git'), { recursive: true }); await mkdir(tree);
  await writeFile(join(repo, '.git/HEAD'), 'ref: refs/heads/main\n'); await writeFile(join(repo, '.git/config'), '[core]\n');
  await writeFile(join(tree, '.git'), `gitdir: ${repo}/.git/worktrees/pruned\n`);
  const rows = await resolveLocalGitProjects([{ id: 'main', workspace: repo }, { id: 'history', workspace: tree }]);
  assert.equal(rows[1].project.path, await realpath(repo)); assert.equal(rows[1].project.key, rows[0].project.key);
});

test('deleted managed Antigravity worktrees use one verified repository without trusting their stale saved roots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-deleted-agy-tree-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), managed = join(root, 'managed'), tree = join(managed, 'repo/deleted');
  await mkdir(join(repo, '.git'), { recursive: true });
  const rows = await resolveLocalGitProjects([{ id: 'main', workspace: repo }, { id: 'history', workspace: tree }], {
    managedRoot: managed, managedRepoComponent: 0, saved: { 'electron-saved-workspace-roots': [repo, tree] },
  });
  assert.equal(rows[1].project.path, await realpath(repo)); assert.equal(rows[1].project.key, rows[0].project.key);
});

test('deleted managed worktrees cannot choose between two independent repositories of the same name', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-ambiguous-agy-tree-')); t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'a/repo'), second = join(root, 'b/repo'), managed = join(root, 'managed'), tree = join(managed, 'repo/deleted');
  await mkdir(join(first, '.git'), { recursive: true }); await mkdir(join(second, '.git'), { recursive: true });
  const rows = await resolveLocalGitProjects([{ id: 'a', workspace: first }, { id: 'b', workspace: second }, { id: 'unknown', workspace: tree }], {
    managedRoot: managed, managedRepoComponent: 0, saved: { 'electron-saved-workspace-roots': [first, second, tree] },
  });
  assert.equal(new Set(rows.map(row => row.project.key)).size, 3); assert.equal(rows[2].project.path, tree);
});

test('native Antigravity workspace roots group linked trees and retain explicit subprojects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-agy-project-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), first = join(root, 'antigravity/worktrees/repo/first'), second = join(root, 'antigravity/worktrees/repo/second');
  await mkdir(join(repo, '.git/worktrees/first'), { recursive: true }); await mkdir(join(repo, '.git/worktrees/second'), { recursive: true });
  for (const [name, path] of [['first', first], ['second', second]]) {
    await mkdir(join(path, 'packages/a'), { recursive: true }); await mkdir(join(path, 'packages/b'), { recursive: true });
    await writeFile(join(path, '.git'), `gitdir: ${repo}/.git/worktrees/${name}\n`);
    await writeFile(join(repo, '.git/worktrees', name, 'commondir'), '../..\n');
  }
  const rows = [{ id: 'first', workspace: first }, { id: 'second', workspace: second },
    { id: 'a1', workspace: join(first, 'packages/a') }, { id: 'a2', workspace: join(second, 'packages/a') }, { id: 'b', workspace: join(second, 'packages/b') }];
  const result = await resolveLocalGitProjects(rows, { saved: { 'electron-saved-workspace-roots': rows.map(row => row.workspace) } });
  assert.equal(result[0].project.key, result[1].project.key);
  assert.equal(result[0].project.path, await realpath(repo));
  assert.equal(result[2].project.key, result[3].project.key);
  assert.notEqual(result[2].project.key, result[4].project.key);
  assert.notEqual(result[0].project.key, result[2].project.key);
  assert.deepEqual(result.map(row => row.workspace), rows.map(row => row.workspace));
});
test('main checkout, worktree and subdirectory share a project without rewriting cwd', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-project-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), worktree = join(root, 'worktree');
  await mkdir(join(repo, '.git/worktrees/worker'), { recursive: true }); await mkdir(join(repo, 'src'), { recursive: true }); await mkdir(worktree);
  await writeFile(join(worktree, '.git'), `gitdir: ${repo}/.git/worktrees/worker\n`); await writeFile(join(repo, '.git/worktrees/worker/commondir'), '../..\n');
  const result = await resolveCodeLightProjects([{ id: 'main', workspace: repo }, { id: 'subdir', workspace: join(repo, 'src') }, { id: 'worker', workspace: worktree }], root);
  assert.equal(new Set(result.map(r => r.project.key)).size, 1); assert.equal(result[2].workspace, worktree); assert.equal(result[2].project.path, await realpath(repo));
});
test('explicit assignments, child agents and removed managed worktrees use the original project root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-project-assignment-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'workspaces/app'); await mkdir(path, { recursive: true });
  await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { id: 'p', name: 'Original project', rootPaths: [path] }, legacy: { id: 'legacy', rootPaths: [path] } },
    'thread-project-assignments': { parent: { projectKind: 'local', projectId: 'p' } } }));
  const result = await resolveCodeLightProjects([{ id: 'parent', workspace: join(root, 'worktrees/deleted/app') }, { id: 'child', parentId: 'parent', workspace: join(root, 'worktrees/other/app/src') },
    { id: 'unassigned', workspace: join(root, 'worktrees/gone/app') }], root);
  assert.equal(new Set(result.map(r => r.project.key)).size, 1); assert.equal(result[0].project.path, await realpath(path));
});
test('same-name independent projects and ambiguous worktree aliases remain distinct', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-project-distinct-')); t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'a/app'), b = join(root, 'b/app'); await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
  await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { a: { id: 'a', rootPaths: [a] }, b: { id: 'b', rootPaths: [b] } } }));
  const result = await resolveCodeLightProjects([{ id: 'a', workspace: a }, { id: 'b', workspace: b }, { id: 'unknown', workspace: join(root, 'worktrees/gone/app') }], root);
  assert.equal(new Set(result.map(r => r.project.key)).size, 3);
});

test('separately assigned saved worktree projects normalize before assignment precedence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-project-saved-worktree-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), a = join(root, 'trees/a/repo'), b = join(root, 'trees/b/repo');
  await mkdir(join(repo, '.git/worktrees/a'), { recursive: true }); await mkdir(join(repo, '.git/worktrees/b'), { recursive: true });
  for (const [name, tree] of [['a', a], ['b', b]]) {
    await mkdir(join(tree, 'src'), { recursive: true });
    await writeFile(join(tree, '.git'), `gitdir: ${repo}/.git/worktrees/${name}\n`);
    await writeFile(join(repo, '.git/worktrees', name, 'commondir'), '../..\n');
  }
  await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({ 'local-projects': {
    branch: { id: 'branch', name: 'Branch only name', rootPaths: [a] }, main: { id: 'main', name: 'Main project', rootPaths: [repo] },
    otherBranch: { id: 'otherBranch', name: 'Other branch', rootPaths: [b] },
  }, 'thread-project-assignments': {
    main: { projectKind: 'local', projectId: 'main' }, a: { projectKind: 'local', projectId: 'branch' }, b: { projectKind: 'local', projectId: 'otherBranch' },
  } }));
  const rows = [{ id: 'main', workspace: repo }, { id: 'a', workspace: a }, { id: 'b', workspace: b }, { id: 'nested', workspace: join(b, 'src') }];
  const result = await resolveCodeLightProjects(rows, root);
  assert.equal(new Set(result.map(row => row.project.key)).size, 1);
  const canonicalRepo = await realpath(repo);
  assert.ok(result.every(row => row.project.path === canonicalRepo && row.project.label === 'Main project'));
  assert.deepEqual(result.map(row => row.workspace), rows.map(row => row.workspace));
});

test('explicit monorepo subprojects preserve their relative boundary across worktrees and aliases', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-project-monorepo-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), tree = join(root, 'worktree');
  await mkdir(join(repo, '.git/worktrees/worker'), { recursive: true });
  for (const path of [join(repo, 'packages/a'), join(repo, 'packages/b'), join(tree, 'packages/a/src'), join(tree, 'packages/b/src')]) await mkdir(path, { recursive: true });
  await writeFile(join(tree, '.git'), `gitdir: ${repo}/.git/worktrees/worker\n`); await writeFile(join(repo, '.git/worktrees/worker/commondir'), '../..\n');
  await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({ 'local-projects': {
    a: { id: 'a', name: 'A', rootPaths: [join(repo, 'packages/a'), join(tree, 'packages/a')] },
    treeA: { id: 'treeA', name: 'Branch A', rootPaths: [join(tree, 'packages/a')] },
    b: { id: 'b', name: 'B', rootPaths: [join(repo, 'packages/b')] },
  }, 'thread-project-assignments': { assigned: { projectKind: 'local', projectId: 'treeA' } } }));
  const result = await resolveCodeLightProjects([{ id: 'a', workspace: join(repo, 'packages/a') }, { id: 'assigned', workspace: join(tree, 'packages/a') },
    { id: 'nestedA', workspace: join(tree, 'packages/a/src') }, { id: 'nestedB', workspace: join(tree, 'packages/b/src') }], root);
  assert.equal(result[0].project.key, result[1].project.key); assert.equal(result[0].project.key, result[2].project.key);
  assert.notEqual(result[0].project.key, result[3].project.key);
  assert.equal(result[1].project.path, await realpath(join(repo, 'packages/a'))); assert.equal(result[3].project.path, await realpath(join(repo, 'packages/b')));
});

test('symlinked common Git metadata has the same identity and same-name independent repositories do not', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-project-common-link-')); t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'a/app'), b = join(root, 'b/app'), tree = join(root, 'trees/app');
  await mkdir(join(a, '.git/worktrees/worker'), { recursive: true }); await mkdir(join(b, '.git'), { recursive: true }); await mkdir(tree, { recursive: true });
  await symlink(join(a, '.git'), join(root, 'common-link'));
  await writeFile(join(tree, '.git'), `gitdir: ${a}/.git/worktrees/worker\n`); await writeFile(join(a, '.git/worktrees/worker/commondir'), join(root, 'common-link') + '\n');
  await writeFile(join(root, '.codex-global-state.json'), JSON.stringify({ 'electron-saved-workspace-roots': [a, b, tree] }));
  const result = await resolveCodeLightProjects([{ id: 'a', workspace: a }, { id: 'b', workspace: b }, { id: 'tree', workspace: tree }], root);
  assert.equal(result[0].project.key, result[2].project.key); assert.notEqual(result[0].project.key, result[1].project.key);
  assert.equal(result[2].project.path, await realpath(a));
});
