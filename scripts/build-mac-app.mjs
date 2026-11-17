import { mkdir, readFile, writeFile, cp, symlink, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { productionPackageRoot as packageRoot } from './package-root.mjs';
import { portablePrismaMetadata } from './portable-prisma-metadata.mjs';
import { macTranslations, macLocalNetworkDescriptions } from '../apps/mac/translations.mjs';

/** @typedef {Record<string,any>} Value */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(root, 'deliverables/mac-app-20261031/Codelync.app'));
const resources = join(output, 'Contents/Resources'), runtime = join(resources, 'runtime');
const happy = root;
const require = createRequire(join(happy, 'package.json'));
const inspect = promisify(execFile);
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const bundleId = process.env.CODELYNC_MAC_BUNDLE_ID ?? 'com.learnings.codelync.mac';
if (!/^[A-Za-z0-9]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw Error('A valid Mac bundle identifier is required.');
if (!/^\d+\.\d+\.\d+$/u.test(packageMetadata.version)) throw Error('Mac releases require a numeric three-part version.');
const appBuild = process.env.CODELYNC_MAC_BUILD ?? packageMetadata.codelyncBuild ?? new Date().toISOString().slice(0, 10).replaceAll('-', '');
if (typeof appBuild !== 'string' || !/^\d{8,14}$/u.test(appBuild)) throw Error('Mac build numbers require 8–14 numeric digits.');
/** @param {string} command @param {string[]} args @param {string} [cwd] */
async function run(command, args, cwd = root) {
  const process = spawn(command, args, { cwd, stdio: 'inherit' });
  const code = await new Promise((resolveDone, reject) => { process.once('error', reject); process.once('exit', resolveDone); });
  if (code !== 0) throw Error(`${command} exited ${code}`);
}
async function verifyDesktopHelper() {
  const child = spawn(join(runtime, 'native/bin/CodelyncDesktopHost'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes.toString(); }); child.stderr.resume();
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const done = new Promise((resolveDone, reject) => { child.once('error', reject); child.once('exit', resolveDone); });
    child.stdin.end(JSON.stringify({ id: 'build-probe', operation: 'status' }) + '\n');
    const code = await done;
    const reply = JSON.parse(output.trim());
    if (code !== 0 || reply.id !== 'build-probe' || reply.ok !== true || reply.result?.capturing !== false) throw Error('The packaged remote desktop helper failed its startup check.');
  } finally { clearTimeout(timeout); }
}
/** @type {Map<string,string>} */ const copied = new Map();
/** @param {string} name @param {string} from @param {string} target */
async function copyPackage(name, from, target) {
  const source = await packageRoot(name, from), id = createHash('sha256').update(source.folder).digest('hex').slice(0, 16);
  const destination = join(runtime, 'node_modules/.codelync', id);
  if (!copied.has(source.folder)) {
    copied.set(source.folder, destination);
    await cp(source.folder, destination, { recursive: true, dereference: true, filter: path => !relative(source.folder, path).split('/').includes('node_modules') });
    for (const dependency of Object.keys(source.data.dependencies ?? {})) await copyPackage(dependency, source.folder, join(destination, 'node_modules', dependency));
    for (const dependency of Object.keys(source.data.optionalDependencies ?? {})) {
      try { await copyPackage(dependency, source.folder, join(destination, 'node_modules', dependency)); }
      catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'MODULE_NOT_FOUND') throw error; /* Only uninstalled optional dependencies are omitted. */ }
    }
  }
  await mkdir(dirname(target), { recursive: true });
  try { await symlink(relative(dirname(target), destination), target, 'dir'); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error; }
}
await access(output).then(() => { throw Error('The output app directory already exists. Choose a fresh output path.'); }, () => {});
await mkdir(join(output, 'Contents/MacOS'), { recursive: true }); await mkdir(join(runtime, 'server'), { recursive: true }); await mkdir(join(runtime, 'src/happy'), { recursive: true });
await cp(process.env.CODELYNC_NODE_BINARY ?? process.execPath, join(runtime, 'node'));
await cp(process.env.CODELYNC_CLOUDFLARED_BINARY ?? join(root, '.runtime/cloudflared'), join(runtime, 'cloudflared'));
await cp(join(root, 'native/bin'), join(runtime, 'native/bin'), { recursive: true,
  filter: path => !['LiveKitWebRTC.framework', 'RustLiveKitFFI.framework', 'desktop-licenses'].includes(basename(path)) });
await mkdir(join(output, 'Contents/Frameworks'), { recursive: true });
for (const name of ['LiveKitWebRTC.framework', 'RustLiveKitFFI.framework']) {
  await cp(join(root, 'native/bin', name), join(output, 'Contents/Frameworks', name), { recursive: true, verbatimSymlinks: true });
}
await cp(join(root, 'native/bin/LiveKit_LiveKit.bundle'), join(resources, 'LiveKit_LiveKit.bundle'), { recursive: true });
await cp(join(root, 'native/bin/desktop-licenses'), join(resources, 'licenses/desktop'), { recursive: true });
await cp(join(root, 'src/adapters/codex-schemas'), join(runtime, 'src/codelync/codex-schemas'), { recursive: true });
await cp(join(root, 'src/codelync/codex-index-worker.mjs'), join(runtime, 'src/codelync/codex-index-worker.mjs'));
await cp(join(happy, 'packages/relay/prisma'), join(runtime, 'server/prisma'), { recursive: true });
const esbuild = require.resolve('esbuild/bin/esbuild');
await run(esbuild, [join(happy, 'packages/relay/sources/standalone.ts'), '--bundle', '--platform=node', '--format=esm',
  '--banner:js=import { createRequire as runtimeRequire } from "node:module"; import { fileURLToPath as runtimeFile } from "node:url"; import { dirname as runtimeDir } from "node:path"; const require = runtimeRequire(import.meta.url); const __filename = runtimeFile(import.meta.url); const __dirname = runtimeDir(__filename);',
  '--outfile=' + join(runtime, 'server/standalone.mjs'), '--tsconfig=' + join(happy, 'packages/relay/tsconfig.json'),
  '--external:@prisma/client', '--external:@electric-sql/pglite', '--external:pglite-prisma-adapter', '--external:sharp', '--external:redis']);
await run(esbuild, [join(root, 'src/codelync/mac-app-service.mjs'), '--bundle', '--platform=node', '--format=esm',
  '--packages=external', '--outfile=' + join(runtime, 'src/codelync/mac-app-service.mjs')]);
const serverDeps = ['@prisma/client', '@electric-sql/pglite', 'pglite-prisma-adapter', 'sharp'];
for (const name of serverDeps) await copyPackage(name, join(happy, 'packages/relay'), join(runtime, 'node_modules', name));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const name of Object.keys(pkg.dependencies)) await copyPackage(name, root, join(runtime, 'node_modules', name));
const relayRequire = createRequire(join(root, 'packages/relay/package.json'));
const prismaManifest = relayRequire.resolve('@prisma/client/package.json');
const generatedPrisma = dirname(relayRequire.resolve('.prisma/client/default', { paths: [prismaManifest] }));
await cp(generatedPrisma, join(runtime, 'node_modules/.prisma/client'), { recursive: true });
for (const name of ['index.js', 'edge.js', 'wasm.js']) {
  const path = join(runtime, 'node_modules/.prisma/client', name);
  await writeFile(path, portablePrismaMetadata(await readFile(path, 'utf8')));
}
await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'codelync-mac-runtime', private: true, type: 'module' }));
await cp(join(root, 'assets/branding/Codelync.icns'), join(resources, 'Codelync.icns'));
await cp(join(root, 'assets/branding/app-icon-v1.png'), join(resources, 'brand-icon.png'));
await run('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', 'arm64-apple-macosx14.0', join(root, 'apps/mac/Codelync.swift'), '-o', join(output, 'Contents/MacOS/Codelync')]);
await writeFile(join(output, 'Contents/Info.plist'), `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>Codelync</string><key>CFBundleDisplayName</key><string>Codelync</string>
<key>CFBundleIconFile</key><string>Codelync.icns</string><key>CFBundleExecutable</key><string>Codelync</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${packageMetadata.version}</string><key>CFBundleVersion</key><string>${appBuild}</string>
<key>CFBundleDevelopmentRegion</key><string>en</string><key>CFBundleLocalizations</key><array><string>en</string><string>zh-Hans</string><string>ja</string></array>
<key>NSLocalNetworkUsageDescription</key><string>Connect your paired phone to Codelync on the local network.</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/><key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>`);
await verifyDesktopHelper();
for (const [language, strings] of Object.entries(macTranslations)) {
  const folder = join(resources, language + '.lproj');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'Localizable.strings'), Object.entries(strings).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)};`).join('\n'));
  await writeFile(join(folder, 'InfoPlist.strings'), `"NSLocalNetworkUsageDescription" = ${JSON.stringify(macLocalNetworkDescriptions[language])};\n`);
}
await cp(join(root, 'THIRD-PARTY-NOTICES.md'), join(resources, 'THIRD-PARTY-NOTICES.md'));
await mkdir(join(resources, 'licenses'), { recursive: true });
await cp(process.env.CODELYNC_NODE_LICENSE ?? join(root, 'licenses/Node.js-LICENSE'), join(resources, 'licenses/Node.js-LICENSE'));
await cp(join(root, 'apps/mac/cloudflared-LICENSE.txt'), join(resources, 'licenses/cloudflared-LICENSE.txt'));
const nodeVersion = (await inspect(join(runtime, 'node'), ['--version'])).stdout.trim();
const cloudflaredVersion = (await inspect(join(runtime, 'cloudflared'), ['--version'])).stdout.trim();
console.log(JSON.stringify({ app: output, version: packageMetadata.version, productionPackages: copied.size, cloudflared: cloudflaredVersion, node: nodeVersion }));
