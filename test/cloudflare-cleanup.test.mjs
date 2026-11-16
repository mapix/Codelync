import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const moduleUrl = pathToFileURL(join(import.meta.dirname, '../src/network/public-access.mjs')).href;
/** Isolated actual child processes; no tunnel service, desktop app or model request.
 * @param {import('node:test').TestContext} t @param {'graceful'|'ignore-term'|'missing'} mode */
async function cleanup(t, mode) {
  const state = await mkdtemp(join(tmpdir(), 'codelight-cloudflare-cleanup-')), binary = join(state, 'synthetic-cloudflared.mjs');
  t.after(() => rm(state, { recursive: true, force: true }));
  if (mode !== 'missing') await writeFile(binary, `#!${process.execPath}\n${mode === 'ignore-term' ? "process.on('SIGTERM',()=>{});" : ''}process.stderr.write('https://synthetic.trycloudflare.com\\n');setInterval(()=>{},1000);\n`, { mode: 0o700 });
  const source = `import {CloudflareAccess} from ${JSON.stringify(moduleUrl)};
const access=new CloudflareAccess({binary:${JSON.stringify(binary)},upstream:'http://127.0.0.1:9',state:${JSON.stringify(state)}});
let startFailed=false;try{await access.start();}catch{startFailed=true;}
await access.close();console.log(JSON.stringify({startFailed,exitCode:access.child?.exitCode??null,signalCode:access.child?.signalCode??null,hasChildPid:typeof access.child?.pid==='number'}));`;
  const started = performance.now();
  const result = await execute(process.execPath, ['--input-type=module', '-e', source], { timeout: 9000 });
  return { elapsedMs: performance.now() - started, proof: JSON.parse(result.stdout.trim()) };
}

test('[N09] graceful owned Cloudflare child exit leaves no orphan five-second deadline', async t => {
  const { elapsedMs, proof } = await cleanup(t, 'graceful');
  assert.equal(proof.startFailed, false); assert.equal(proof.signalCode, 'SIGTERM');
  assert.ok(elapsedMs < 2000, `isolated cleanup process retained a deadline for ${Math.round(elapsedMs)} ms`);
  console.log(JSON.stringify({ proof: 'isolated-owned-child', mode: 'graceful', processDurationMs: Math.round(elapsedMs), childExitConfirmed: true }));
});

test('[N09] failed Cloudflare spawn closes without waiting for a nonexistent child exit', async t => {
  const { elapsedMs, proof } = await cleanup(t, 'missing');
  assert.equal(proof.startFailed, true); assert.equal(proof.hasChildPid, false);
  assert.ok(elapsedMs < 2000, `missing child cleanup waited ${Math.round(elapsedMs)} ms`);
});

test('[N09] an owned Cloudflare child ignoring SIGTERM is killed and its actual exit awaited', async t => {
  const { elapsedMs, proof } = await cleanup(t, 'ignore-term');
  assert.equal(proof.signalCode, 'SIGKILL');
  assert.ok(elapsedMs >= 4900 && elapsedMs < 8000);
  console.log(JSON.stringify({ proof: 'isolated-owned-child', mode: 'ignore-term', processDurationMs: Math.round(elapsedMs), childExitConfirmed: true }));
});
