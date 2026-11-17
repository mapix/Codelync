import { fetchCodelyncSessionPages, mergeCodelyncCatalog } from './codelyncSessionPages';

export interface CodelyncEncryptedMessage { id: string; seq: number; [key: string]: unknown }
export interface CodelyncBackgroundCache {
    scope: string;
    updatedAt: number;
    catalogWatermark?: number;
    peerCatalogCiphertext?: string;
    sessions: unknown[];
    selected: string[];
    messages: Record<string, { seq: number; records: CodelyncEncryptedMessage[] }>;
}

/** Read-only headless work. Cursor changes commit with their ciphertext, under the same account fence. */
export async function refreshCodelyncBackground(options: {
    origin: string; token: string; scope: string; cache: CodelyncBackgroundCache;
    request?: typeof fetch; signal?: AbortSignal; stillCurrent: () => Promise<boolean>;
    commit: (cache: CodelyncBackgroundCache) => void;
}) {
    const request = options.request ?? fetch;
    if (options.cache.scope !== options.scope) throw Error('Background cache identity mismatch');
    if (!await options.stillCurrent()) return false;
    const headers = { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' };
    const page = await fetchCodelyncSessionPages(options.origin, headers, request, options.signal, undefined, { changedSince: options.cache.catalogWatermark });
    const sessions = mergeCodelyncCatalog(options.cache.sessions, page.sessions);
    const ids = new Set(sessions.map(s => (s as { id: string }).id));
    const next = JSON.parse(JSON.stringify(options.cache)) as CodelyncBackgroundCache;
    next.sessions = sessions;
    next.catalogWatermark = page.watermark;
    for (const id of next.selected.slice(0, 1)) {
        if (!ids.has(id)) { delete next.messages[id]; continue; }
        if (!await options.stillCurrent()) return false;
        let cursor = next.messages[id]?.seq;
        const records = new Map((next.messages[id]?.records ?? []).map(m => [m.id, m]));
        for (let batch = 0; batch < 1; batch++) {
            const url = new URL(`/v3/sessions/${encodeURIComponent(id)}/messages`, options.origin);
            url.searchParams.set(cursor === undefined ? 'before_seq' : 'after_seq', String(cursor ?? Number.MAX_SAFE_INTEGER));
            url.searchParams.set('limit', '50');
            const response = await request(url.toString(), { headers, signal: options.signal });
            if (!response.ok) throw Error(`Background session read failed: ${response.status}`);
            const data = await response.json() as { messages: CodelyncEncryptedMessage[]; hasMore?: boolean };
            if (!Array.isArray(data.messages) || data.messages.some(m => typeof m.id !== 'string' || !Number.isSafeInteger(m.seq))) throw Error('Invalid background message page');
            const prior = cursor;
            for (const message of data.messages) { records.set(message.id, message); cursor = Math.max(cursor ?? 0, message.seq); }
            // First read is the latest page; historical backfill belongs to the foreground owner.
            if (prior === undefined || !data.hasMore || cursor === prior) break;
        }
        next.messages[id] = { seq: cursor ?? 0, records: [...records.values()].sort((a, b) => a.seq - b.seq).slice(-400) };
    }
    if (!await options.stillCurrent()) return false;
    next.updatedAt = Date.now(); options.commit(next); return true;
}
