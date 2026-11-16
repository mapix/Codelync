import { expect, it } from 'vitest';
import type { Session } from './storageTypes';
import { applyNativeDirectoryAuthority } from './nativeDirectoryAuthority';
import { peerDescriptorSession, type PeerSessionDescriptor } from './codeLightRecent';

function session(): Session {
    return { id: 'relay', metadataVersion: 8, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 0,
        presence: 0, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0, draft: 'PRESERVED',
        metadata: { machineId: 'mac', client: { id: 'noninvasive-bridge' },
            bridge: { controlMode: 'session', sourceStatus: 'connected', source: { app: 'codex', id: 'native', hostId: 'local', runtimeGeneration: 'owner' } },
            nativeSession: { title: 'native', updatedAt: 1, parentId: null, agentName: '', preview: '', isPinned: false, isSubagent: false, catalogueAvailable: true } } } as Session;
}

it('keeps Claude directory authority separate from owner readiness while refusing a different native collection', () => {
    const current = session(); Object.assign(current.metadata!.bridge!.source, { app: 'claude-desktop', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
        protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions', kind: 'session', runtimeGeneration: 'owner' });
    current.metadata!.nativeSession!.catalogueAvailable = false;
    const removed = applyNativeDirectoryAuthority(current, undefined, true);
    const delayed = { ...current, metadata: { ...current.metadata!, nativeSession: { ...current.metadata!.nativeSession!, catalogueAvailable: true },
        bridge: { ...current.metadata!.bridge!, source: { ...current.metadata!.bridge!.source, runtimeGeneration: null } } } };
    expect(applyNativeDirectoryAuthority(delayed, removed).metadata?.nativeSession?.catalogueAvailable).toBe(false);
    Object.assign(delayed.metadata.bridge.source, { appMode: 'chat', nativeCollection: 'local-agent-mode-sessions' });
    expect(applyNativeDirectoryAuthority(delayed, removed).nativeDirectory).toBeUndefined();
});
function descriptor(value: Session): PeerSessionDescriptor {
    return { id: value.id, nativeUpdatedAt: value.updatedAt, basicOnly: true, metadata: value.metadata,
        metadataVersion: value.metadataVersion, agentState: null, agentStateVersion: 0, seq: 1, createdAt: 1, active: false, activeAt: 0 };
}
it('higher observer and recent metadata versions cannot resurrect a catalog removal or change its agent relation', () => {
    const current = session();
    current.metadata!.nativeSession = { ...current.metadata!.nativeSession!, catalogueAvailable: false, isSubagent: true, parentId: 'parent' };
    const removed = applyNativeDirectoryAuthority(current, undefined, true);
    const delayed = session(); delayed.metadataVersion = 99;
    delayed.metadata!.bridge = { ...delayed.metadata!.bridge!, source: { ...delayed.metadata!.bridge!.source, runtimeGeneration: 'new-owner' } };
    const result = applyNativeDirectoryAuthority(delayed, removed);
    expect(result.metadata?.nativeSession?.catalogueAvailable).toBe(false);
    expect(result.metadata?.nativeSession?.isSubagent).toBe(true); expect(result.metadata?.nativeSession?.parentId).toBe('parent');
    expect(result.metadataVersion).toBe(99); expect(result.metadata?.bridge?.source.runtimeGeneration).toBe('new-owner');
    expect(result.draft).toBe('PRESERVED');
});
it('a later explicit catalog upsert restores membership even when its header has a lower owner metadata version', () => {
    const current = session(); current.metadataVersion = 99; current.metadata!.nativeSession!.catalogueAvailable = false;
    const removed = applyNativeDirectoryAuthority(current, undefined, true), fresh = session();
    fresh.metadata!.nativeSession = { ...fresh.metadata!.nativeSession!, isSubagent: true, parentId: 'actual-parent' };
    const update = peerDescriptorSession(descriptor(fresh), removed, true);
    const restored = applyNativeDirectoryAuthority(update, removed, true);
    expect(restored.metadataVersion).toBe(99); expect(restored.metadata?.nativeSession?.catalogueAvailable).toBe(true);
    expect(restored.metadata?.nativeSession?.isSubagent).toBe(true); expect(restored.metadata?.nativeSession?.parentId).toBe('actual-parent');
    expect(restored.draft).toBe('PRESERVED');
    expect(applyNativeDirectoryAuthority(session(), restored).metadata?.nativeSession?.parentId).toBe('actual-parent');
});
it('directory authority never transfers across a different machine or native source reusing the relay ID', () => {
    const current = session(); current.metadata!.nativeSession!.catalogueAvailable = false;
    const removed = applyNativeDirectoryAuthority(current, undefined, true), foreign = session();
    foreign.metadata!.machineId = 'other-mac';
    expect(applyNativeDirectoryAuthority(foreign, removed).nativeDirectory).toBeUndefined();
    expect(applyNativeDirectoryAuthority(foreign, removed).metadata?.nativeSession?.catalogueAvailable).toBe(true);
});
it('cached catalog hydration cannot undo a newer removal, including a tombstone from the previous app version', () => {
    const removed = session(); removed.metadata!.nativeSession!.catalogueAvailable = false;
    const cached = peerDescriptorSession(descriptor(session()), removed, true);
    const applied = applyNativeDirectoryAuthority(cached, removed, 'cached');
    expect(applied.metadata?.nativeSession?.catalogueAvailable).toBe(false);
    expect(applied.nativeDirectory).toBeDefined();
    expect(applyNativeDirectoryAuthority(session(), applied).metadata?.nativeSession?.catalogueAvailable).toBe(false);
});
it('temporary owner uncertainty keeps an Antigravity directory tombstone without granting control', () => {
    const current = session(), hostId = 'local:antigravity:' + 'a'.repeat(64);
    current.metadata!.bridge!.source = { app: 'antigravity', id: 'native', hostId, kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: 'owner', windowGeneration: null };
    current.metadata!.nativeSession!.catalogueAvailable = false;
    const removed = applyNativeDirectoryAuthority(current, undefined, true);
    const delayed = { ...current, metadata: { ...current.metadata!, nativeSession: { ...current.metadata!.nativeSession!, catalogueAvailable: true },
        bridge: { ...current.metadata!.bridge!, source: { ...current.metadata!.bridge!.source, runtimeGeneration: null } } } };
    expect(applyNativeDirectoryAuthority(delayed, removed).metadata?.nativeSession?.catalogueAvailable).toBe(false);
    expect(applyNativeDirectoryAuthority(delayed, removed).metadata?.bridge?.source.runtimeGeneration).toBeNull();
});
