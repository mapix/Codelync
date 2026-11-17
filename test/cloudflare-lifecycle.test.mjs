import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareAccess } from '../src/network/public-access.mjs';

test('Cloudflare lifecycle tracks only complete owned connection-slot events and survives network changes', async () => {
  const access = new CloudflareAccess({ binary: 'unused', upstream: 'http://127.0.0.1:1000', state: 'unused' });
  const events = /** @type {string[]} */ ([]); access.on('connected', () => events.push('connected')); access.on('reconnecting', () => events.push('reconnecting'));
  access.observeStderr('INF Registered tunnel con');
  assert.deepEqual(events, []);
  access.observeStderr('nection connIndex=0\nINF Registered tunnel connection connIndex=1\n');
  assert.deepEqual(events, ['connected']);
  access.observeStderr('ERR failed to serve tunnel connection error="timeout" connIndex=0\n');
  assert.deepEqual(events, ['connected']);
  access.observeStderr('ERR failed to serve tunnel connection error="timeout" connIndex=1\n');
  assert.deepEqual(events, ['connected', 'reconnecting']);
  access.observeStderr('ERR failed to serve tunnel connection error="timeout" connIndex=1\nINF Registered tunnel connection connIndex=3\n');
  assert.deepEqual(events, ['connected', 'reconnecting', 'connected']);
  access.observeStderr('ERR unrelated message connIndex=3\nINF Registered tunnel connection connIndex=10\n');
  assert.equal(access.edgeConnections.size, 1);
  access.observeStderr('x'.repeat(100000)); assert.ok(access.stderrTail.length <= 16384);
  await access.close(); access.observeStderr('\nERR Connection terminated connIndex=3\n');
  assert.deepEqual(events, ['connected', 'reconnecting', 'connected']);
});
