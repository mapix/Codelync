import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
/** @typedef {Record<string,any>} Value */
/** @typedef {{checkoutRoot:string,commonDir:string,mainRoot:string}} GitLocation */
/** Resolve presentation identity using readonly desktop metadata and Git files; never alter the original cwd.
 * @param {Value[]} rows @param {string} codexRoot */
export async function resolveCodeLightProjects(rows, codexRoot) {
  let saved = /** @type {Value} */ ({});
  try { saved = JSON.parse(await readFile(join(codexRoot, '.codex-global-state.json'), 'utf8')); } catch { /* Older desktops still resolve Git roots. */ }
  return resolveLocalGitProjects(rows, { saved, managedRoot: resolve(codexRoot, 'worktrees') });
}

/** Shared presentation resolver for native desktop workspace folders.
 * @param {Value[]} rows @param {{saved?:Value,managedRoot?:string,managedRepoComponent?:number}} [options] */
export async function resolveLocalGitProjects(rows, options = {}) {
  const saved = options.saved ?? {};
  const pathCache = /** @type {Map<string,Promise<string>>} */ (new Map());
  /** @param {string} path */
  const canonical = path => {
    const normal = resolve(path); if (!pathCache.has(normal)) pathCache.set(normal, realpath(normal).catch(() => normal));
    return /** @type {Promise<string>} */ (pathCache.get(normal));
  };
  const gitCache = /** @type {Map<string,Promise<GitLocation|null>>} */ (new Map());
  /** The checkout root and common repository are separate identities. Keeping
   * both lets an explicit monorepo subproject preserve its relative path.
   * @param {string} directory @returns {Promise<GitLocation|null>} */
  const gitLocation = directory => {
    const path = resolve(directory);
    if (gitCache.has(path)) return /** @type {Promise<GitLocation|null>} */ (gitCache.get(path));
    const lookup = (async () => {
      const git = join(path, '.git');
      try {
        const info = await stat(git), checkoutRoot = await canonical(path);
        if (info.isDirectory()) return { checkoutRoot, commonDir: await canonical(git), mainRoot: checkoutRoot };
        if (!info.isFile()) return null;
        const match = (await readFile(git, 'utf8')).trim().match(/^gitdir:\s*([^\r\n]+)$/u);
        if (!match) return null;
        const target = await canonical(resolve(path, match[1])); let commonDir = target, linked = false;
        try {
          const common = (await readFile(join(target, 'commondir'), 'utf8')).trim();
          if (!common || /[\r\n\0]/u.test(common)) return null;
          commonDir = await canonical(resolve(target, common)); linked = true;
        } catch {
          // A pruned worktree can retain its explicit .git pointer after Git
          // removes the administrative leaf. Trace that pointer to a verified
          // standard common repository, rather than naming the leaf a project.
          const holder = dirname(target), candidate = dirname(holder);
          if (basename(holder) === 'worktrees' && basename(candidate) === '.git') {
            try {
              if ((await stat(join(candidate, 'HEAD'))).isFile() && (await stat(join(candidate, 'config'))).isFile()) {
                commonDir = await canonical(candidate); linked = true;
              }
            } catch { /* An unverified stale pointer has no repository proof. */ }
          }
        }
        let mainRoot = checkoutRoot;
        if (linked) {
          // Standard repositories use .git. Bare/external repositories can
          // provide core.worktree; otherwise their common directory is stable.
          mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
          if (basename(commonDir) !== '.git') {
            try {
              const config = await readFile(join(commonDir, 'config'), 'utf8');
              const section = /\[core\]\s*([\s\S]*?)(?=\n\s*\[|$)/iu.exec(config)?.[1];
              const worktree = /^\s*worktree\s*=\s*(.+?)\s*$/imu.exec(section ?? '')?.[1];
              if (worktree) mainRoot = resolve(commonDir, worktree.replace(/^"(.*)"$/u, '$1'));
            } catch { /* No primary checkout is inferred for a bare repository. */ }
          }
          mainRoot = await canonical(mainRoot);
        }
        return { checkoutRoot, commonDir, mainRoot };
      } catch { const parent = dirname(path); return parent === path ? null : gitLocation(parent); }
    })();
    gitCache.set(path, lookup); return lookup;
  };
  const keyFor = (/** @type {string} */ path, /** @type {GitLocation|null} */ git, /** @type {string} */ subpath) =>
    createHash('sha256').update(JSON.stringify(git ? ['local-git-project-v1', git.commonDir, subpath] : ['local', path])).digest('hex');
  /** @type {Map<string,Value>} */ const projects = new Map(), roots = new Map(), descriptors = new Map();
  const verifiedKeys = new Set();
  /** Normalize saved roots before assignments can give worktrees separate keys.
   * @param {string} path @param {string|undefined} label */
  const savedDescriptor = async (path, label) => {
    const root = await canonical(path), git = await gitLocation(root), subpath = git ? relative(git.checkoutRoot, root) : '';
    const projectPath = git ? resolve(git.mainRoot, subpath) : root, key = keyFor(projectPath, git, subpath);
    if (git) verifiedKeys.add(key);
    const score = root === projectPath ? 2 : 1;
    let descriptor = descriptors.get(key);
    if (!descriptor) { descriptor = { key, path: projectPath, label: label || basename(projectPath) || projectPath, labelScore: label ? score : 0 }; descriptors.set(key, descriptor); }
    else if (label && score > descriptor.labelScore) { descriptor.label = label; descriptor.labelScore = score; }
    return { descriptor, root, projectPath };
  };
  const localProjects = Object.values(saved['local-projects'] ?? {}).filter(p => p && typeof p === 'object');
  for (const raw of /** @type {Value[]} */ (localProjects)) {
    const paths = Array.isArray(raw.rootPaths) ? raw.rootPaths.filter((/** @type {unknown} */ p) => typeof p === 'string' && isAbsolute(p)) : [];
    if (!paths.length || typeof raw.id !== 'string') continue;
    const { descriptor } = await savedDescriptor(paths[0], typeof raw.name === 'string' ? raw.name : undefined);
    projects.set(raw.id, descriptor);
    for (const alias of paths) {
      const { root, projectPath } = await savedDescriptor(alias, undefined);
      roots.set(root, descriptor); roots.set(projectPath, descriptor);
    }
  }
  for (const path of saved['electron-saved-workspace-roots'] ?? []) if (typeof path === 'string' && isAbsolute(path)) {
    const { root, projectPath, descriptor } = await savedDescriptor(path, saved['electron-workspace-root-labels']?.[path]);
    if (!roots.has(root)) roots.set(root, descriptor);
    if (!roots.has(projectPath)) roots.set(projectPath, descriptor);
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  /** @param {Value} row */
  const assigned = row => {
    const visited = new Set(); let id = row.id;
    while (id && !visited.has(id)) {
      visited.add(id); const assignment = saved['thread-project-assignments']?.[id];
      if (assignment?.projectKind === 'local' && projects.has(assignment.projectId)) return projects.get(assignment.projectId);
      id = byId.get(id)?.parentId;
    }
    return null;
  };
  const aliases = new Map();
  const verifiedAliases = new Map();
  for (const [root, project] of roots) {
    const name = basename(root); let candidates = aliases.get(name); if (!candidates) { candidates = new Map(); aliases.set(name, candidates); } candidates.set(project.key, project);
    if (verifiedKeys.has(project.key)) {
      let verified = verifiedAliases.get(name); if (!verified) { verified = new Map(); verifiedAliases.set(name, verified); } verified.set(project.key, project);
    }
  }
  const orderedRoots = [...roots].sort((a, b) => b[0].length - a[0].length);
  /** @param {string} path */
  const rootMatch = path => orderedRoots.find(([root]) => path === root || path.startsWith(root + '/'))?.[1];
  /** @param {string} path */
  const descriptorForPath = path => rootMatch(path) ?? { key: createHash('sha256').update(JSON.stringify(['local', path])).digest('hex'), path, label: basename(path) || path };
  const managedRoot = options.managedRoot;
  return Promise.all(rows.map(async row => {
    if (!row.workspace || !isAbsolute(row.workspace)) return row;
    let project = assigned(row); const cwd = await canonical(row.workspace);
    if (!project) {
      const git = await gitLocation(cwd);
      if (git) {
        const canonicalCwd = resolve(git.mainRoot, relative(git.checkoutRoot, cwd));
        project = rootMatch(canonicalCwd) ?? { key: keyFor(git.mainRoot, git, ''), path: git.mainRoot, label: basename(git.mainRoot) || git.mainRoot };
      }
    }
    if (!project && managedRoot) {
      // 清理过的 Codex worktree 已无 .git；只在桌面项目根唯一匹配时恢复归属，同名独立仓库不会被合并。
      const rel = relative(managedRoot, resolve(row.workspace)), parts = rel.split('/');
      if (!rel.startsWith('..') && !isAbsolute(rel) && parts.length >= 2) {
        const component = options.managedRepoComponent ?? 1;
        const candidates = (options.managedRepoComponent === undefined ? aliases : verifiedAliases).get(parts[component]);
        const savedMatch = rootMatch(cwd);
        if (candidates?.size === 1 && (!savedMatch || !verifiedKeys.has(savedMatch.key))) project = [...candidates.values()][0];
      }
    }
    if (!project) project = rootMatch(cwd);
    const result = project ?? descriptorForPath(cwd);
    return { ...row, project: { key: result.key, path: result.path, label: result.label } };
  }));
}
