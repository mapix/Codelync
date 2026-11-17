import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, unlink, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLanListenerPorts } from '../src/codelync/lan-listener-ports.mjs';

const original = { lstat: fs.promises.lstat, open: fs.promises.open };
/** A deterministic race around real file operations, using synthetic hint files only.
 * @param {string} path @param {()=>Promise<void>} race */
function intercept(path, race) {
  let raced = false;
  const once = async () => { if (!raced) { raced = true; await race(); } };
  const promises = /** @type {any} */ (fs.promises);
  promises.lstat = async (/** @type {any} */ candidate, /** @type {any} */ options) => {
    const result = await original.lstat(candidate, options);
    if (candidate === path) await once();
    return result;
  };
  promises.open = async (/** @type {any} */ candidate, /** @type {any} */ flags, /** @type {any} */ mode) => {
    const handle = await original.open(candidate, flags, mode);
    if (candidate === path) {
      const stat = handle.stat.bind(handle);
      handle.stat = /** @type {typeof handle.stat} */ (async () => { const result = await stat(); await once(); return result; });
    }
    return handle;
  };
  syncBuiltinESMExports();
  return () => { promises.lstat = original.lstat; promises.open = original.open; syncBuiltinESMExports(); };
}

test('[N08] swapping a checked hint pathname cannot redirect the read to a foreign synthetic file', async () => {
  const state = await mkdtemp(join(tmpdir(), 'codelync-port-hint-race-')), path = join(state, 'lan-listeners.json'), foreign = join(state, 'synthetic-foreign.json');
  await writeFile(path, JSON.stringify({ version: 1, listeners: [{ host: '192.168.50.2', port: 53000 }] }), { mode: 0o600 });
  await writeFile(foreign, JSON.stringify({ version: 1, listeners: [{ host: '192.168.60.2', port: 54000 }] }), { mode: 0o600 });
  const restore = intercept(path, async () => { await unlink(path); await symlink(foreign, path); });
  try {
    const ports = await readLanListenerPorts(state);
    assert.equal(ports.has('192.168.60.2'), false);
    assert.ok(ports.size === 0 || ports.get('192.168.50.2') === 53000);
  } finally { restore(); await rm(state, { recursive: true, force: true }); }
});

test('[N08] a hint file growing after metadata check remains bounded to 4 KiB', async () => {
  const state = await mkdtemp(join(tmpdir(), 'codelync-port-hint-growth-')), path = join(state, 'lan-listeners.json');
  const content = JSON.stringify({ version: 1, listeners: [{ host: '192.168.50.2', port: 53000 }] });
  await writeFile(path, content, { mode: 0o600 });
  const restore = intercept(path, async () => { await writeFile(path, content + ' '.repeat(6000), { mode: 0o600 }); });
  try { assert.equal((await readLanListenerPorts(state)).size, 0); }
  finally { restore(); await rm(state, { recursive: true, force: true }); }
});
