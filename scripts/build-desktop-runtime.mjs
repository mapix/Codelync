import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, cp, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SERVER_COMMIT = '385aa40f9292fe1db8caad87301e4b285b7c198a';
export const DESKTOP_RUNTIME_BINARIES = /** @type {const} */ (['CodelyncDesktopHost', 'livekit-server']);
const REQUIRED_BUNDLES = ['LiveKitWebRTC.framework', 'RustLiveKitFFI.framework', 'LiveKit_LiveKit.bundle'];
const REQUIRED_LICENSES = ['desktop-licenses/livekit-server.txt', 'desktop-licenses/livekit-swift.txt'];
const inspect = promisify(execFile);

/** Verify desktop-runtime.json schema, SHA-256 digests against native binaries, and required LiveKit bundles/licenses.
 * @param {string} targetDir
 * @param {string} [expectedServerCommit] */
export async function verifyDesktopRuntimeManifest(targetDir, expectedServerCommit = DEFAULT_SERVER_COMMIT) {
  const manifestPath = join(targetDir, 'desktop-runtime.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest || manifest.version !== 1 || manifest.server !== '1.13.11'
    || manifest.serverCommit !== expectedServerCommit || manifest.swiftSDK !== '2.19.0'
    || !manifest.hashes || typeof manifest.hashes !== 'object') {
    throw Error('Invalid desktop-runtime.json manifest contract.');
  }
  for (const binary of DESKTOP_RUNTIME_BINARIES) {
    const expectedHash = manifest.hashes[binary];
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
      throw Error(`Invalid desktop-runtime.json hash format for ${binary}.`);
    }
    const actualHash = createHash('sha256').update(await readFile(join(targetDir, binary))).digest('hex');
    if (actualHash !== expectedHash) {
      throw Error(`SHA-256 mismatch for ${binary}: expected ${expectedHash}, got ${actualHash}.`);
    }
  }
  for (const required of [...REQUIRED_BUNDLES, ...REQUIRED_LICENSES]) {
    await access(join(targetDir, required));
  }
  return manifest;
}

/** @param {string} command @param {string[]} args @param {string} cwd */
async function run(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: 'inherit' });
  const code = await new Promise((resolveDone, reject) => { child.once('error', reject); child.once('exit', resolveDone); });
  if (code !== 0) throw Error(`${command} failed (${code})`);
}

export async function buildDesktopRuntime() {
  const source = join(root, '.runtime/livekit-server-source'), target = join(root, 'native/bin');
  const serverCommit = DEFAULT_SERVER_COMMIT;
  await mkdir(target, { recursive: true }); await mkdir(join(root, '.runtime'), { recursive: true });
  try { await access(join(source, 'go.mod')); }
  catch { await run('git', ['clone', '--depth', '1', '--branch', 'v1.13.11', 'https://github.com/livekit/livekit.git', source], root); }
  const revision = (await inspect('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
  if (revision !== serverCommit) throw Error('The LiveKit server source does not match its pinned revision.');
  const status = (await inspect('git', ['status', '--porcelain'], { cwd: source })).stdout;
  if (status) throw Error('The pinned LiveKit server source has local edits.');
  await run('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', join(target, 'livekit-server'), './cmd/server'], source);
  const swiftRoot = join(root, 'native/remote-desktop');
  // SwiftPM emits a literal build-directory fallback in its resource accessor.
  // Keep that generated path neutral as well as mapping compiler source metadata.
  const swiftScratch = await mkdtemp('/private/tmp/codelync-desktop-build-');
  const swiftBuild = ['build', '-c', 'release', '--build-system', 'native', '--scratch-path', swiftScratch];
  const prefixMaps = [`${root}=/codelync-build/source`, `${homedir()}=/codelync-build/home`];
  const swiftFlags = prefixMaps.flatMap(map => ['-Xswiftc', '-file-prefix-map', '-Xswiftc', map,
    '-Xswiftc', '-debug-prefix-map', '-Xswiftc', map, '-Xcc', `-ffile-prefix-map=${map}`, '-Xcc', `-fdebug-prefix-map=${map}`]);
  await run('swift', [...swiftBuild, '--disable-index-store', ...swiftFlags,
    '-Xswiftc', '-file-compilation-dir', '-Xswiftc', '/codelync-build', '-Xcc', '-fdebug-compilation-dir=/codelync-build',
    '-Xlinker', '-rpath', '-Xlinker', '@executable_path/../../../../Frameworks'], swiftRoot);
  const swiftBin = (await inspect('swift', [...swiftBuild, '--show-bin-path'], { cwd: swiftRoot })).stdout.trim();
  await cp(join(swiftBin, 'CodelyncDesktopHost'), join(target, 'CodelyncDesktopHost'));
  await run('xcrun', ['strip', '-S', join(target, 'CodelyncDesktopHost')], root);
  for (const name of REQUIRED_BUNDLES) {
    await cp(join(swiftBin, name), join(target, name), { recursive: true, verbatimSymlinks: true });
  }
  const licenses = join(target, 'desktop-licenses'); await mkdir(licenses, { recursive: true });
  await cp(join(source, 'LICENSE'), join(licenses, 'livekit-server.txt'));
  await cp(join(swiftScratch, 'checkouts/client-sdk-swift/LICENSE'), join(licenses, 'livekit-swift.txt'));
  const hashes = Object.fromEntries(await Promise.all(DESKTOP_RUNTIME_BINARIES.map(async name => [name, createHash('sha256').update(await readFile(join(target, name))).digest('hex')])));
  await writeFile(join(target, 'desktop-runtime.json'), JSON.stringify({ version: 1, server: '1.13.11', serverCommit, swiftSDK: '2.19.0', hashes }) + '\n');
  await verifyDesktopRuntimeManifest(target, serverCommit);
  return { built: [...DESKTOP_RUNTIME_BINARIES], serverCommit, swiftSDK: '2.19.0', hashes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await buildDesktopRuntime()));
}
