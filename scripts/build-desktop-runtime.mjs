import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, cp, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '.runtime/livekit-server-source'), target = join(root, 'native/bin');
const serverCommit = '385aa40f9292fe1db8caad87301e4b285b7c198a';
const inspect = promisify(execFile);
/** @param {string} command @param {string[]} args @param {string} cwd */
async function run(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: 'inherit' });
  const code = await new Promise((resolveDone, reject) => { child.once('error', reject); child.once('exit', resolveDone); });
  if (code !== 0) throw Error(`${command} failed (${code})`);
}
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
for (const name of ['LiveKitWebRTC.framework', 'RustLiveKitFFI.framework', 'LiveKit_LiveKit.bundle']) {
  await cp(join(swiftBin, name), join(target, name), { recursive: true, verbatimSymlinks: true });
}
const licenses = join(target, 'desktop-licenses'); await mkdir(licenses, { recursive: true });
await cp(join(source, 'LICENSE'), join(licenses, 'livekit-server.txt'));
await cp(join(swiftScratch, 'checkouts/client-sdk-swift/LICENSE'), join(licenses, 'livekit-swift.txt'));
const hashes = Object.fromEntries(await Promise.all(['CodelyncDesktopHost', 'livekit-server'].map(async name => [name, createHash('sha256').update(await readFile(join(target, name))).digest('hex')])));
await writeFile(join(target, 'desktop-runtime.json'), JSON.stringify({ version: 1, server: '1.13.11', serverCommit, swiftSDK: '2.19.0', hashes }) + '\n');
console.log(JSON.stringify({ built: ['CodelyncDesktopHost', 'livekit-server'], serverCommit, swiftSDK: '2.19.0' }));
