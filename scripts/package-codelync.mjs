import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { copyPublicSourceSnapshot } from '../src/release/source-snapshot.mjs';

const run = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'deliverables'); await mkdir(output, { recursive: true });
const { stdout } = await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const files = [...new Set(stdout.split('\0').filter(Boolean))];
const temp = await mkdtemp(join(tmpdir(), 'codelync-source-')), stage = join(temp, 'codelync'); await mkdir(stage);
try {
  const copied = await copyPublicSourceSnapshot(root, stage, files);
  for (const name of copied) {
    if (/(^|\/)(?:\._|__MACOSX(?:\/|$)|\.DS_Store$)/u.test(name) || /^website\/(?:release\.json|downloads(?:\/|$))/u.test(name)) {
      throw Error(`Forbidden source artifact staged: ${name}`);
    }
    if (['README.md', 'README.zh-CN.md', 'README.ja.md', 'SECURITY.md', 'CONTRIBUTING.md'].includes(name)) {
      const text = await readFile(join(stage, name), 'utf8');
      if (/\/Users\/|C:\\Users\\|BEGIN [A-Z ]*PRIVATE KEY/u.test(text)) throw Error(`Private path or key material in staged doc: ${name}`);
    }
    if (name === 'website/testflight.json') {
      const beta = JSON.parse(await readFile(join(stage, name), 'utf8'));
      if (beta?.status !== 'available' && beta?.publicURL !== null) throw Error('Unapproved website/testflight.json carries non-null publicURL');
    }
  }
  const archive = join(output, 'Codelync-Source.zip'); await rm(archive, { force: true });
  await run('ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', '--noqtn', stage, archive]);
  await writeFile(join(output, 'source-manifest.json'), JSON.stringify({ product: 'Codelync', sourceFiles: copied.length, files: copied, archive, privateStateExcluded: true }, null, 2));
  console.log(JSON.stringify({ archive, sourceFiles: copied.length }));
} finally { await rm(temp, { recursive: true, force: true }); }
