import { expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { mergeNativeTasksCatalogState } from './nativeTaskCatalogMerge';
import { peerDescriptorSession, type PeerSessionDescriptor } from '@/sync/codeLightRecent';
import { nativeTaskSignal } from '@slopus/happy-wire/native-tasks';
import { captureCurrentNativeTaskScope, projectCodeLightNativeTasks } from './codeLightNativeTasks';
import { nativeTaskCacheKey } from '@/sync/nativeTaskCache';

const previous = () => ({ id: 'relay', metadata: { machineId: 'mac', client: { id: 'noninvasive-bridge' }, bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null,
    source: { app: 'claude-desktop', kind: 'session', protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions',
        hostId: 'local:claude-desktop:' + 'a'.repeat(64), id: 'parent', runtimeGeneration: 'owner' } } }, metadataVersion: 1, agentStateVersion: 1,
    agentState: { nativeQuery: { version: 1, app: 'claude-desktop', nativeConversationId: 'parent', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
        ownerGeneration: 'owner', queryToken: 'query', status: 'running', canSend: true, activeSendMode: 'queue', canCancel: true },
        nativeTasks: { version: 1, scope: { app: 'claude-desktop', nativeCollection: 'claude-code-sessions', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
            parentConversationId: 'parent', ownerGeneration: 'owner', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli' },
            tasks: [], tasksAvailable: true, tasksComplete: false, tasksTruncated: false, backgroundTasksComplete: false, partial: true,
            dispatchChildren: [], dispatchChildrenAvailable: false, dispatchChildrenComplete: false, dispatchChildrenTruncated: false } } }) as unknown as Session;
const descriptor = (value: Session): PeerSessionDescriptor => ({ id: value.id, metadata: value.metadata, metadataVersion: 2, agentStateVersion: 2,
    agentState: { nativeQuery: value.agentState!.nativeQuery }, basicOnly: false, nativeUpdatedAt: 10, seq: 2, createdAt: 1, active: true, activeAt: 10 });
it('preserves a selected task envelope when the same owner/query directory update deliberately omits rows', () => {
    const value = previous(), update = peerDescriptorSession(descriptor(value), value, true);
    expect(update.agentState!.nativeTasks).toEqual(value.agentState!.nativeTasks);
    expect(update.agentState!.nativeQuery).toEqual(value.agentState!.nativeQuery);
    expect(peerDescriptorSession(descriptor(value), value, false).agentState).not.toHaveProperty('nativeTasks');
});
it('clears omitted inherited task rows after source, collection, machine, owner or query changes', () => {
    for (const change of [
        (s: Session) => { s.metadata!.machineId = 'other-mac'; },
        (s: Session) => { s.metadata!.bridge!.source.id = 'other-parent'; },
        (s: Session) => { s.metadata!.bridge!.source.hostId = 'local:claude-desktop:' + 'b'.repeat(64); },
        (s: Session) => { s.metadata!.bridge!.source.runtimeGeneration = 'new-owner'; },
        (s: Session) => { Object.assign(s.metadata!.bridge!.source, { appMode: 'chat', nativeCollection: 'local-agent-mode-sessions' }); },
        (s: Session) => { s.agentState!.nativeQuery!.queryToken = 'new-query'; },
    ]) {
        const before = previous(), after = previous(); change(after);
        expect(peerDescriptorSession(descriptor(after), before, true).agentState).not.toHaveProperty('nativeTasks');
        expect(mergeNativeTasksCatalogState(after.metadata, after.agentState, before, true, true)).not.toHaveProperty('nativeTasks');
    }
});
it('does not recover an explicitly cleared, malformed or replaced envelope from a partial directory', () => {
    const value = previous();
    for (const nativeTasks of [null, undefined, { version: 99 }]) {
        const state = { nativeQuery: value.agentState!.nativeQuery, nativeTasks } as any;
        expect(mergeNativeTasksCatalogState(value.metadata, state, value, true)).toBe(state);
    }
});
it('preserves an omitted selected signal without bringing task rows back into a lightweight directory', () => {
    const value = previous(), full = { ...value.agentState!.nativeTasks!, digest: 'a'.repeat(64) };
    value.agentState = { nativeQuery: value.agentState!.nativeQuery, nativeTaskSignal: nativeTaskSignal(full) } as any;
    const update = peerDescriptorSession(descriptor(value), value, true);
    expect(update.agentState!.nativeTaskSignal).toEqual(value.agentState!.nativeTaskSignal); expect(update.agentState).not.toHaveProperty('nativeTasks');
    const after = { ...value, metadata: { ...value.metadata, bridge: { ...value.metadata!.bridge, source: { ...value.metadata!.bridge!.source, runtimeGeneration: 'new-owner' } } } } as Session;
    expect(peerDescriptorSession(descriptor(after), value, true).agentState).not.toHaveProperty('nativeTaskSignal');
});
it('invalidates explicit null, new main runtime and new query instead of reviving a cached selected snapshot', () => {
    const value = previous(), full = { ...value.agentState!.nativeTasks!, digest: 'a'.repeat(64) }, signal = nativeTaskSignal(full);
    value.agentState = { nativeQuery: value.agentState!.nativeQuery, nativeTaskSignal: signal } as any;
    const cleared = { ...value, agentState: { ...value.agentState, nativeTaskSignal: null } } as unknown as Session;
    expect(captureCurrentNativeTaskScope(cleared)).toBeNull();
    for (const change of ['main', 'query']) {
        const scope = { ...signal.scope, ...(change === 'main' ? { runtimeGeneration: 'new-main' } : { queryToken: 'new-query' }) };
        const next = { ...value, agentState: { ...value.agentState, nativeTaskSignal: { ...signal, scope, digest: 'b'.repeat(64) },
            nativeQuery: { ...value.agentState!.nativeQuery, ...(change === 'query' ? { queryToken: 'new-query' } : {}) } } } as Session;
        const current = captureCurrentNativeTaskScope(next)!; expect(current).not.toBeNull();
        expect(nativeTaskCacheKey({ peerId: 'peer', sessionId: next.id, scope: current, desiredDigest: 'b'.repeat(64) }))
            .not.toBe(nativeTaskCacheKey({ peerId: 'peer', sessionId: value.id, scope: signal.scope, desiredDigest: signal.digest }));
        expect(projectCodeLightNativeTasks(next, full).native).toBeNull();
    }
});
