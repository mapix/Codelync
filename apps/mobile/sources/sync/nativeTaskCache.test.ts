import { expect, it, vi } from 'vitest';
import { NativeTaskCache, type NativeTaskCacheContext } from './nativeTaskCache';
import type { NativeTasks } from './nativeTasks';
const digest = (letter: string) => letter.repeat(64);
const context = (sessionId = 'parent', desiredDigest: string | null = digest('a')): NativeTaskCacheContext => ({ peerId: 'peer:A', sessionId, desiredDigest,
    scope: { app: 'claude-desktop', nativeCollection: 'claude-code-sessions', hostId: 'local:claude-desktop:' + digest('a'), parentConversationId: sessionId,
        ownerGeneration: 'owner', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli' } });
const full = (value: NativeTaskCacheContext): NativeTasks => ({ version: 1, scope: { ...value.scope }, digest: value.desiredDigest ?? undefined,
    tasks: [], tasksAvailable: true, tasksComplete: false, tasksTruncated: false, backgroundTasksComplete: false, partial: true,
    dispatchChildren: [], dispatchChildrenAvailable: false, dispatchChildrenComplete: false, dispatchChildrenTruncated: false });
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const apply = (_baseline: NativeTasks | null, reply: unknown) => reply as NativeTasks;

it('starts no collapsed/background read and coalesces two independent expanded consumers', async () => {
    let finish!: (reply: NativeTasks) => void;
    const read = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const cache = new NativeTaskCache({ read, apply, current: () => true }), value = context(), first = Symbol(), second = Symbol();
    cache.retain(first, value, false); await tick(); expect(read).not.toHaveBeenCalled();
    cache.retain(first, value, true); cache.retain(second, value, true); await tick(); expect(read).toHaveBeenCalledOnce();
    cache.release(first); finish(full(value)); await tick(); expect(cache.get(value).native?.digest).toBe(value.desiredDigest);
    cache.retain(second, value, true); await tick(); expect(read).toHaveBeenCalledOnce();
});
it('rejects late desired-signal replies and fetches the latest demand once after the old scope flight settles', async () => {
    const finishes: Array<(reply: NativeTasks) => void> = [], materialize = vi.fn(apply);
    const read = vi.fn().mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    let desired = digest('a'); const cache = new NativeTaskCache({ read, apply: materialize, current: value => value.desiredDigest === desired });
    const consumer = Symbol(), a = context(), b = context('parent', digest('b'));
    cache.retain(consumer, a, true); await tick(); desired = b.desiredDigest!; cache.retain(consumer, b, true);
    finishes[0](full(a)); await tick(); expect(materialize).not.toHaveBeenCalled(); expect(cache.get(b).native).toBeNull(); expect(read).toHaveBeenCalledTimes(2);
    finishes[1](full(b)); await tick(); expect(cache.get(b).native?.digest).toBe(b.desiredDigest); expect(materialize).toHaveBeenCalledOnce();
});
it('uses the accepted full digest as a baseline and never publishes a malformed partial update', async () => {
    const a = context(), b = context('parent', digest('b')), consumer = Symbol();
    const read = vi.fn().mockResolvedValueOnce(full(a)).mockResolvedValueOnce({ invalidDelta: true }).mockResolvedValueOnce(full(b));
    const cache = new NativeTaskCache({ read, current: () => true, apply: (_base, reply) => { if ((reply as any).invalidDelta) throw Error('Invalid delta'); return reply as NativeTasks; } });
    cache.retain(consumer, a, true); await tick(); cache.retain(consumer, b, true); await tick();
    expect(read.mock.calls[1][1]).toBe(a.desiredDigest); expect(cache.get(b)).toMatchObject({ native: null, failed: true });
    cache.retain(consumer, b, true); await tick(); expect(read).toHaveBeenCalledTimes(2);
    cache.retry(b); await tick(); expect(read.mock.calls[2][1]).toBe(a.desiredDigest); expect(cache.get(b).native?.digest).toBe(b.desiredDigest);
});
it('does not publish after all consumers collapse and can read again after explicit re-expansion', async () => {
    const finishes: Array<(reply: NativeTasks) => void> = [], read = vi.fn().mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    const cache = new NativeTaskCache({ read, apply, current: () => true }), value = context(), consumer = Symbol();
    cache.retain(consumer, value, true); await tick(); cache.retain(consumer, value, false); finishes[0](full(value)); await tick();
    expect(cache.get(value).native).toBeNull(); cache.retain(consumer, value, true); await tick(); expect(read).toHaveBeenCalledTimes(2);
    finishes[1](full(value)); await tick(); expect(cache.get(value).native).not.toBeNull();
});
it('partitions peers and scopes and refuses a late prior-peer response', async () => {
    const finishes: Array<(reply: NativeTasks) => void> = [], read = vi.fn().mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    let peer = 'peer:A'; const cache = new NativeTaskCache({ read, apply, current: value => value.peerId === peer });
    const a = context(), b = { ...context(), peerId: 'peer:B' }, consumer = Symbol();
    cache.retain(consumer, a, true); await tick(); peer = 'peer:B'; cache.retain(consumer, b, true); await tick();
    finishes[0](full(a)); finishes[1](full(b)); await tick(); expect(cache.get(a).native).toBeNull(); expect(cache.get(b).native).not.toBeNull();
    const foreign = { ...b, scope: { ...b.scope, cliSessionId: 'another-cli' } }; expect(cache.get(foreign).native).toBeNull();
});
it('bounds LRU entries and pending reads and an evicted response cannot reinsert old data', async () => {
    const finishes: Array<(reply: NativeTasks) => void> = [], read = vi.fn().mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    const cache = new NativeTaskCache({ read, apply, current: () => true, maxEntries: 2 });
    const a = context('a'), b = context('b'), c = context('c');
    cache.retain(Symbol(), a, true); cache.retain(Symbol(), b, true); await tick(); cache.retain(Symbol(), c, true); await tick();
    expect(cache.size).toBe(2); expect(cache.inFlightCount).toBe(2); expect(read).toHaveBeenCalledTimes(2);
    finishes[0](full(a)); await tick(); expect(read).toHaveBeenCalledTimes(3); expect(cache.size).toBe(2); expect(cache.get(a).native).toBeNull();
    finishes[1](full(b)); finishes[2](full(c)); await tick(); expect(cache.get(c).native).not.toBeNull();
});
it('keeps a digestless legacy full only as a full-read result, never a delta baseline', async () => {
    const value = context('legacy', null), read = vi.fn().mockResolvedValue(full(value)), cache = new NativeTaskCache({ read, apply, current: () => true });
    cache.retain(Symbol(), value, true); await tick(); expect(read.mock.calls[0][1]).toBeUndefined(); expect(cache.get(value).native).not.toBeNull();
    cache.retry(value); await tick(); expect(read.mock.calls[1][1]).toBeUndefined();
});
it('caches a future verified target without promotion or polling until its matching signal arrives', async () => {
    const a = context(), b = context('parent', digest('b')), read = vi.fn().mockResolvedValue(full(b));
    const cache = new NativeTaskCache({ read, apply, current: () => true }), consumer = Symbol();
    cache.retain(consumer, a, true); await tick(); expect(cache.get(a).native).toBeNull(); expect(cache.get(a).failed).toBe(false);
    cache.retain(consumer, a, true); await tick(); expect(read).toHaveBeenCalledOnce();
    cache.retain(consumer, b, true); await tick(); expect(cache.get(b).native?.digest).toBe(b.desiredDigest); expect(read).toHaveBeenCalledOnce();
});
it('does not let late D1 block a newer D2 demand captured during the D0 request', async () => {
    const d0 = context('parent', digest('a')), d1 = context('parent', digest('b')), d2 = context('parent', digest('c'));
    const finishes: Array<(value: NativeTasks) => void> = [], read = vi.fn().mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    const cache = new NativeTaskCache({ read, apply, current: () => true }), consumer = Symbol();
    cache.retain(consumer, d0, true); await tick(); cache.retain(consumer, d2, true);
    finishes[0](full(d1)); await tick(); expect(cache.get(d2).native).toBeNull(); expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]).toEqual([d2, d1.desiredDigest]);
    finishes[1](full(d2)); await tick(); expect(cache.get(d2).native?.digest).toBe(d2.desiredDigest);
});
it('rechecks source authority after asynchronous digest verification completes', async () => {
    const value = context(); let current = true, finish!: (v: NativeTasks) => void;
    const cache = new NativeTaskCache({ read: async () => full(value), current: () => current, apply: () => new Promise(resolve => { finish = resolve; }) });
    cache.retain(Symbol(), value, true); await tick(); current = false; finish(full(value)); await tick(); expect(cache.get(value).native).toBeNull();
});
it('counts exact UTF8 cache bytes and keeps the old baseline when a Unicode update exceeds its budget', async () => {
    const a = context(), b = context('parent', digest('b'));
    const ascii = full(a), unicode = full(b);
    const tasks = (name: string) => Array.from({ length: 3 }, (_, i) => ({ nativeTaskId: 'task-' + i, name, taskType: 'local_agent', kind: 'agent' as const, status: 'running' as const, isBackgrounded: false, statusSource: 'native-task-lifecycle' }));
    ascii.tasks = tasks('a'.repeat(160)); unicode.tasks = tasks('汉'.repeat(160));
    const bytes = new TextEncoder().encode(JSON.stringify({ context: a, native: ascii })).length;
    const read = vi.fn().mockResolvedValueOnce(ascii).mockResolvedValueOnce(unicode);
    const cache = new NativeTaskCache({ read, apply, current: () => true, maxBytes: bytes }), consumer = Symbol();
    cache.retain(consumer, a, true); await tick(); expect(cache.byteSize).toBe(bytes);
    cache.retain(consumer, b, true); await tick(); expect(cache.get(b)).toMatchObject({ native: null, failed: true }); expect(cache.byteSize).toBeLessThanOrEqual(bytes);
    expect(read.mock.calls[1][1]).toBe(a.desiredDigest);
});
it('does not allocate or evict for eight collapsed sources while the current selected snapshot is retained', async () => {
    const value = context(), read = vi.fn().mockResolvedValue(full(value)), cache = new NativeTaskCache({ read, apply, current: () => true });
    cache.retain(Symbol(), value, true); await tick();
    for (let i = 0; i < 8; i++) cache.retain(Symbol(), context('collapsed-' + i), false);
    await tick(); expect(cache.size).toBe(1); expect(cache.get(value).native).not.toBeNull(); expect(read).toHaveBeenCalledOnce();
});
it('does not promote an existing disabled entry in LRU order when its signal changes', async () => {
    const read = vi.fn(async (value: NativeTaskCacheContext) => full(value)), cache = new NativeTaskCache({ read, apply, current: () => true, maxEntries: 2 });
    const first = Symbol(), a = context('a'), b = context('b'), c = context('c');
    cache.retain(first, a, true); await tick(); cache.retain(Symbol(), b, true); await tick();
    cache.retain(first, { ...a, desiredDigest: digest('b') }, false); cache.retain(Symbol(), c, true); await tick();
    expect(cache.get(b).native).not.toBeNull(); expect(cache.get(a).native).toBeNull(); expect(read).toHaveBeenCalledTimes(3);
});
