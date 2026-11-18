import { mkdtemp, rm, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PUBLIC_DOC_FILES = ['README.md', 'README.zh-CN.md', 'README.ja.md', 'SECURITY.md', 'CONTRIBUTING.md'];
const PRIVATE_DOC_LEAK_RE = /\/Users\/|C:\\Users\\|BEGIN [A-Z ]*PRIVATE KEY/u;

/** Reject AppleDouble, Finder metadata, generated website release metadata and download archives in source entries.
 * @param {string[]} names */
export function assertCleanArchiveMembers(names) {
  for (const name of names) {
    if (!name) continue;
    if (/(^|\/)(?:\._|__MACOSX(?:\/|$)|\.DS_Store$)/u.test(name)) {
      throw Error(`Publisher metadata in source ZIP: ${name}`);
    }
    if (/(^|\/)website\/(?:release\.json|downloads(?:\/|$))/u.test(name)) {
      throw Error(`Release download artifact in source ZIP: ${name}`);
    }
  }
}

/** Assert public documentation and TestFlight metadata in an exported source tree contain no private leaks or unapproved beta links.
 * @param {string} root
 * @param {{ requireDocs?: boolean }} [options] */
export async function assertCleanPublicMetadata(root, { requireDocs = true } = {}) {
  for (const docPath of PUBLIC_DOC_FILES) {
    let text;
    try {
      text = await readFile(join(root, docPath), 'utf8');
    } catch (error) {
      if (!requireDocs && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
      throw error;
    }
    if (PRIVATE_DOC_LEAK_RE.test(text)) {
      throw Error(`Private path or key material in exported doc: ${docPath}`);
    }
  }
  let betaRaw;
  try {
    betaRaw = await readFile(join(root, 'website/testflight.json'), 'utf8');
  } catch (error) {
    if (!requireDocs && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return;
    throw error;
  }
  const beta = JSON.parse(betaRaw);
  if (!beta || beta.schemaVersion !== 2 || !['coming-soon', 'in-review', 'available', 'closed'].includes(beta.status)
    || typeof beta.externalApproved !== 'boolean' || typeof beta.externalGroupEnabled !== 'boolean'
    || typeof beta.externalGroupContainsBuild !== 'boolean') {
    throw Error('Invalid website/testflight.json metadata in source export');
  }
  if (beta.status !== 'available' && beta.publicURL !== null) {
    throw Error('Unapproved website/testflight.json carries non-null publicURL');
  }
  if (beta.status === 'available' && (!beta.externalApproved || !beta.externalGroupEnabled || !beta.externalGroupContainsBuild
    || !/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]{8}$/u.test(beta.publicURL || ''))) {
    throw Error('Unverified available TestFlight join link in website/testflight.json');
  }
}

/** @param {string} command @param {string[]} args @param {string} cwd */
async function execute(command, args, cwd) {
  const child = spawn(command, args, { cwd, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }, stdio: 'inherit' });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code !== 0) throw Error(`${command} exited ${code}`);
}

/** Verify a packaged Codelync source archive end to end.
 * @param {string} archive
 * @param {{ install?: boolean }} [options] */
export async function verifyCodelyncSource(archive, { install = false } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Source verification requires Node 24 or newer; use the version in .nvmrc.');
  const directory = await mkdtemp(join(tmpdir(), 'codelync-source-smoke-'));
  try {
    const listing = await run('zipinfo', ['-1', archive], { maxBuffer: 16 * 1024 * 1024 });
    assertCleanArchiveMembers(listing.stdout.split('\n'));
    await run('ditto', ['-x', '-k', archive, directory]);
    const root = join(directory, 'codelync');
    const product = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (product.name !== 'codelync' || product.packageManager !== 'pnpm@10.11.0') throw Error('The source workspace/toolchain contract did not match.');
    for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/mac/Codelync.swift', 'apps/mobile/package.json', 'packages/relay/sources/standalone.ts',
      'packages/wire/package.json', 'src/codelync/mac-app-service.mjs', 'native/codelync-simulator.entitlements', 'native/codelync-development.entitlements', 'assets/branding/generation.json', 'licenses/Happy-LICENSE']) await readFile(join(root, path));
    let files = 0;
    /** @param {string} folder @param {string} [prefix] */
    async function inspect(folder, prefix = '') {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (/(^|\/)(node_modules|Pods|\.runtime|deliverables|xcuserdata|\.module-cache)(\/|$)/u.test(name)
          || /^docs\/tasks(?:\/|$)/u.test(name) || /evidence\/private/u.test(name) || /(^|\/)(account|devices|relay-key|mac-box-key|network-access|network-identity|connection-channels)\.json$/u.test(name)
          || /(^|\/)\.DS_Store$/u.test(name) || /^website\/(?:release\.json|downloads(?:\/|$))/u.test(name)
          || /\.(p8|p12|pem|mobileprovision|ipa|sqlite|db|log|tsbuildinfo)$/u.test(name) || /(^|\/)\.env(\.|$)/u.test(name) && !name.endsWith('.env.example')) throw Error(`Private/generated path in source export: ${name}`);
        if (entry.isSymbolicLink()) throw Error(`Source export must not depend on external symlinks: ${name}`);
        if (entry.isDirectory()) await inspect(join(folder, entry.name), name + '/'); else files++;
      }
    }
    await inspect(root);
    await assertCleanPublicMetadata(root, { requireDocs: true });
    if (!(await readFile(join(root, 'scripts/codelync-daemon.mjs'), 'utf8')).includes('Codelync Mac:')) throw Error('Current daemon help contract is missing.');
    const plan = await run(process.execPath, ['scripts/build-mobile.mjs', '--simulator', 'fixture-simulator', '--dry-run'], { cwd: root });
    if (!JSON.parse(plan.stdout).entitlements.startsWith(await realpath(root))) throw Error('Native paths escaped the extracted project.');
    if (install) {
      await execute('pnpm', ['install', '--frozen-lockfile'], root);
      const help = await run(process.execPath, ['scripts/codelync-daemon.mjs', '--help'], { cwd: root });
      if (!help.stdout.includes('Codelync Mac')) throw Error('Fresh-source daemon help failed.');
      const preset = await run(process.execPath, ['-e', "process.stdout.write(require.resolve('babel-preset-expo'))"], { cwd: join(root, 'apps/mobile') });
      if (!(await realpath(preset.stdout)).startsWith(await realpath(root))) throw Error('Expo Babel preset escaped the standalone workspace.');
      await execute('pnpm', ['typecheck:all'], root);
    }
    return { archive, sourceFiles: files, sourceContractVerified: true, privatePathsExcluded: true, freshInstallVerified: install };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const archive = resolve(process.argv.find((arg, index) => index > 1 && !arg.startsWith('--')) ?? join(repository, 'deliverables/Codelync-Source.zip'));
  console.log(JSON.stringify(await verifyCodelyncSource(archive, { install: process.argv.includes('--install') })));
}
