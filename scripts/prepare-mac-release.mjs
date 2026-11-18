import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, stat, lstat, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePublicArtifact } from '../src/release/public-artifact.mjs';

const run = promisify(execFile);
const allowedFlags = new Set(['--app', '--notary-status', '--output', '--team', '--source-commit']);

/** Parse and validate CLI release arguments without executing external signing/packaging tools.
 * @param {string[]} argv
 * @returns {{ appPath: string, notaryStatusPath: string, outputDir: string, team: string, sourceCommit?: string }} */
export function parseReleaseFlags(argv) {
  /** @type {Map<string, string>} */
  const flags = new Map();
  if (argv.length % 2 !== 0) throw Error('Use --app, --notary-status, --output, --team and optional --source-commit.');
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!allowedFlags.has(key) || !value) throw Error('Use --app, --notary-status, --output, --team and optional --source-commit.');
    flags.set(key, value);
  }
  if (!flags.has('--app') || !flags.has('--notary-status') || !flags.has('--output') || !flags.has('--team')) {
    throw Error('All four required release options are required.');
  }
  const sourceCommit = flags.get('--source-commit');
  if (sourceCommit !== undefined && !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw Error('--source-commit must be a 40-character lowercase hex SHA-1.');
  }
  return {
    appPath: resolve(/** @type {string} */ (flags.get('--app'))),
    notaryStatusPath: resolve(/** @type {string} */ (flags.get('--notary-status'))),
    outputDir: resolve(/** @type {string} */ (flags.get('--output'))),
    team: /** @type {string} */ (flags.get('--team')),
    ...(sourceCommit ? { sourceCommit } : {}),
  };
}

/** Validate notarized Mac .app bundle, staple/assess it, package immutable archive, and emit verified release metadata.
 * @param {{ appPath: string, notaryStatusPath: string, outputDir: string, team: string, sourceCommit?: string }} options */
export async function prepareMacRelease({ appPath, notaryStatusPath, outputDir, team, sourceCommit }) {
  const app = resolve(appPath);
  const directory = resolve(outputDir);
  const notaryPath = resolve(notaryStatusPath);
  if (sourceCommit !== undefined && !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw Error('--source-commit must be a 40-character lowercase hex SHA-1.');
  }
  const appStat = await lstat(app);
  if (appStat.isSymbolicLink() || !appStat.isDirectory()) {
    throw Error('Release app bundle must be a real .app directory, not a symlink.');
  }
  const notaryStat = await lstat(notaryPath);
  if (notaryStat.isSymbolicLink() || !notaryStat.isFile()) {
    throw Error('Notary status must be a regular file, not a symlink.');
  }
  const plist = join(app, 'Contents/Info.plist');
  const identifier = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleIdentifier', plist])).stdout.trim();
  if (identifier !== 'com.learnings.codelync.mac') throw Error('Release operations are restricted to the Codelync Mac bundle.');
  const version = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', plist])).stdout.trim();
  await run('codesign', ['--verify', '--deep', '--strict', app]);
  const details = (await run('codesign', ['--display', '--verbose=4', app])).stderr;
  if (!details.includes(`TeamIdentifier=${team}\n`) || !details.includes('Authority=Developer ID Application:') || !details.includes('Timestamp=')) {
    throw Error('Expected timestamped Developer ID signing was not verified.');
  }
  const notary = JSON.parse(await readFile(notaryPath, 'utf8'));
  if (notary.status !== 'Accepted' || typeof notary.id !== 'string') throw Error('Apple notarization must be Accepted before publication.');
  await run('xcrun', ['stapler', 'staple', app]);
  await run('xcrun', ['stapler', 'validate', app]);
  await run('codesign', ['--verify', '--deep', '--strict', app]);
  await run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  await mkdir(directory, { recursive: true });
  const filename = `Codelync-${version}-macos-arm64.zip`, archive = join(directory, filename);
  await access(archive).then(() => { throw Error('An immutable release archive already exists.'); }, () => {});
  await run('ditto', ['-c', '-k', '--keepParent', '--sequesterRsrc', app, archive]);
  await run('unzip', ['-tq', archive]);
  const digest = createHash('sha256'); for await (const chunk of createReadStream(archive)) digest.update(chunk);
  const metadata = validatePublicArtifact({
    version,
    filename,
    bytes: (await stat(archive)).size,
    sha256: digest.digest('hex'),
    notarization: 'Accepted',
    stapled: true,
    gatekeeperAccepted: true,
    ...(sourceCommit ? { sourceCommit } : {}),
  });
  await writeFile(join(directory, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
  await writeFile(join(directory, filename + '.sha256'), metadata.sha256 + '  ' + filename + '\n');
  return { ...metadata, notarizationId: notary.id, output: directory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await prepareMacRelease(parseReleaseFlags(process.argv.slice(2)))));
}
