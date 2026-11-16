import * as React from 'react';
// @ts-expect-error Native renderer declarations are not shipped.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ state: { sessions: {} as Record<string, any>, updateSessionDraft: vi.fn() }, subscribers: new Set<(s: any, p: any) => void>(), focused: true,
    rigSet: vi.fn(), rigClear: vi.fn() }));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => mock.focused }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => mock.state, subscribe: (f: any) => { mock.subscribers.add(f); return () => mock.subscribers.delete(f); } } }));
vi.mock('@/sync/rig', () => ({ isRigMetadataV1: (metadata: any) => metadata?.client?.id === 'noninvasive-bridge' || metadata?.rigV1 === true }));
vi.mock('@/sync/rigComposer', () => ({ rigComposerClear: mock.rigClear, rigComposerSetText: mock.rigSet }));
import { flushNativeDraft, useDraft } from './useDraft';
const native = (draft: string) => ({ draft, metadata: { client: { id: 'noninvasive-bridge' } } });
function Harness({ id, initial }: { id: string | null; initial: string }) {
    const [value, change] = React.useState(initial); const { clearDraft } = useDraft(id, value, change);
    return React.createElement('Draft', { value, change, clear: clearDraft });
}
function stage(id: string, value: string) {
    const previous = { ...mock.state, sessions: { ...mock.state.sessions, [id]: { ...mock.state.sessions[id] } } };
    mock.state.sessions[id] = { ...mock.state.sessions[id], draft: value };
    for (const callback of mock.subscribers) callback(mock.state, previous);
}
afterEach(() => { vi.useRealTimers(); mock.focused = true; mock.subscribers.clear(); mock.state.updateSessionDraft.mockReset(); mock.state.sessions = {};
    mock.rigSet.mockReset(); mock.rigClear.mockReset(); });
it('adopts an externally staged nonempty target at mount instead of saving the old renderer value', () => {
    mock.state.sessions.target = native('PREFIX\n\nSTAGED HANDOFF');
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(Harness, { id: 'target', initial: 'PREFIX' })); });
    expect(view.root.findByType('Draft').props.value).toBe('PREFIX\n\nSTAGED HANDOFF');
    expect(mock.state.updateSessionDraft).not.toHaveBeenCalled(); act(() => view.unmount());
});
it('cancels a stale debounce and unmount save after a newer external stage', () => {
    vi.useFakeTimers(); mock.state.sessions.target = native('PREFIX');
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(Harness, { id: 'target', initial: 'PREFIX' })); });
    act(() => view.root.findByType('Draft').props.change('OLD PENDING EDIT'));
    act(() => stage('target', 'PREFIX\n\nPARENT CONTINUATION'));
    expect(view.root.findByType('Draft').props.value).toBe('PREFIX\n\nPARENT CONTINUATION');
    act(() => { vi.advanceTimersByTime(3000); view.unmount(); });
    expect(mock.state.updateSessionDraft).not.toHaveBeenCalled();
});
it('reused native route adopts the other source draft and never writes the previous source text', () => {
    mock.state.sessions.first = native('FIRST SOURCE'); mock.state.sessions.second = native('SECOND PREFIX\n\nHANDOFF');
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(Harness, { id: 'first', initial: 'FIRST SOURCE' })); });
    act(() => view.update(React.createElement(Harness, { id: 'second', initial: 'IGNORED' })));
    expect(view.root.findByType('Draft').props.value).toBe('SECOND PREFIX\n\nHANDOFF');
    expect(mock.state.updateSessionDraft).not.toHaveBeenCalled(); act(() => view.unmount());
});
it('saves a new user edit after external adoption without restoring the previous prefix', () => {
    vi.useFakeTimers(); mock.state.sessions.target = native('PREFIX');
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(Harness, { id: 'target', initial: 'PREFIX' })); });
    act(() => stage('target', 'PREFIX\n\nHANDOFF'));
    act(() => view.root.findByType('Draft').props.change('PREFIX\n\nHANDOFF\nNew user instruction'));
    act(() => vi.advanceTimersByTime(2100));
    expect(mock.state.updateSessionDraft).toHaveBeenCalledExactlyOnceWith('target', 'PREFIX\n\nHANDOFF\nNew user instruction');
    expect(mock.state.sessions.target.draft).toBe('PREFIX\n\nHANDOFF');
    act(() => view.unmount());
});
it('preserves a non-native pending chat draft when the real session first arrives', () => {
    mock.state.sessions.created = { draft: null, metadata: { client: { id: 'other-client' } } };
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(Harness, { id: null, initial: 'NEW CHAT INPUT' })); });
    act(() => view.update(React.createElement(Harness, { id: 'created', initial: 'IGNORED' })));
    expect(view.root.findByType('Draft').props.value).toBe('NEW CHAT INPUT');
    expect(mock.state.updateSessionDraft).toHaveBeenCalledExactlyOnceWith('created', 'NEW CHAT INPUT');
    act(() => view.unmount());
});
it('flushes the latest focused native render before its debounce for explicit staging', () => {
    vi.useFakeTimers(); mock.state.sessions.child = native('New');
    mock.state.updateSessionDraft.mockImplementation((id: string, draft: string) => stage(id, draft));
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(Harness, { id: 'child', initial: 'New' })); });
    act(() => view.root.findByType('Draft').props.change('New complete reviewed instruction'));
    expect(mock.state.sessions.child.draft).toBe('New');
    act(() => expect(flushNativeDraft('child')).toBe(true));
    expect(mock.state.sessions.child.draft).toBe('New complete reviewed instruction');
    act(() => { vi.advanceTimersByTime(3000); view.unmount(); });
    expect(mock.state.updateSessionDraft).toHaveBeenCalledTimes(1);
    expect(flushNativeDraft('child')).toBe(false);
});
it('refuses a stale render during external adoption and accepts its settled successor', () => {
    mock.state.sessions.child = native('Old draft');
    mock.state.updateSessionDraft.mockImplementation((id: string, draft: string) => stage(id, draft));
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(Harness, { id: 'child', initial: 'Old draft' })); });
    act(() => { stage('child', 'Externally staged latest draft'); expect(flushNativeDraft('child')).toBe(false); });
    expect(mock.state.sessions.child.draft).toBe('Externally staged latest draft');
    act(() => expect(flushNativeDraft('child')).toBe(true));
    expect(mock.state.updateSessionDraft).not.toHaveBeenCalled(); act(() => view.unmount());
});
it('keeps a replacement composer handler when an older instance cleans up, and rejects unfocused state', () => {
    mock.state.sessions.child = native('Current draft');
    let old!: ReturnType<typeof create>, current!: ReturnType<typeof create>;
    act(() => { old = create(React.createElement(Harness, { id: 'child', initial: 'Current draft' })); });
    act(() => { current = create(React.createElement(Harness, { id: 'child', initial: 'Current draft' })); });
    act(() => old.unmount());
    expect(flushNativeDraft('child')).toBe(true);
    mock.focused = false;
    act(() => current.update(React.createElement(Harness, { id: 'child', initial: 'Current draft' })));
    expect(flushNativeDraft('child')).toBe(false); act(() => current.unmount());
});
it('saves, explicitly flushes and clears native Rig-compatible drafts only on the device', () => {
    vi.useFakeTimers(); mock.state.sessions.child = native('Local prefix');
    mock.state.updateSessionDraft.mockImplementation((id: string, draft: string | null) => stage(id, draft ?? ''));
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(Harness, { id: 'child', initial: 'Local prefix' })); });
    act(() => view.root.findByType('Draft').props.change('Local prefix plus latest input'));
    act(() => expect(flushNativeDraft('child')).toBe(true));
    expect(mock.state.sessions.child.draft).toBe('Local prefix plus latest input');
    act(() => { view.root.findByType('Draft').props.change('Local prefix plus edited input'); vi.advanceTimersByTime(2100); });
    act(() => vi.advanceTimersByTime(2100));
    expect(mock.state.updateSessionDraft).toHaveBeenCalledWith('child', 'Local prefix plus edited input');
    act(() => view.root.findByType('Draft').props.clear());
    expect(mock.state.updateSessionDraft).toHaveBeenCalledWith('child', null);
    expect(mock.rigSet).not.toHaveBeenCalled(); expect(mock.rigClear).not.toHaveBeenCalled(); act(() => view.unmount());
});
it('retains synchronized save and clear behavior for a non-native Rig session', () => {
    mock.state.sessions.rig = { draft: 'Rig prefix', metadata: { rigV1: true } };
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(Harness, { id: 'rig', initial: 'Rig prefix' })); });
    act(() => view.root.findByType('Draft').props.change('Rig latest input'));
    expect(mock.rigSet).toHaveBeenCalledWith('rig', 'Rig latest input');
    act(() => view.root.findByType('Draft').props.clear());
    expect(mock.rigClear).toHaveBeenCalledWith('rig');
    expect(mock.state.updateSessionDraft).not.toHaveBeenCalled(); act(() => view.unmount());
});
