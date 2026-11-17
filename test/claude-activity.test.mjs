import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeActivityObserver } from '../src/adapters/claude-activity.mjs';
import { NativeProjectActivityService } from '../src/codelync/project-activity.mjs';

/** @typedef {Record<string,any>} Value */
test('Claude foreground activity shares bounded header reads and never opens transcripts', async () => {
  const hostId = 'local:claude-desktop:' + 'a'.repeat(64); let now = 10000, calls = 0, owner = 'owner';
  const rows = ['idle', 'running', 'waiting', 'unknown'].map((nativeStatus, index) => ({ id: String(index), hostId, nativeStatus, runtimeGeneration: owner }));
  const backend = { hostId: () => hostId, generation: () => owner, list: async (/** @type {Value} */ context) => { calls++; assert.equal(context.expectedHostId, hostId); return rows; },
    snapshot: () => { throw Error('Status must not load selected messages'); } };
  const observers = rows.map(row => new ClaudeActivityObserver({ id: row.id, backend, expectedHostId: hostId, now: () => now }));
  try {
    await Promise.all(observers.map(observer => observer.refresh())); assert.equal(calls, 1);
    assert.deepEqual(observers.map(observer => [observer.status().known, observer.status().active, observer.status().waiting]), [[true, false, false], [true, true, false], [true, true, true], [false, false, false]]);
    now += 5001; assert.equal(observers[0].status().known, false);
    await observers[0].refresh(); assert.equal(calls, 2); assert.equal(observers[0].status().known, true);
    owner = 'new-owner'; assert.equal(observers[0].status().known, false);
    await observers[0].refresh(); assert.equal(observers[0].status().known, false);
  } finally { for (const observer of observers) observer.close(); }
});

test('late Claude header reads cannot restore closed activity or a foreign namespace', async () => {
  const hostId = 'local:claude-desktop:' + 'a'.repeat(64); let host = hostId;
  let resolve = /** @type {(rows:Value[])=>void} */ (() => {});
  const backend = { hostId: () => host, generation: () => 'owner', list: () => new Promise(finish => { resolve = finish; }) };
  const observer = new ClaudeActivityObserver({ id: 'native', backend, expectedHostId: hostId });
  const reading = observer.refresh(); await Promise.resolve(); observer.close(); host = 'foreign';
  resolve([{ id: 'native', hostId, nativeStatus: 'running', runtimeGeneration: 'owner' }]); await reading;
  assert.equal(observer.status().known, false); assert.equal(observer.status().active, false);
});

test('late and reused Claude headers preserve their read-start age instead of renewing running state', async () => {
  const hostId = 'local:claude-desktop:' + 'a'.repeat(64); let now = 10000;
  let finish = /** @type {(rows:Value[])=>void} */ (() => {});
  const rows = [{ id: 'native', hostId, nativeStatus: 'running', runtimeGeneration: 'owner' }];
  const backend = { hostId: () => hostId, generation: () => 'owner', list: () => new Promise(resolve => { finish = resolve; }) };
  const observer = new ClaudeActivityObserver({ id: 'native', backend, expectedHostId: hostId, now: () => now });
  try {
    const reading = observer.refresh(); await Promise.resolve(); now += 6000; finish(rows); await reading;
    assert.equal(observer.status().observedAt, 10000); assert.equal(observer.status().known, false); assert.equal(observer.status().active, false);
    const fresh = observer.refresh(); await Promise.resolve(); finish(rows); await fresh;
    assert.equal(observer.status().known, true); assert.equal(observer.status().observedAt, 16000);
    now += 500; await observer.refresh(); assert.equal(observer.status().observedAt, 16000);
    now += 4501; assert.equal(observer.status().known, false);
  } finally { observer.close(); }
});

test('Claude project activity uses its original headers and never constructs Codex IPC', async () => {
  const hostId = 'local:claude-desktop:' + 'a'.repeat(64), source = { app: 'claude-desktop', kind: 'session', id: 'native', hostId, relayId: 'phone',
    protocol: 'claude-desktop-native', runtimeGeneration: 'owner', appMode: 'chat', nativeCollection: 'local-agent-mode-sessions', workspace: '/project', nativeStatus: 'running' };
  let reads = 0, ipc = 0;
  const backend = { hostId: () => hostId, generation: () => 'owner', list: async () => { reads++; return [source]; } };
  const service = new NativeProjectActivityService({ sources: () => [source], inventoryAvailable: () => true, nativeAdapter: () => backend,
    ipcFactory: () => { ipc++; throw Error('A Claude ID cannot become a Codex source'); } });
  const request = { clientId: 'phone', requestSeq: 1, groups: [{ id: 'project', projectKey: '/project', hostId, app: 'claude-desktop', sessions: [{ id: 'phone', nativeId: 'native' }] }] };
  try {
    const cold = service.poll(request); assert.equal(cold.groups[0].unknown, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    const ready = service.poll({ ...request, requestSeq: 2 }); assert.equal(ready.groups[0].active, 1); assert.equal(ready.groups[0].unknown, 0);
    assert.equal(reads, 1); assert.equal(ipc, 0);
  } finally { service.close(); }
});

test('header cache binds runtime generation on a stable host and shares the epoch refresh', async () => {
  let now = 10000, generation = 'main-one', reads = 0, epochReads = 0;
  const hostId = 'same-host', owner = 'same-owner', backend = { hostId: () => hostId, generation: (/** @type {string|undefined} */ id) => id === undefined ? generation : owner,
    rpc: { runtime: async () => { epochReads++; return { generation }; } },
    list: async () => { reads++; return [{ id: 'one', hostId, runtimeGeneration: owner, nativeStatus: 'running', nativeActivityObservedAt: now - 100 }]; } };
  const a = new ClaudeActivityObserver({ id: 'one', backend, expectedHostId: hostId, now: () => now }), b = new ClaudeActivityObserver({ id: 'one', backend, expectedHostId: hostId, now: () => now });
  try { await Promise.all([a.refresh(), b.refresh()]); assert.equal(reads, 1); assert.equal(epochReads, 1); assert.equal(a.status().observedAt, 9900);
    now += 500; generation = 'main-two'; await a.refresh(); assert.equal(reads, 2); assert.equal(a.status().observedAt, 10400);
  } finally { a.close(); b.close(); }
});

test('late header flight cannot cross a runtime change even when host and session owner look unchanged', async () => {
  let generation = 'main-one'; const hostId = 'same-host'; let finish = /** @type {(rows:Value[])=>void} */ (() => {});
  const backend = { hostId: () => hostId, generation: (/** @type {string|undefined} */ id) => id === undefined ? generation : 'same-owner', list: () => new Promise(resolve => { finish = resolve; }) };
  const observer = new ClaudeActivityObserver({ id: 'one', backend, expectedHostId: hostId });
  try { const reading = observer.refresh(); await Promise.resolve(); generation = 'main-two'; finish([{ id: 'one', hostId, runtimeGeneration: 'same-owner', nativeStatus: 'running' }]); await reading;
    assert.equal(observer.status().known, false);
  } finally { observer.close(); }
});

test('Claude header capture one second after intrinsic timer start refreshes at capture plus three seconds before TTL', async () => {
  const hostId = 'local:claude-desktop:' + 'a'.repeat(64);
  const source = { app: 'claude-desktop', kind: 'session', id: 'native', hostId, relayId: 'phone',
    protocol: 'claude-desktop-native', runtimeGeneration: 'session-owner', appMode: 'chat', nativeCollection: 'local-agent-mode-sessions', workspace: '/project' };
  let now = 0, reads = 0, fail = false;
  const backend = { hostId: () => hostId, generation: (/** @type {string|undefined} */ id) => id ? 'session-owner' : 'main-owner',
    list: async () => { reads++; if (fail) throw Error('Header read failed'); return [{ ...source, nativeStatus: 'running', nativeActivityObservedAt: now }]; },
    snapshot: () => { throw Error('Header freshness must not load messages'); } };
  const service = new NativeProjectActivityService({ sources: () => [source], inventoryAvailable: () => true, nativeAdapter: () => backend,
    now: () => now, backgroundSources: 1, intrinsicRefreshMs: 5000 });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    service.intrinsicRefresh(); now = 1000; await settle();
    const observer = service.entries.values().next().value?.observer; assert.ok(observer);
    assert.equal(reads, 1); assert.equal(observer.status().observedAt, 1000); assert.equal(observer.refreshDueAt(), 4000);
    now = 3999; service.pump(); await settle(); assert.equal(reads, 1);
    now = 4000; service.pump(); await settle(); assert.equal(reads, 2);
    assert.equal(observer.status().known, true); assert.equal(observer.status().observedAt, 4000); assert.equal(observer.refreshDueAt(), 7000);
    now = 6000; assert.equal(observer.status().known, true); assert.equal(observer.status().observedAt, 4000);
    assert.equal(service.cachedSourceStatus(source)?.known, true);
    fail = true; now = 7000; service.pump(); await settle();
    assert.equal(reads, 3); assert.equal(observer.status().known, false); assert.equal(observer.status().observedAt, 4000);
    assert.equal(observer.refreshDueAt(), null); service.pump(); await settle(); assert.equal(reads, 3);
  } finally { service.close(); }
});

test('Claude header deadlines do not renew capture age or borrow scope during an inflight read, owner change or close', async () => {
  const hostId = 'local:claude-desktop:' + 'b'.repeat(64);
  let now = 1000, host = hostId, main = 'main-one', owner = 'session-one', reads = 0, held = false;
  let finish = /** @type {(rows:Value[])=>void} */ (() => {});
  const rows = () => [{ id: 'native', hostId, runtimeGeneration: owner, nativeStatus: 'running' }];
  const backend = { hostId: () => host, generation: (/** @type {string|undefined} */ id) => id ? owner : main,
    list: async () => { reads++; return held ? new Promise(resolve => { finish = resolve; }) : rows(); } };
  const observer = new ClaudeActivityObserver({ id: 'native', backend, expectedHostId: hostId, now: () => now });
  try {
    assert.equal(observer.refreshDueAt(), null); await observer.refresh();
    assert.equal(observer.refreshDueAt(), 4000); now = 3500;
    assert.equal(observer.refreshDueAt(), 4000); assert.equal(observer.status().observedAt, 1000);
    now = 4000; held = true; const reading = observer.refresh(); await Promise.resolve();
    assert.equal(observer.status().known, true); assert.equal(observer.refreshDueAt(), null); assert.equal(observer.status().observedAt, 1000);
    finish(rows()); await reading; assert.equal(observer.status().observedAt, 4000); assert.equal(observer.refreshDueAt(), 7000);
    main = 'main-two'; assert.equal(observer.status().known, false); assert.equal(observer.refreshDueAt(), null);
    main = 'main-one'; owner = 'session-two'; assert.equal(observer.status().known, false); assert.equal(observer.refreshDueAt(), null);
    owner = 'session-one'; host = 'foreign-host'; assert.equal(observer.status().known, false); assert.equal(observer.refreshDueAt(), null);
    host = hostId; now = 9000; assert.equal(observer.status().known, false); assert.equal(observer.refreshDueAt(), null);
    observer.close(); assert.equal(observer.refreshDueAt(), null); assert.equal(reads, 2);
  } finally { observer.close(); }
});
