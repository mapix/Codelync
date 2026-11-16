import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { productionPackageRoot } from '../scripts/package-root.mjs';
import { createRequire } from 'node:module';

test('native-only package exports do not cause installed optional dependencies to disappear from the app', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codelight-package-root-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}');
  const native = join(root, 'node_modules/@fixture/native'); await mkdir(native, { recursive: true });
  await writeFile(join(native, 'package.json'), JSON.stringify({ name: '@fixture/native', exports: { './native.node': './native.node' } }));
  await writeFile(join(native, 'native.node'), 'fixture binary');
  assert.equal((await productionPackageRoot('@fixture/native', root)).folder, await realpath(native));
  await assert.rejects(productionPackageRoot('@fixture/missing', root));
});

test('the installed Sharp platform module and libvips package are available to the production packager', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const sharp = await productionPackageRoot('sharp', process.cwd());
  const native = await productionPackageRoot('@img/sharp-darwin-arm64', sharp.folder);
  const binary = createRequire(join(sharp.folder, 'package.json')).resolve('@img/sharp-darwin-arm64/sharp.node');
  assert.ok(binary.startsWith(native.folder + '/')); await access(binary);
  const lib = await productionPackageRoot('@img/sharp-libvips-darwin-arm64', sharp.folder);
  assert.equal(lib.data.name, '@img/sharp-libvips-darwin-arm64');
});
