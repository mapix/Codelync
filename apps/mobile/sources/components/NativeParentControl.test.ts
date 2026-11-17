import * as React from 'react';
// @ts-expect-error Native renderer declarations are not shipped.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ sessions: {} as Record<string, any>, flush: vi.fn(), navigate: vi.fn(), update: vi.fn(), refresh: vi.fn() }));
vi.mock('react-native', () => ({ Pressable: 'Button', Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray', groupped: { background: 'white' } } } }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('@/sync/storage', () => ({ useSession: (id: string) => mock.sessions[id], useAllSessions: () => Object.values(mock.sessions),
    storage: { getState: () => ({ sessions: mock.sessions, updateSessionDraft: mock.update }) } }));
vi.mock('@/hooks/useDraft', () => ({ flushNativeDraft: mock.flush }));
vi.mock('@/hooks/useNavigateToSession', () => ({ navigateToSession: mock.navigate }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
vi.mock('@/sync/sync', () => ({ sync: { refreshSessions: mock.refresh } }));
import { NativeParentControl } from './NativeParentControl';
function setup() {
    const source = { app: 'codex', hostId: 'local', kind: 'session', runtimeGeneration: 'owner' };
    const metadata = { machineId: 'mac', client: { id: 'noninvasive-bridge' }, bridge: { controlMode: 'session', sourceStatus: 'connected', source: { ...source, id: 'native-parent' } } };
    mock.sessions.parent = { id: 'parent', draft: 'PARENT PREFIX', metadata, agentState: null };
    mock.sessions.child = { id: 'child', draft: 'Old stored instruction', metadata: { ...metadata, nativeSession: { isSubagent: true, parentId: 'native-parent' },
        bridge: { ...metadata.bridge, source: { ...source, id: 'native-child' } } },
        agentState: { nativeInput: { available: false, reason: 'parent-owned-subagent', parentConversationId: 'native-parent', agentPath: '/root/qa',
            app: 'codex', nativeConversationId: 'native-child', hostId: 'local', ownerGeneration: 'owner' } } };
}
afterEach(() => { mock.sessions = {}; mock.flush.mockReset(); mock.navigate.mockReset(); mock.update.mockReset(); });
it('rechecks the current child owner before staging', () => {
    setup();
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(NativeParentControl, { sessionId: 'child' })); });
    mock.sessions.child.agentState.nativeInput.ownerGeneration = 'stale-owner';
    act(() => screen.root.findByProps({ testID: 'codelync-continue-in-parent' }).props.onPress());
    expect(mock.flush).not.toHaveBeenCalled();
    expect(mock.update).not.toHaveBeenCalled(); expect(mock.navigate).not.toHaveBeenCalled(); act(() => screen.unmount());
});
it('stages identity only without reading or flushing the child draft and keeps the parent draft', () => {
    setup(); Object.defineProperty(mock.sessions.child, 'draft', { get: () => { throw Error('Child draft must not be read'); } });
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(NativeParentControl, { sessionId: 'child' })); });
    act(() => screen.root.findByProps({ testID: 'codelync-continue-in-parent' }).props.onPress());
    expect(mock.update).toHaveBeenCalledWith('parent', expect.stringContaining('native-child'));
    const draft = mock.update.mock.calls[0][1];
    expect(draft).toMatch(/^PARENT PREFIX\n\n---/); expect(draft).not.toContain('Old stored instruction');
    expect(mock.flush).not.toHaveBeenCalled(); expect(draft).not.toContain('"instruction"');
    expect(mock.navigate).toHaveBeenCalledWith(expect.anything(), 'parent'); act(() => screen.unmount());
});
it('an unavailable parent offers one directory read with no navigation or draft mutation', async () => {
    setup(); delete mock.sessions.parent; let finish!: () => void;
    mock.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(NativeParentControl, { sessionId: 'child' })); });
    const retry = screen.root.findByProps({ testID: 'codelync-parent-read-retry' }).props.onPress;
    await act(async () => { retry(); retry(); }); expect(mock.refresh).toHaveBeenCalledOnce();
    expect(mock.update).not.toHaveBeenCalled(); expect(mock.navigate).not.toHaveBeenCalled(); expect(mock.flush).not.toHaveBeenCalled();
    expect(screen.root.findByProps({ testID: 'codelync-parent-read-retry' }).props.disabled).toBe(true);
    await act(async () => finish()); act(() => screen.unmount());
});
