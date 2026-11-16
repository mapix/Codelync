import { expect, it } from 'vitest';
import { CodeLightPeerCatalogDelta, reconcileCodeLightCatalogSessions } from './codeLightPeerCatalogDelta';
import { isCodeLightNativeSession } from '@/utils/codeLightSessionBrowser';
import type { Session } from './storageTypes';
import type { PeerSessionDescriptor } from './codeLightRecent';

function session(id: string, machineId = 'machine'): Session {
    return { id, createdAt: 1, updatedAt: 100, activeAt: 0, seq: 0, active: false, presence: 0, metadataVersion: 1, agentStateVersion: 0,
        agentState: null, thinking: false, thinkingAt: 0, draft: 'keep-draft-' + id,
        metadata: { machineId, path: '/project', client: { id: 'noninvasive-bridge' }, bridge: { source: { app: 'codex', id: 'native-' + id, hostId: 'local', runtimeGeneration: 'owner', windowGeneration: null },
            controlMode: 'session', sourceStatus: 'connected' }, nativeSession: { title: id, updatedAt: 100, catalogueAvailable: true } } } as Session;
}
function descriptor(id: string): PeerSessionDescriptor {
    return { id, nativeUpdatedAt: 100, basicOnly: false, metadata: session(id).metadata, metadataVersion: 1, agentState: null, agentStateVersion: 0, seq: 0, createdAt: 1, active: false, activeAt: 0 };
}
const page = (rows: PeerSessionDescriptor[], overrides = {}) => ({ version: 2, mode: 'full', watermark: 'epoch:1', baseWatermark: null,
    machineIds: ['machine'], sessions: rows, removedIds: [], hasMore: false, nextCursor: null, ...overrides });

it('full scan hides stale same-Mac storage entries not merely stale cache rows, without losing their draft/history identity', () => {
    const current: Record<string, Session> = Object.fromEntries(Array.from({ length: 1680 }, (_, at) => { const id = 'old-' + at; return [id, session(id)]; }));
    current.foreign = session('foreign', 'other-machine');
    const rows = Array.from({ length: 240 }, (_, at) => descriptor('old-' + at));
    const scan = new CodeLightPeerCatalogDelta([], null); scan.apply(page(rows));
    const hidden = reconcileCodeLightCatalogSessions(current, scan.finish());
    expect(hidden).toHaveLength(1440);
    const applied = { ...current, ...Object.fromEntries(hidden.map(row => [row.id, row])) };
    expect(Object.values(applied).filter(isCodeLightNativeSession)).toHaveLength(241);
    expect(applied['old-500'].draft).toBe('keep-draft-old-500'); expect(applied['old-500'].metadataVersion).toBe(1);
    expect(applied.foreign.metadata?.nativeSession?.catalogueAvailable).toBe(true);
});

it('empty delta changes no rows, cache watermark or storage identities', () => {
    const scan = new CodeLightPeerCatalogDelta([descriptor('one')], 'epoch:1');
    expect(scan.apply(page([], { mode: 'delta', baseWatermark: 'epoch:1' }))).toEqual([]);
    expect(scan.finish().unchanged).toBe(true);
    expect(reconcileCodeLightCatalogSessions({ one: session('one') }, scan.finish())).toEqual([]);
});

it('delta removal hides only the confirmed same-Mac catalog record', () => {
    const scan = new CodeLightPeerCatalogDelta([descriptor('one'), descriptor('two')], 'epoch:1');
    scan.apply(page([], { mode: 'delta', baseWatermark: 'epoch:1', watermark: 'epoch:2', removedIds: ['two', 'foreign'] }));
    const result = scan.finish(); expect(result.sessions.map(row => row.id)).toEqual(['one']);
    expect(reconcileCodeLightCatalogSessions({ one: session('one'), two: session('two'), foreign: session('foreign', 'other-machine') }, result).map(row => row.id)).toEqual(['two']);
});

it('cross-watermark or changed pagination machine scope rejects rather than committing a partial catalog', () => {
    const scan = new CodeLightPeerCatalogDelta([], null); scan.apply(page([descriptor('one')], { hasMore: true, nextCursor: 'cursor' }));
    expect(() => scan.apply(page([descriptor('two')], { watermark: 'different' }))).toThrow();
    expect(() => scan.apply(page([descriptor('two')], { machineIds: ['other-machine'] }))).toThrow();
});

it('legacy full catalog reconciliation remains compatible', () => {
    const scan = new CodeLightPeerCatalogDelta([descriptor('old')], null);
    scan.apply({ version: 1, sessions: [descriptor('new')], hasMore: false, nextCursor: null });
    expect(scan.finish().watermark).toBeNull();
    expect(reconcileCodeLightCatalogSessions({ old: session('old'), new: session('new') }, scan.finish()).map(row => row.id)).toEqual(['old']);
});

it('never reconciles full removals before an authenticated terminal catalog page', () => {
    const scan = new CodeLightPeerCatalogDelta([descriptor('old')], null);
    scan.apply(page([descriptor('new')], { hasMore: true, nextCursor: 'next-page' }));
    expect(() => scan.finish()).toThrow('did not finish');
    scan.apply(page([], { hasMore: false, nextCursor: null }));
    expect(scan.finish().removedIds).toEqual(['old']);
    expect(() => scan.apply(page([descriptor('late')]))).toThrow('already completed');
});

it('rejects contradictory terminal flags and cursor loops before declaring the scan complete', () => {
    for (const boundary of [{ hasMore: true, nextCursor: null }, { hasMore: true, nextCursor: '' }, { hasMore: false, nextCursor: 'unexpected' }]) {
        const scan = new CodeLightPeerCatalogDelta([descriptor('old')], null);
        expect(() => scan.apply(page([descriptor('new')], boundary))).toThrow('page boundary');
        expect(() => scan.finish()).toThrow('did not finish');
    }
    const scan = new CodeLightPeerCatalogDelta([], null);
    scan.apply(page([descriptor('one')], { hasMore: true, nextCursor: 'loop' }));
    expect(() => scan.apply(page([descriptor('two')], { hasMore: true, nextCursor: 'loop' }))).toThrow('page boundary');
    expect(() => scan.finish()).toThrow('did not finish');
});
