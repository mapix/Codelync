import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { storage } from './storage';

describe('Track C Batch 8: R073 storage.deleteSession unread/archiving eviction', () => {
    beforeEach(() => {
        storage.setState({
            sessions: {
                s1: { id: 's1', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0 },
                s2: { id: 's2', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0 },
            } as any,
            sessionMessages: {},
            sessionFileCache: {},
            unreadSessionIds: new Set(['s1', 's2']),
            archivingSessionIds: new Set(['s1']),
            machines: {},
            projects: {},
            sessionListViewData: [],
        } as any);
    });

    it('evicts deleted sessionId from unreadSessionIds and archivingSessionIds while preserving references when absent', () => {
        storage.getState().deleteSession('s1');
        expect(storage.getState().unreadSessionIds.has('s1')).toBe(false);
        expect(storage.getState().unreadSessionIds.has('s2')).toBe(true);
        expect(storage.getState().archivingSessionIds.has('s1')).toBe(false);

        const unreadBefore = storage.getState().unreadSessionIds;
        const archivingBefore = storage.getState().archivingSessionIds;
        storage.getState().deleteSession('missing');
        expect(storage.getState().unreadSessionIds).toBe(unreadBefore);
        expect(storage.getState().archivingSessionIds).toBe(archivingBefore);
    });
});
