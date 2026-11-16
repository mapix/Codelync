import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeActivityTransport } from '../src/happy/activity-transport.mjs';
import { BridgeError } from '../src/errors.mjs';
/** @typedef {Record<string,any>} Value */

function fixture(options = {}) {
  let now = 1000, sequence = 0;
  const reads = /** @type {Value[]} */ ([]), orders = new Map();
  const states = new Map([['one', { known: true, active: false }], ['two', { known: true, active: false }]]);
  const transport = new NativeActivityTransport({ now: () => now, ttlMs: 1000, machineId: () => 'machine', ...options,
    poll: request => {
      const old = orders.get(request.clientId); if (old > request.requestSeq) throw new BridgeError('stale-activity-interest', 'stale', 409);
      orders.set(request.clientId, request.requestSeq); reads.push(request);
      return { ok: true, version: 1, epoch: 'owner', sequence: ++sequence, observedAt: now, privateOwnerState: 'excluded', groups: request.groups.map((/** @type {Value} */ group) => {
        const state = states.get(group.id) ?? { known: false, active: false };
        return { id: group.id, total: 1, active: Number(state.active), waiting: 0, unknown: Number(!state.known),
          status: state.known ? 'ready' : 'unavailable', observedAt: now, privateConversation: 'excluded',
          sessions: [{ id: group.id + '-row', ...state, waiting: false, message: 'excluded' }] };
      }) };
    } });
  return { transport, reads, states, clock: (/** @type {number} */ value) => { now = value; } };
}
const groups = [{ id: 'one', projectKey: '/one', hostId: 'local' }, { id: 'two', projectKey: '/two', hostId: 'local' }];
const initial = { clientId: 'viewer', requestSeq: 1, activityProtocol: 2, groups };

test('stable activity transmits no repeated descriptors or group data and does not include future private fields', () => {
  const f = fixture(), first = f.transport.request('device', initial);
  assert.equal(first.mode, 'full'); assert.equal(first.groups.length, 2);
  f.clock(1100);
  const input = { clientId: 'viewer', requestSeq: 2, activityProtocol: 2, interestToken: first.interestToken, since: first.watermark };
  const next = f.transport.request('device', input);
  assert.equal(next.mode, 'unchanged'); assert.deepEqual(next.groups, []); assert.equal(next.watermark, first.watermark);
  assert.equal(next.baseWatermark, first.watermark); assert.ok(next.sequence > first.sequence); assert.equal(next.observedAt, 1100);
  assert.equal(f.reads[1].groups.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(next)) < 430); assert.ok(Buffer.byteLength(JSON.stringify(input)) < 230);
  assert.equal(JSON.stringify(first).includes('excluded'), false);
});

test('only a changed group is returned and unknown state is retained without a fabricated idle result', () => {
  const f = fixture(), first = f.transport.request('device', initial);
  f.states.set('two', { known: false, active: false });
  const next = f.transport.request('device', { clientId: 'viewer', requestSeq: 2, activityProtocol: 2,
    interestToken: first.interestToken, since: first.watermark });
  assert.equal(next.mode, 'delta'); assert.equal(next.groups.length, 1); assert.equal(next.groups[0].id, 'two');
  assert.equal(next.groups[0].unknown, 1); assert.equal(next.groups[0].sessions[0].known, false);
  assert.notEqual(next.watermark, first.watermark);
});

test('different devices and clients cannot consume another interest token or overwrite their sequence', () => {
  const f = fixture(), first = f.transport.request('device-A', initial);
  const next = { clientId: 'viewer', requestSeq: 2, activityProtocol: 2, interestToken: first.interestToken, since: first.watermark };
  assert.throws(() => f.transport.request('device-B', next), { code: 'stale-activity-interest' });
  assert.throws(() => f.transport.request('device-A', { ...next, clientId: 'other' }), { code: 'stale-activity-interest' });
  f.transport.request('device-B', initial);
  assert.notEqual(f.reads[0].clientId, f.reads[1].clientId);
  f.transport.request('device-A', next);
  assert.throws(() => f.transport.request('device-A', { ...initial, requestSeq: 0 }), { code: 'stale-activity-interest' });
});

test('expired interests and evicted clients require bounded descriptors again, while legacy callers remain version 1', () => {
  const f = fixture({ maxClients: 1 }), first = f.transport.request('device', initial);
  f.clock(2000);
  assert.throws(() => f.transport.request('device', { clientId: 'viewer', requestSeq: 2, activityProtocol: 2, interestToken: first.interestToken }), { code: 'stale-activity-interest' });
  const renewed = f.transport.request('device', { ...initial, requestSeq: 2 });
  f.transport.request('other-device', initial);
  assert.throws(() => f.transport.request('device', { clientId: 'viewer', requestSeq: 3, activityProtocol: 2, interestToken: renewed.interestToken }), { code: 'stale-activity-interest' });
  const legacy = f.transport.request('device', { clientId: 'viewer', requestSeq: 3, groups });
  assert.equal(legacy.version, 1); assert.equal(legacy.mode, undefined); f.transport.close(); assert.equal(f.transport.clients.size, 0);
});

test('changed interest and stale watermarks establish a complete current projection without borrowing old groups', () => {
  const f = fixture(), first = f.transport.request('device', initial);
  const next = f.transport.request('device', { ...initial, requestSeq: 2, groups: [groups[1]], since: first.watermark });
  assert.equal(next.mode, 'full'); assert.equal(next.groups.length, 1); assert.notEqual(next.interestToken, first.interestToken);
  const stale = f.transport.request('device', { clientId: 'viewer', requestSeq: 3, activityProtocol: 2, interestToken: next.interestToken, since: first.watermark });
  assert.equal(stale.mode, 'full'); assert.equal(stale.baseWatermark, null);
});

test('malformed and oversized transport input is rejected before the activity producer is invoked', () => {
  const f = fixture();
  for (const input of [{ ...initial, requestSeq: -1 }, { ...initial, body: 'unexpected' }, { ...initial, activityProtocol: 3 },
    { ...initial, since: 'x'.repeat(513) }, { ...initial, groups: ['x'.repeat(256 * 1024)] }]) {
    assert.throws(() => f.transport.request('device', input), { code: 'invalid-activity-interest' });
  }
  assert.equal(f.reads.length, 0);
});
