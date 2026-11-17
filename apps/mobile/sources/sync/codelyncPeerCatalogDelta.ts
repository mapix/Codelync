import type { Session } from './storageTypes';
import type { PeerSessionDescriptor } from './codelyncRecent';
import { isCodelyncNativeSession } from '@/utils/codelyncSessionBrowser';

export interface NativeCatalogPage {
    version: 1 | 2; sessions: PeerSessionDescriptor[]; hasMore: boolean; nextCursor: string | null;
    mode?: 'full' | 'delta'; watermark?: string; baseWatermark?: string | null; removedIds?: string[]; machineIds?: string[];
}
/** One scan accumulates immutable snapshot pages. Only changed rows are
 * published; catalog removal never deletes messages, drafts or receipts. */
export class CodelyncPeerCatalogDelta {
    readonly catalog: Map<string, PeerSessionDescriptor>;
    private freshIds = new Set<string>();
    private removed = new Set<string>();
    private mode: 'full' | 'delta' | null = null;
    private watermark: string | null = null;
    private version: number | null = null;
    private pages = 0;
    private complete = false;
    private cursors = new Set<string>();
    private machines = new Set<string>();
    changed = 0;
    constructor(previous: PeerSessionDescriptor[], readonly since: string | null) {
        this.catalog = new Map(previous.map(row => [row.id, row]));
        for (const row of previous) if (row.metadata?.machineId) this.machines.add(row.metadata.machineId);
    }
    apply(raw: unknown): PeerSessionDescriptor[] {
        if (this.complete) throw Error('Native catalog scan already completed');
        const page = raw as NativeCatalogPage;
        if (!page || ![1, 2].includes(page.version) || !Array.isArray(page.sessions) || page.sessions.length > 2000 ||
            typeof page.hasMore !== 'boolean' || page.nextCursor !== null && typeof page.nextCursor !== 'string') throw Error('Invalid native catalog delta');
        if (page.hasMore ? !page.nextCursor || page.nextCursor.length > 2048 || this.cursors.has(page.nextCursor) : page.nextCursor !== null) {
            throw Error('Invalid native catalog page boundary');
        }
        const mode = page.version === 1 ? 'full' : page.mode;
        const watermark = page.version === 1 ? null : page.watermark;
        if (!['full', 'delta'].includes(mode ?? '') || page.version === 2 && (typeof watermark !== 'string' || !watermark || watermark.length > 512 ||
            mode === 'delta' && page.baseWatermark !== this.since || !Array.isArray(page.removedIds) || page.removedIds.length > 10000 ||
            page.removedIds.some(id => typeof id !== 'string' || !id || id.length > 200) || !Array.isArray(page.machineIds) || page.machineIds.length > 16 ||
            page.machineIds.some(id => typeof id !== 'string' || !id || id.length > 200))) throw Error('Invalid native catalog watermark');
        if (this.pages && (this.version !== page.version || this.mode !== mode || this.watermark !== watermark)) throw Error('Native catalog pagination changed snapshot');
        this.version = page.version; this.mode = mode!; this.watermark = watermark ?? null;
        if (page.version === 2) {
            if (!this.pages) this.machines = new Set(page.machineIds);
            else if (JSON.stringify([...this.machines].sort()) !== JSON.stringify([...(page.machineIds ?? [])].sort())) throw Error('Native catalog machine scope changed snapshot');
        }
        if (page.version === 2) for (const id of page.removedIds ?? []) { if (this.freshIds.has(id)) throw Error('Native catalog removed a changed source'); this.removed.add(id); }
        for (const row of page.sessions) {
            if (!row || typeof row.id !== 'string' || !row.id || this.freshIds.has(row.id) || this.removed.has(row.id)) throw Error('Duplicate or conflicting native catalog source');
            this.freshIds.add(row.id); this.catalog.set(row.id, row);
            if (page.version === 1 && row.metadata?.machineId) this.machines.add(row.metadata.machineId);
        }
        if (page.nextCursor) this.cursors.add(page.nextCursor);
        this.complete = !page.hasMore;
        this.pages++; this.changed += page.sessions.length; return page.sessions;
    }
    finish() {
        if (!this.pages || !this.complete) throw Error('The native catalog scan did not finish');
        if (this.mode === 'full') for (const id of this.catalog.keys()) if (!this.freshIds.has(id)) this.removed.add(id);
        for (const id of this.removed) this.catalog.delete(id);
        return { sessions: [...this.catalog.values()], removedIds: [...this.removed], watermark: this.watermark, full: this.mode === 'full', machineIds: [...this.machines],
            unchanged: this.mode === 'delta' && this.changed === 0 && this.removed.size === 0 && this.watermark === this.since };
    }
}

export function reconcileCodelyncCatalogSessions(sessions: Record<string, Session>, result: { sessions: PeerSessionDescriptor[]; removedIds: string[]; full: boolean; machineIds: string[] }): Session[] {
    const machines = new Set(result.machineIds), visible = new Set(result.sessions.map(row => row.id)), removed = new Set(result.removedIds);
    if (result.full) for (const session of Object.values(sessions)) if (session.metadata?.machineId && machines.has(session.metadata.machineId) && isCodelyncNativeSession(session) && !visible.has(session.id)) removed.add(session.id);
    return [...removed].flatMap(id => {
        const session = sessions[id]; if (!session?.metadata?.bridge || !session.metadata.nativeSession || session.metadata.nativeSession.catalogueAvailable === false) return [];
        if (!session.metadata.machineId || !machines.has(session.metadata.machineId)) return [];
        return [{ ...session, metadata: { ...session.metadata, nativeSession: { ...session.metadata.nativeSession, catalogueAvailable: false } } }];
    });
}
