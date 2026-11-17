import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceRegistry } from '../src/codelync/source-registry.mjs';
/** @typedef {Record<string,any>} Value */

/** @param {import('node:test').TestContext} t @param {boolean|undefined} available */
async function fixture(t, available) {
  const directory = await mkdtemp(join(tmpdir(), 'codelync-source-metadata-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = { app: 'codex', hostId: 'local', id: 'fixture-native', kind: 'session', runtimeGeneration: 'fixture-owner' };
  const metadata = /** @type {Value} */ ({ client: { id: 'noninvasive-bridge' }, nativeSession: { archived: true, ...(available === undefined ? {} : { catalogueAvailable: available }) },
    bridge: { source, controlMode: 'session', sourceStatus: 'connected', currentTurnId: 'fixture-turn' },
    capabilities: { steering: true, send: true, abort: true, modelSelection: true, rpcMethods: ['abort'], files: { write: true } } });
  const binding = { source, metadata, metadataVersion: 1, happySessionId: 'fixture-relay', sessionKey: randomBytes(32).toString('base64'), bindingPath: join(directory, 'binding.json') };
  const registry = new SourceRegistry({ directory, account: { serverUrl: 'http://127.0.0.1:9', token: 'fixture-token', secret: randomBytes(32).toString('base64url') } });
  let writes = 0;
  const socket = { timeout: () => ({ emitWithAck: async (/** @type {string} */ _method, /** @type {Value} */ body) => { writes++; return { result: 'success', version: body.expectedVersion + 1, metadata: body.metadata }; } }) };
  return { binding, registry, socket, writes: () => writes };
}

test('local source disable turns off controls while preserving original archive, identity and visibility evidence', async t => {
  const f = await fixture(t, true), source = { ...f.binding.source };
  await f.registry.markDisabled(f.binding, /** @type {any} */ (f.socket));
  assert.equal(f.binding.metadata.nativeSession.archived, true); assert.equal(f.binding.metadata.nativeSession.catalogueAvailable, false);
  assert.equal(f.binding.metadata.nativeSession.sourceDisabledCatalogueAvailable, true); assert.deepEqual(f.binding.source, source);
  assert.equal(f.binding.metadata.capabilities.steering, false); assert.equal(f.binding.metadata.capabilities.abort, false); assert.deepEqual(f.binding.metadata.capabilities.rpcMethods, []);
  await f.registry.markDisabled(f.binding, /** @type {any} */ (f.socket)); assert.equal(f.writes(), 1);
  await f.registry.markEnabled(f.binding, /** @type {any} */ (f.socket));
  assert.equal(f.binding.metadata.nativeSession.catalogueAvailable, true); assert.equal(f.binding.metadata.nativeSession.archived, true);
  assert.equal(f.binding.metadata.capabilities.steering, false); assert.equal(f.binding.metadata.bridge.sourceStatus, 'disconnected');
});

test('re-enable cannot resurrect a previously absent catalog entry or invent a missing visibility field', async t => {
  for (const available of [false, undefined]) {
    const f = await fixture(t, available);
    await f.registry.markDisabled(f.binding, /** @type {any} */ (f.socket)); await f.registry.markEnabled(f.binding, /** @type {any} */ (f.socket));
    if (available === false) assert.equal(f.binding.metadata.nativeSession.catalogueAvailable, false);
    else assert.equal(Object.hasOwn(f.binding.metadata.nativeSession, 'catalogueAvailable'), false);
    assert.equal(f.binding.metadata.nativeSession.archived, true); assert.equal(f.binding.metadata.capabilities.steering, false);
  }
});
