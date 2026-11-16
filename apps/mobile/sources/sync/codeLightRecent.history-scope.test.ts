import { expect, it } from 'vitest';
import { isCurrentNativeRecent, nativeRecentMessages } from './codeLightRecent';

function fixture() {
    const proof = { app: 'codex', version: 1, available: true, readOnly: true, originator: 'Codex Desktop', nativeId: 'native', hostId: 'local', namespaceHash: 'a'.repeat(64), sourceStamp: 'b'.repeat(64), byteBoundary: { start: 10, end: 20, total: 20 } };
    const metadata = { client: { id: 'noninvasive-bridge' }, bridge: { source: { app: 'codex', id: 'native', hostId: 'local', runtimeGeneration: null }, controlMode: 'session', sourceStatus: 'history-only', currentTurnId: null }, nativeSavedHistory: proof };
    const row = { id: 'row', role: 'assistant', text: 'Saved', turnId: 'display-only', projectionRevision: 1, snapshotRevision: 1, streamRevision: 0, ownerGeneration: null, replaceIds: [], at: 1 };
    return { session: { id: 'session', metadata, metadataVersion: 10 }, window: { version: 1, session: { id: 'session', metadata, metadataVersion: 11, nativeUpdatedAt: 1 }, historicalRead: proof, ownerGeneration: null, rows: [row] } } as any;
}

it('accepts a newly confirmed readonly source without treating its data as a live controller', () => {
    const { session, window } = fixture(); session.metadata = { ...session.metadata, bridge: { ...session.metadata.bridge, sourceStatus: 'connected', source: { ...session.metadata.bridge.source, runtimeGeneration: 'old-owner' } }, nativeSavedHistory: null };
    expect(isCurrentNativeRecent(window, session)).toBe(true); expect(nativeRecentMessages(window)).toHaveLength(1);
});

it('rejects a historical page after a newer live owner or data stamp supersedes it', () => {
    const { session, window } = fixture(); session.metadataVersion = 12;
    session.metadata = { ...session.metadata, bridge: { ...session.metadata.bridge, sourceStatus: 'connected', source: { ...session.metadata.bridge.source, runtimeGeneration: 'new-owner' } }, nativeSavedHistory: null };
    expect(isCurrentNativeRecent(window, session)).toBe(false);
    const changed = fixture(); changed.session.metadata.nativeSavedHistory.sourceStamp = 'c'.repeat(64);
    changed.window = structuredClone(window); expect(isCurrentNativeRecent(changed.window, changed.session)).toBe(false);
});

it('keeps same-stamp readonly pages valid across unrelated metadata versions but rejects foreign identities and row owners', () => {
    const { session, window } = fixture(); session.metadataVersion = 20;
    expect(isCurrentNativeRecent(window, session)).toBe(true);
    const foreign = structuredClone(window); foreign.session.metadata.bridge.source.id = 'foreign'; expect(isCurrentNativeRecent(foreign, session)).toBe(false);
    window.rows[0].ownerGeneration = 'unexpected-controller'; expect(() => nativeRecentMessages(window)).toThrow('another owner');
});
