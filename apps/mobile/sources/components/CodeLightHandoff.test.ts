import React from 'react';
// @ts-expect-error The existing test renderer has no shipped declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import type { AgentTextMessage } from '@/sync/typesMessage';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), updateDraft: vi.fn(), sendMessage: vi.fn(), catalogRead: vi.fn(), state: {} as any,
    subscribers: new Set<() => void>() }));
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() }, FlatList: 'List', Modal: 'Modal', Pressable: 'Button', Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({}) }, useUnistyles: () => ({ theme: { colors: { text: 'black' } } }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('expo-router', () => ({ useRouter: () => ({}) }));
vi.mock('@/hooks/useNavigateToSession', () => ({ navigateToSession: mocks.navigate }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => mocks.state, subscribe: (callback: () => void) => { mocks.subscribers.add(callback); return () => mocks.subscribers.delete(callback); } }, useAllSessions: () => { mocks.catalogRead(); return Object.values(mocks.state.sessions); }, useAllMachines: () => Object.values(mocks.state.machines) }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mocks.sendMessage } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { CodeLightHandoff } from './CodeLightHandoff';

function session(id: string, app: 'codex' | 'antigravity'): Session {
    return { id, updatedAt: 10, draft: 'Existing target draft', metadata: { machineId: 'mac-a', client: { id: 'noninvasive-bridge' },
        nativeSession: { title: app, catalogueAvailable: true }, bridge: { controlMode: 'session', sourceStatus: 'connected',
            source: { app, id: 'original-' + app, kind: 'session', hostId: app === 'codex' ? 'local' : 'local:antigravity:' + 'a'.repeat(64),
                protocol: app === 'antigravity' ? 'antigravity-connect' : undefined, runtimeGeneration: app + '-owner' } } } } as Session;
}
const message: AgentTextMessage = { kind: 'agent-text', id: 'display-id', localId: null, createdAt: 1, text: 'A selected original reply', meta: { nativeRow: { id: 'original-row', offset: 0, revision: 0 } } };

it('explicit target selection appends to its latest draft and never sends a model request', () => {
    mocks.navigate.mockClear(); mocks.updateDraft.mockClear(); mocks.sendMessage.mockClear(); mocks.catalogRead.mockClear();
    const source = session('source', 'codex'), target = session('target', 'antigravity');
    mocks.state = { sessions: { source, target }, machines: { 'mac-a': { id: 'mac-a', active: true } }, updateSessionDraft: mocks.updateDraft };
    let screen!: ReturnType<typeof create>, row!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodeLightHandoff, { sessionId: source.id, metadata: source.metadata, message })); });
    expect(mocks.catalogRead).not.toHaveBeenCalled();
    act(() => screen.root.findByProps({ testID: 'codelight-handoff' }).props.onPress());
    expect(mocks.catalogRead).toHaveBeenCalled();
    const list = screen.root.findByType('List');
    act(() => { row = create(list.props.renderItem({ item: list.props.data[0] })); });
    target.draft = 'Changed while the picker was open  ';
    act(() => row.root.findByType('Button').props.onPress());
    expect(mocks.updateDraft).toHaveBeenCalledWith('target', expect.stringMatching(/^Changed while the picker was open  \n\n---\n/));
    expect(mocks.navigate).toHaveBeenCalledWith(expect.anything(), 'target');
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(source.draft).toBe('Existing target draft');
    act(() => { row.unmount(); screen.unmount(); });
});

it('does not prepare or navigate after the target catalog binding disappears while the picker is open', () => {
    mocks.navigate.mockClear(); mocks.updateDraft.mockClear(); mocks.sendMessage.mockClear();
    const source = session('source', 'codex'), target = session('target', 'antigravity');
    mocks.state = { sessions: { source, target }, machines: { 'mac-a': { id: 'mac-a', active: true } }, updateSessionDraft: mocks.updateDraft };
    let screen!: ReturnType<typeof create>, row!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodeLightHandoff, { sessionId: source.id, metadata: source.metadata, message })); });
    act(() => screen.root.findByProps({ testID: 'codelight-handoff' }).props.onPress());
    const list = screen.root.findByType('List');
    act(() => { row = create(list.props.renderItem({ item: list.props.data[0] })); });
    target.metadata!.nativeSession!.catalogueAvailable = false;
    act(() => row.root.findByType('Button').props.onPress());
    expect(mocks.updateDraft).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled(); expect(mocks.sendMessage).not.toHaveBeenCalled();
    act(() => { row.unmount(); screen.unmount(); });
});

it('rejects a target that becomes a native child after its picker row was captured', () => {
    mocks.navigate.mockClear(); mocks.updateDraft.mockClear(); mocks.sendMessage.mockClear();
    const source = session('source', 'codex'), target = session('target', 'antigravity');
    mocks.state = { sessions: { source, target }, machines: { 'mac-a': { id: 'mac-a', active: true } }, updateSessionDraft: mocks.updateDraft };
    let screen!: ReturnType<typeof create>, row!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodeLightHandoff, { sessionId: source.id, metadata: source.metadata, message })); });
    act(() => screen.root.findByProps({ testID: 'codelight-handoff' }).props.onPress());
    const list = screen.root.findByType('List');
    act(() => { row = create(list.props.renderItem({ item: list.props.data[0] })); });
    target.metadata!.nativeSession!.isSubagent = true;
    act(() => row.root.findByType('Button').props.onPress());
    expect(mocks.updateDraft).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled(); expect(target.draft).toBe('Existing target draft');
    act(() => { row.unmount(); screen.unmount(); });
});

it('shows handoff when the current owner becomes ready without rerendering the message props', () => {
    mocks.catalogRead.mockClear();
    const source = session('source', 'codex'), target = session('target', 'antigravity');
    source.metadata!.bridge!.sourceStatus = 'owner-unavailable';
    mocks.state = { sessions: { source, target }, machines: { 'mac-a': { id: 'mac-a', active: true } }, updateSessionDraft: mocks.updateDraft };
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(CodeLightHandoff, { sessionId: source.id, metadata: source.metadata, message })); });
    expect(screen.root.findAllByProps({ testID: 'codelight-handoff' })).toHaveLength(0);
    const ready = structuredClone(source); ready.metadata!.bridge!.sourceStatus = 'connected';
    act(() => { mocks.state.sessions.source = ready; for (const callback of mocks.subscribers) callback(); });
    expect(screen.root.findAllByProps({ testID: 'codelight-handoff' })).toHaveLength(1);
    expect(mocks.catalogRead).not.toHaveBeenCalled();
    act(() => screen.unmount());
});
