import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rigMetadataFixture } from './__testdata__/rigMetadata';

const { sessionRPC, getState, setMode, nativeRpc } = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
    getState: vi.fn(),
    setMode: vi.fn(),
    nativeRpc: vi.fn(),
}));

vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: { getState } }));
vi.mock('./rigComposer', () => ({ rigComposerSetMode: setMode }));
vi.mock('./noninvasiveRpc', () => ({ runNoninvasiveRpc: nativeRpc, recoverNoninvasiveRpc: async () => true }));

describe('Rig session RPC capability gates', () => {
    beforeEach(() => {
        sessionRPC.mockReset();
        nativeRpc.mockReset(); nativeRpc.mockResolvedValue({ cancelled: true });
        sessionRPC.mockResolvedValue({ aborted: true });
        getState.mockReturnValue({
            sessions: { rig: { metadata: rigMetadataFixture } },
        });
    });

    it('calls the encrypted session-scoped abort RPC with an empty payload', async () => {
        const { sessionAbort } = await import('./ops');
        await sessionAbort('rig');
        expect(sessionRPC).toHaveBeenCalledWith('rig', 'abort', {});
    });

    it('cancels only the displayed Claude query, with no turn ID or draft change', async () => {
        const hostId = 'local:claude-desktop:' + 'a'.repeat(64);
        const query = { version: 1, app: 'claude-desktop', nativeConversationId: 'original', hostId, ownerGeneration: 'owner',
            queryToken: 'query', status: 'running', canSend: false, activeSendMode: 'unverified', canCancel: true } as const;
        const session = { draft: 'PRESERVED', metadata: { client: { id: 'noninvasive-bridge' }, nativeSession: { isSubagent: false },
            bridge: { source: { app: 'claude-desktop', id: 'original', hostId, runtimeGeneration: 'owner', kind: 'session', protocol: 'claude-desktop-native',
                appMode: 'chat', nativeCollection: 'local-agent-mode-sessions' }, controlMode: 'session', sourceStatus: 'connected', currentTurnId: null },
            capabilities: { abort: true, rpcMethods: ['abort'] } }, agentState: { nativeQuery: query } };
        getState.mockReturnValue({ sessions: { claude: session } });
        const { sessionAbort } = await import('./ops');
        await sessionAbort('claude', query);
        expect(nativeRpc).toHaveBeenCalledExactlyOnceWith('claude', 'abort', { queryToken: 'query' });
        expect(sessionRPC).not.toHaveBeenCalled(); expect(session.draft).toBe('PRESERVED');
        nativeRpc.mockClear();
        await expect(sessionAbort('claude', { ...query, queryToken: 'old-query' })).rejects.toThrow('changed');
        expect(nativeRpc).not.toHaveBeenCalled();
        session.metadata.nativeSession.isSubagent = true;
        await expect(sessionAbort('claude', query)).rejects.toThrow('not available');
        expect(nativeRpc).not.toHaveBeenCalled();
    });

    it('does not server-archive or delete a bot conversation', async () => {
        getState.mockReturnValue({ sessions: { bot: { metadata: { ...rigMetadataFixture, bot: { id: 'bot-1' } } } } });
        const { sessionArchive, sessionDelete } = await import('./ops');
        await expect(sessionArchive('bot')).resolves.toMatchObject({ success: false, message: expect.stringContaining('machine') });
        await expect(sessionDelete('bot')).resolves.toMatchObject({ success: false, message: expect.stringContaining('continuous') });
        expect(sessionRPC).not.toHaveBeenCalled();
    });

    it('does not call RPC methods that disappear after metadata refresh', async () => {
        getState.mockReturnValue({
            sessions: {
                rig: {
                    metadata: {
                        ...rigMetadataFixture,
                        capabilities: {
                            ...rigMetadataFixture.capabilities!,
                            files: { ...rigMetadataFixture.capabilities!.files, write: false },
                            rpcMethods: ['abort', 'bash', 'readFile', 'ripgrep'],
                        },
                    },
                },
            },
        });
        const { sessionWriteFile } = await import('./ops');
        await expect(sessionWriteFile('rig', '/tmp/a', 'YQ==', null)).resolves.toMatchObject({
            success: false,
            error: 'File writing is not available for this session',
        });
        expect(sessionRPC).not.toHaveBeenCalled();
    });

    it('writes a Happy Agent picker change through the synced composer draft, never as a loose metadata field', async () => {
        const updateSessionAgentModes = vi.fn();
        getState.mockReturnValue({ sessions: { rig: { metadata: rigMetadataFixture } }, updateSessionAgentModes });
        const { sessionSetAgentModes } = await import('./ops');
        sessionSetAgentModes('rig', { permissionMode: 'read_only' });
        expect(setMode).toHaveBeenCalledExactlyOnceWith('rig', { permissionMode: 'read_only' });
        expect(updateSessionAgentModes).not.toHaveBeenCalled();
    });

    it('never invokes unadvertised directory RPC helpers for Rig', async () => {
        const { sessionGetDirectoryTree, sessionListDirectory } = await import('./ops');
        expect(await sessionListDirectory('rig', '.')).toMatchObject({ success: false });
        expect(await sessionGetDirectoryTree('rig', '.', 2)).toMatchObject({ success: false });
        expect(sessionRPC).not.toHaveBeenCalled();
    });
});
