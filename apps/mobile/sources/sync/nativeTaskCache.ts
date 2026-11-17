import { NativeTasksSchema, type NativeTasks, type NativeTaskScope, type NativeTaskSignal } from './nativeTasks';
import { nativeTaskScopesEqual } from '@/utils/codelyncNativeTasks';
import { nativeTaskSignal, NATIVE_TASK_SNAPSHOT_MAX_BYTES } from '@codelync/wire/native-tasks';

export type NativeTaskCacheContext = { peerId: string; sessionId: string; scope: NativeTaskScope; desiredDigest: string | null; signal?: NativeTaskSignal | null };
export type NativeTaskCacheView = Readonly<{ native: NativeTasks | null; loading: boolean; failed: boolean }>;
type Entry = { key: string; context: NativeTaskCacheContext; revision: number; attempted: number; full: NativeTasks | null;
    legacyLoaded: boolean; loading: boolean; failed: boolean; force: boolean; consumers: Map<symbol, boolean>; view: NativeTaskCacheView };
type Options = { read(context: NativeTaskCacheContext, since?: string): Promise<unknown>;
    apply(baseline: NativeTasks | null, reply: unknown, context: NativeTaskCacheContext): NativeTasks | Promise<NativeTasks>;
    current(context: NativeTaskCacheContext): boolean; maxEntries?: number; maxBytes?: number };
const EMPTY: NativeTaskCacheView = Object.freeze({ native: null, loading: false, failed: false });
export function nativeTaskCacheKey(context: NativeTaskCacheContext): string {
    const s = context.scope;
    return JSON.stringify([context.peerId, context.sessionId, s.app, s.nativeCollection, s.hostId, s.parentConversationId,
        s.ownerGeneration, s.runtimeGeneration, s.queryToken, s.cliSessionId]);
}

/** Bounded, ephemeral selected-parent snapshots. No storage, timer or model API. */
export class NativeTaskCache {
    private entries = new Map<string, Entry>();
    private listeners = new Map<string, Set<() => void>>();
    private flights = 0;
    private maximum: number;
    private maximumBytes: number;
    constructor(private readonly options: Options) {
        this.maximum = Number.isSafeInteger(options.maxEntries) && options.maxEntries! > 0 ? Math.min(options.maxEntries!, 8) : 8;
        this.maximumBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes! >= 1024 ? Math.min(options.maxBytes!, NATIVE_TASK_SNAPSHOT_MAX_BYTES) : NATIVE_TASK_SNAPSHOT_MAX_BYTES;
    }
    get size() { return this.entries.size; }
    get inFlightCount() { return this.flights; }
    private measure(entry: Entry, native = entry.full) { return new TextEncoder().encode(JSON.stringify({ context: entry.context, native })).length; }
    get byteSize() { return [...this.entries.values()].reduce((sum, entry) => sum + this.measure(entry), 0); }
    private fit(entry: Entry, protect = true) {
        if (this.measure(entry) > this.maximumBytes) { entry.full = null; entry.legacyLoaded = false; }
        if (this.measure(entry) > this.maximumBytes) { this.entries.delete(entry.key); this.emit(entry.key); return; }
        while (this.byteSize > this.maximumBytes) {
            const oldest = [...this.entries.keys()].find(key => !protect || key !== entry.key); if (!oldest) break;
            this.entries.delete(oldest); this.emit(oldest);
        }
    }
    subscribe(key: string, callback: () => void) {
        const listeners = this.listeners.get(key) ?? new Set<() => void>(); this.listeners.set(key, listeners); listeners.add(callback);
        return () => { listeners.delete(callback); if (!listeners.size) this.listeners.delete(key); };
    }
    private emit(key: string) { for (const listener of this.listeners.get(key) ?? []) { try { listener(); } catch { /* A closed view cannot block another consumer. */ } } }
    private signalMatches(entry: Entry) {
        if (!entry.context.signal || !entry.full?.digest) return true;
        const expected = nativeTaskSignal(entry.full), supplied = entry.context.signal as unknown as Record<string, unknown>;
        return Object.keys(expected).every(key => key === 'scope' ? nativeTaskScopesEqual(expected.scope, supplied.scope as NativeTaskScope) : expected[key] === supplied[key]);
    }
    private fresh(entry: Entry) { return entry.full !== null && (entry.context.desiredDigest !== null
        ? entry.full.digest === entry.context.desiredDigest && this.signalMatches(entry) : entry.legacyLoaded); }
    private publish(entry: Entry) {
        const native = this.fresh(entry) ? entry.full : null;
        if (entry.view.native === native && entry.view.loading === entry.loading && entry.view.failed === entry.failed) return;
        entry.view = Object.freeze({ native, loading: entry.loading, failed: entry.failed }); this.emit(entry.key);
    }
    get(context: NativeTaskCacheContext): NativeTaskCacheView {
        const entry = this.entries.get(nativeTaskCacheKey(context));
        return entry && entry.context.desiredDigest === context.desiredDigest && this.options.current(context) ? entry.view : EMPTY;
    }
    retain(consumer: symbol, context: NativeTaskCacheContext, enabled: boolean) {
        const key = nativeTaskCacheKey(context);
        for (const entry of this.entries.values()) if (entry.key !== key) entry.consumers.delete(consumer);
        let entry = this.entries.get(key);
        if (!entry && !enabled) return;
        if (!entry) {
            while (this.entries.size >= this.maximum) { const oldest = this.entries.keys().next().value!; this.entries.delete(oldest); this.emit(oldest); }
            entry = { key, context: { ...context, scope: { ...context.scope } }, revision: 0, attempted: -1,
                full: null, legacyLoaded: false, loading: false, failed: false, force: false, consumers: new Map(), view: EMPTY };
        } else {
            if (enabled) this.entries.delete(key);
            if (entry.context.desiredDigest !== context.desiredDigest) {
                entry.revision++; entry.failed = false;
            }
            entry.context = { ...context, scope: { ...context.scope } };
        }
        if (enabled || !this.entries.has(key)) this.entries.set(key, entry);
        entry.consumers.set(consumer, enabled); this.fit(entry, this.enabled(entry)); this.publish(entry); this.pump();
    }
    release(consumer: symbol) { for (const entry of this.entries.values()) entry.consumers.delete(consumer); }
    retry(context: NativeTaskCacheContext) {
        const entry = this.entries.get(nativeTaskCacheKey(context)); if (!entry || entry.context.desiredDigest !== context.desiredDigest) return;
        entry.revision++; entry.failed = false; entry.force = true; this.publish(entry); this.pump();
    }
    clear() { const keys = [...this.entries.keys()]; this.entries.clear(); for (const key of keys) this.emit(key); }
    private enabled(entry: Entry) { return [...entry.consumers.values()].some(Boolean); }
    private pump() {
        for (const entry of this.entries.values()) {
            if (this.flights >= this.maximum) break;
            if (entry.loading || this.fresh(entry) && !entry.failed && !entry.force || entry.attempted === entry.revision
                || !this.enabled(entry) || !this.options.current(entry.context)) continue;
            entry.loading = true; entry.failed = false; entry.force = false; entry.attempted = entry.revision; this.flights++; this.publish(entry);
            const context = { ...entry.context, scope: { ...entry.context.scope } }, revision = entry.revision, baseline = entry.full;
            const current = () => this.entries.get(entry.key) === entry && this.enabled(entry) && this.options.current(context);
            void Promise.resolve().then(() => {
                if (!current() || entry.revision !== revision) return null;
                return this.options.read(context, baseline?.digest);
            }).then(async reply => {
                if (!current() || reply === null) return;
                const next = NativeTasksSchema.parse(await this.options.apply(baseline, reply, context));
                if (!current()) return;
                if (!nativeTaskScopesEqual(next.scope, context.scope)) throw Error('Native task scope changed');
                if (entry.context.desiredDigest !== null && !next.digest) throw Error('Native task signal requires a verified digest');
                if (this.measure(entry, next) > this.maximumBytes) throw Error('Native task cache byte budget exceeded');
                entry.full = next; entry.legacyLoaded = true; entry.failed = false;
                // A future verified digest is a baseline only until its signal
                // arrives. An older requested digest cannot satisfy a new demand.
                if (next.digest === entry.context.desiredDigest || entry.revision === revision && next.digest !== context.desiredDigest) entry.attempted = entry.revision;
                this.fit(entry);
            }, () => { if (current()) entry.failed = true; }).catch(() => { if (current()) entry.failed = true; }).finally(() => {
                this.flights--; entry.loading = false;
                if (this.entries.get(entry.key) === entry && entry.revision === revision && !this.fresh(entry) && !entry.failed
                    && (!this.enabled(entry) || !this.options.current(context))) entry.attempted = -1;
                if (this.entries.get(entry.key) === entry) this.publish(entry);
                this.pump();
            });
        }
    }
}
