import { access, readdir, open, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const magic = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf']);
const bundleSuffixes = ['.framework', '.bundle', '.xpc', '.appex', '.app'];
const bundlePlistPaths = ['Info.plist', 'Contents/Info.plist', 'Resources/Info.plist', 'Versions/Current/Resources/Info.plist'];

/** Return true when a bundle directory contains an Info.plist so Apple codesign accepts it as a CFBundle.
 * Data-only SwiftPM resource bundles (e.g. LiveKit_LiveKit.bundle) lack Info.plist and are sealed by the outer .app.
 * @param {string} bundleDir @returns {Promise<boolean>} */
async function isSignableBundle(bundleDir) {
  for (const rel of bundlePlistPaths) {
    try { await access(join(bundleDir, rel)); return true; } catch { /* check next location */ }
  }
  return false;
}

/** Collect inside-out signing targets for a Mac .app bundle without following symlinks.
 * @param {string} appPath @returns {Promise<{innerBinaries:string[],bundles:string[],mainBinaries:string[]}>} */
export async function collectSigningTargets(appPath) {
  const app = resolve(appPath);
  const macosDir = join(app, 'Contents/MacOS') + sep;
  /** @type {string[]} */ const innerBinaries = [];
  /** @type {string[]} */ const bundles = [];
  /** @type {string[]} */ const mainBinaries = [];

  /** @param {string} folder */
  async function scan(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        if (bundleSuffixes.some(suffix => entry.name.endsWith(suffix)) && await isSignableBundle(path)) bundles.push(path);
      } else if (entry.isFile()) {
        const file = await open(path, 'r'); const head = Buffer.alloc(4);
        try { await file.read(head, 0, 4, 0); } finally { await file.close(); }
        if (magic.has(head.toString('hex'))) {
          if (path.startsWith(macosDir)) mainBinaries.push(path);
          else innerBinaries.push(path);
        }
      }
    }
  }

  await scan(join(app, 'Contents'));
  const deepestFirst = (/** @type {string} */ a, /** @type {string} */ b) =>
    b.split(sep).length - a.split(sep).length || a.localeCompare(b);
  innerBinaries.sort(deepestFirst);
  bundles.sort(deepestFirst);
  mainBinaries.sort(deepestFirst);
  return { innerBinaries, bundles, mainBinaries };
}

/** Sign embedded binaries, nested bundles/frameworks, main executable, and outer .app inside-out.
 * @param {string} appPath @param {string} identity */
export async function signMacApp(appPath, identity) {
  if (!appPath) throw Error('A Mac app path is required');
  if (!identity) throw Error('A signing identity is required');
  const app = resolve(appPath);
  const { innerBinaries, bundles, mainBinaries } = await collectSigningTargets(app);
  const nodeBinary = join(app, 'Contents/Resources/runtime/node');
  const entitlements = join(tmpdir(), 'codelync-sign-' + randomUUID() + '.plist');
  await writeFile(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>', { mode: 0o600 });
  try {
    for (const binary of innerBinaries) {
      await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity,
        ...(binary === nodeBinary ? ['--entitlements', entitlements] : []), binary]);
    }
    for (const bundle of bundles) {
      await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, bundle]);
    }
    for (const binary of mainBinaries) {
      await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, binary]);
    }
    await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, app]);
    await run('codesign', ['--verify', '--deep', '--strict', app]);
    for (const target of [...innerBinaries, ...bundles, ...mainBinaries]) {
      await run('codesign', ['--verify', '--strict', target]);
    }
    return { signedApp: app, verifiedBinaries: innerBinaries.length + mainBinaries.length, verifiedBundles: bundles.length, notarized: false };
  } finally { await rm(entitlements, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await signMacApp(process.argv[2], process.argv[3])));
}
