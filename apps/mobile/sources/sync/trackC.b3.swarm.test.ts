import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rigMetadataFixture } from './__testdata__/rigMetadata';

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('./persistence', () => ({
    loadSettings: () => ({}),
    loadLocalSettings: () => ({}),
    saveLocalSettings: vi.fn(),
    saveSettings: vi.fn(),
    loadPurchases: () => null,
    savePurchases: vi.fn(),
    loadProfile: () => null,
    saveProfile: vi.fn(),
    loadSessionDrafts: () => ({}),
    saveSessionDrafts: vi.fn(),
    loadRigComposerDraft: () => null,
    saveRigComposerDraft: vi.fn(),
    loadSessionLastMessageSentAt: () => ({}),
    saveSessionLastMessageSentAt: vi.fn(),
}));
vi.mock('./sync', () => ({ sync: { encryption: null } }));
vi.mock('./apiSocket', () => ({ apiSocket: { emitWithAck: vi.fn() } }));
vi.mock('@/realtime/RealtimeSession', () => ({ getCurrentRealtimeSessionId: () => null, getVoiceSession: () => null }));
vi.mock('@/components/tools/knownTools', () => ({ isMutableTool: () => true }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import {
    SESSION_FILE_CACHE_MAX_ENTRY_CHARS,
    SESSION_FILE_CACHE_MAX_FILES_PER_SESSION,
    SESSION_FILE_CACHE_MAX_SESSIONS,
    SESSION_FILE_CACHE_MAX_TOTAL_CHARS,
    storage,
} from './storage';
import { MetadataSchema, type Metadata, type Session } from './storageTypes';

function rigMeta(extra: Record<string, unknown> = {}): Metadata {
    return MetadataSchema.parse({ ...rigMetadataFixture, ...extra });
}

function codexNativeMeta(extra: Record<string, unknown> = {}): Metadata {
    return {
        path: '/tmp/repo',
        host: 'mac-mini',
        machineId: 'machine-1',
        client: { id: 'noninvasive-bridge', name: 'Codex' },
        bridge: {
            protocol: 'codex-ipc',
            controlMode: 'session',
            source: {
                app: 'codex',
                kind: 'session',
                id: 'thread-1',
                hostId: 'host-1',
                runtimeGeneration: 'gen-1',
            },
        },
        nativeSession: {
            projectKey: 'proj-1',
            projectLabel: 'codelight',
            projectPath: '/tmp/repo',
            catalogueAvailable: true,
        },
        ...extra,
    } as unknown as Metadata;
}

function makeSession(id: string, metadata: Metadata, extra: Record<string, unknown> = {}): Session {
    return {
        id,
        seq: 1,
        createdAt: 1000,
        updatedAt: 1000,
        active: true,
        activeAt: 1000,
        metadata,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        ...extra,
    } as Session;
}

beforeEach(() => {
    storage.setState({
        sessions: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionFileCache: {},
        unreadSessionIds: new Set<string>(),
        archivingSessionIds: new Set<string>(),
        currentViewingSessionId: null,
    } as any);
});

describe('Track C Batch 3: R023 applySessions identity preservation on activity/seq ticks', () => {
    it('preserves sessionsData and sessionListViewData across seq, updatedAt, and active activeAt heartbeats', () => {
        const native = makeSession('native-1', codexNativeMeta());
        const rig = makeSession('rig-1', rigMeta());
        storage.getState().applySessions([native], { nativeCatalog: true });
        storage.getState().applySessions([rig]);

        const listBefore = storage.getState().sessionListViewData;
        const legacyBefore = storage.getState().sessionsData;
        expect(listBefore).not.toBeNull();
        expect(legacyBefore).not.toBeNull();

        // Simulate streaming token / activity heartbeats on both native Codex and Rig sessions.
        const storedNative = storage.getState().sessions['native-1'];
        const storedRig = storage.getState().sessions['rig-1'];
        storage.getState().applySessions([{
            ...storedNative,
            seq: 25,
            updatedAt: 5000,
            active: true,
            activeAt: 5000,
        }]);
        storage.getState().applySessions([{
            ...storedRig,
            seq: 42,
            updatedAt: 6000,
            active: true,
            activeAt: 6000,
        }]);

        expect(storage.getState().sessions['native-1'].seq).toBe(25);
        expect(storage.getState().sessions['rig-1'].seq).toBe(42);
        expect(storage.getState().sessionListViewData).toBe(listBefore);
        expect(storage.getState().sessionsData).toBe(legacyBefore);
    });

    it('skips list rebuild on agentState updates that keep resolved state, then rebuilds on visible transitions', () => {
        const rig = makeSession('rig-2', rigMeta(), {
            agentState: { controlledByUser: false, requests: {}, completedRequests: { a: {} } } as any,
            agentStateVersion: 1,
        });
        storage.getState().applySessions([rig]);

        const listBefore = storage.getState().sessionListViewData;
        const legacyBefore = storage.getState().sessionsData;

        // Same resolved SessionState ('waiting' -> 'waiting'): skip list rebuild.
        const current = storage.getState().sessions['rig-2'];
        storage.getState().applySessions([{
            ...current,
            seq: 2,
            agentState: { controlledByUser: true, requests: {}, completedRequests: { a: {}, b: {} } } as any,
            agentStateVersion: 2,
        }]);
        expect(storage.getState().sessionListViewData).toBe(listBefore);
        expect(storage.getState().sessionsData).toBe(legacyBefore);

        // New permission request ('waiting' -> 'permission_required'): must rebuild list immediately.
        const after = storage.getState().sessions['rig-2'];
        storage.getState().applySessions([{
            ...after,
            seq: 3,
            agentState: {
                controlledByUser: true,
                requests: { r1: { tool: 'Bash', arguments: {} } },
                completedRequests: { a: {}, b: {} },
            } as any,
            agentStateVersion: 3,
        }]);
        expect(storage.getState().sessionListViewData).not.toBe(listBefore);
        expect(storage.getState().sessionsData).not.toBe(legacyBefore);

        // Inactive activeAt change must rebuild so "last seen" timestamp stays current.
        storage.getState().applySessions([{ ...storage.getState().sessions['rig-2'], active: false, activeAt: 2000 }]);
        const inactiveBefore = storage.getState().sessionListViewData;
        storage.getState().applySessions([{ ...storage.getState().sessions['rig-2'], active: false, activeAt: 9000 }]);
        expect(storage.getState().sessionListViewData).not.toBe(inactiveBefore);

        // Thinking transition to idle on unviewed session (no pending requests) marks unread and rebuilds list.
        const resolvedAgentState = { controlledByUser: true, requests: {}, completedRequests: { a: {}, b: {}, r1: {} } } as any;
        storage.getState().applySessions([{ ...storage.getState().sessions['rig-2'], active: true, thinking: true, agentState: resolvedAgentState }]);
        const thinkingBefore = storage.getState().sessionListViewData;
        storage.getState().applySessions([{ ...storage.getState().sessions['rig-2'], active: true, thinking: false, agentState: resolvedAgentState }]);
        expect(storage.getState().unreadSessionIds.has('rig-2')).toBe(true);
        expect(storage.getState().sessionListViewData).not.toBe(thinkingBefore);
    });
});

describe('Track C Batch 3: R028 sessionFileCache LRU bounds', () => {
    it('bounds distinct session buckets to SESSION_FILE_CACHE_MAX_SESSIONS using LRU recency', () => {
        for (let i = 0; i < SESSION_FILE_CACHE_MAX_SESSIONS; i++) {
            storage.getState().applyFileCache(`sess-${i}`, '/a.ts', `code-${i}`, null, false);
        }
        // Refresh sess-0 so sess-1 becomes the least recently used bucket.
        storage.getState().applyFileCache('sess-0', '/b.ts', 'code-0b', null, false);
        storage.getState().applyFileCache(`sess-${SESSION_FILE_CACHE_MAX_SESSIONS}`, '/a.ts', 'code-new', null, false);

        const cache = storage.getState().sessionFileCache;
        expect(Object.keys(cache)).toHaveLength(SESSION_FILE_CACHE_MAX_SESSIONS);
        expect(cache['sess-0']?.['/b.ts']?.content).toBe('code-0b');
        expect(cache[`sess-${SESSION_FILE_CACHE_MAX_SESSIONS}`]?.['/a.ts']?.content).toBe('code-new');
        expect(cache['sess-1']).toBeUndefined();
    });

    it('bounds files per session bucket to SESSION_FILE_CACHE_MAX_FILES_PER_SESSION by LRU', () => {
        for (let i = 0; i < SESSION_FILE_CACHE_MAX_FILES_PER_SESSION; i++) {
            storage.getState().applyFileCache('sess-files', `/file-${i}.ts`, `body-${i}`, null, false);
        }
        // Promote file-0 so file-1 is evicted next.
        storage.getState().applyFileCache('sess-files', '/file-0.ts', 'body-0-updated', null, false);
        storage.getState().applyFileCache('sess-files', `/file-${SESSION_FILE_CACHE_MAX_FILES_PER_SESSION}.ts`, 'body-new', null, false);

        const bucket = storage.getState().sessionFileCache['sess-files'];
        expect(Object.keys(bucket)).toHaveLength(SESSION_FILE_CACHE_MAX_FILES_PER_SESSION);
        expect(bucket['/file-0.ts']?.content).toBe('body-0-updated');
        expect(bucket[`/file-${SESSION_FILE_CACHE_MAX_FILES_PER_SESSION}.ts`]?.content).toBe('body-new');
        expect(bucket['/file-1.ts']).toBeUndefined();
    });

    it('bounds total character budget across sessions and skips oversized single entries', () => {
        const chunk = 'x'.repeat(2_500_000);
        storage.getState().applyFileCache('s1', '/1.txt', chunk, null, false);
        storage.getState().applyFileCache('s2', '/2.txt', chunk, null, false);
        storage.getState().applyFileCache('s3', '/3.txt', chunk, null, false);
        // Inserting s4 pushes total to 10M > 8M -> oldest s1 must be evicted to stay <= 8M.
        storage.getState().applyFileCache('s4', '/4.txt', chunk, null, false);

        let cache = storage.getState().sessionFileCache;
        expect(cache['s1']).toBeUndefined();
        expect(cache['s4']?.['/4.txt']?.content?.length).toBe(2_500_000);

        let totalChars = 0;
        for (const files of Object.values(cache)) {
            for (const entry of Object.values(files)) {
                totalChars += (entry.content?.length ?? 0) + (entry.diff?.length ?? 0);
            }
        }
        expect(totalChars).toBeLessThanOrEqual(SESSION_FILE_CACHE_MAX_TOTAL_CHARS);

        // Single entry above SESSION_FILE_CACHE_MAX_ENTRY_CHARS is ignored without evicting valid entries.
        const giant = 'g'.repeat(SESSION_FILE_CACHE_MAX_ENTRY_CHARS + 1);
        storage.getState().applyFileCache('s5', '/giant.txt', giant, null, false);
        cache = storage.getState().sessionFileCache;
        expect(cache['s5']).toBeUndefined();
        expect(cache['s2']?.['/2.txt']).toBeDefined();

        // deleteSession removes its bucket cleanly.
        storage.getState().deleteSession('s4');
        expect(storage.getState().sessionFileCache['s4']).toBeUndefined();
    });
});
