import { expect, it } from 'vitest';
import { codeLightSavedHistory, NativeSavedHistorySchema } from './nativeSavedHistory';

function value() {
    const saved = { app: 'codex' as const, version: 1 as const, available: true as const, readOnly: true as const, originator: 'Codex Desktop' as const,
        nativeId: 'original', hostId: 'local' as const, namespaceHash: 'a'.repeat(64), sourceStamp: 'b'.repeat(64), byteBoundary: { start: 1, end: 2, total: 3 } };
    return { metadata: { nativeSavedHistory: saved, client: { id: 'noninvasive-bridge' }, bridge: { sourceStatus: 'history-only', controlMode: 'session', currentTurnId: null,
        source: { app: 'codex', id: 'original', hostId: 'local', runtimeGeneration: null } } } } as any;
}

it('accepts only matching original Desktop saved data with no active controller or turn', () => {
    const session = value(); expect(codeLightSavedHistory(session)?.sourceStamp).toBe('b'.repeat(64));
    for (const change of [{ id: 'foreign' }, { hostId: 'other' }, { app: 'antigravity' }, { runtimeGeneration: 'active-owner' }]) {
        expect(codeLightSavedHistory({ metadata: { ...session.metadata, bridge: { ...session.metadata.bridge, source: { ...session.metadata.bridge.source, ...change } } } } as any)).toBeNull();
    }
    session.metadata.bridge.currentTurnId = 'active-turn'; expect(codeLightSavedHistory(session)).toBeNull();
});

it('rejects malformed data boundaries and readonly claims without native provenance', () => {
    const session = value();
    expect(NativeSavedHistorySchema.safeParse({ ...session.metadata.nativeSavedHistory, byteBoundary: { start: 3, end: 2, total: 4 } }).success).toBe(false);
    session.metadata.nativeSavedHistory.originator = 'CLI'; expect(codeLightSavedHistory(session)).toBeNull();
});
