import * as React from 'react';
// @ts-expect-error Existing native renderer declarations are not shipped.
import { act, create } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ connected: true, metadata: { client: { id: 'noninvasive-bridge' } } as any, allow: vi.fn(), answer: vi.fn() }));
const communication = { id: 'question', status: 'pending', kind: 'form', questions: [{ id: 'q', question: 'Pick one', header: 'Choice', required: true, options: [{ label: 'A' }] }] };
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: { source: { metadata: state.metadata } } }) },
    useSession: () => ({ metadata: state.metadata }), useSocketStatus: () => ({ status: state.connected ? 'connected' : 'error' }), useSessionAgentFormCommunication: () => communication }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerConnected: () => state.connected } }));
vi.mock('@/sync/ops', () => ({ sessionAllow: state.allow, sessionAnswerQuestion: state.answer }));
vi.mock('./InlineQuestionForm', () => ({ InlineQuestionForm: (props: any) => React.createElement('Form', props) }));
import { AskUserQuestionView } from './AskUserQuestionView';
import { RequestUserInputView } from './RequestUserInputView';
beforeEach(() => { vi.clearAllMocks(); state.connected = true; state.metadata = { client: { id: 'noninvasive-bridge' } }; });
it.each(['permission', 'communication'])('native inline %s rejects a stale Submit offline and restores controls without replay', async type => {
    const Component = type === 'permission' ? AskUserQuestionView : RequestUserInputView;
    const props = { sessionId: 'source', metadata: state.metadata, messages: [], tool: { state: 'running', permission: { id: 'approval' }, callId: 'call', input: { questions: [{ question: 'Pick one', header: 'Choice', options: [{ label: 'A' }] }] } } as any };
    let root!: ReturnType<typeof create>; act(() => { root = create(React.createElement(Component, props)); });
    const oldSubmit = root.root.findByType('Form').props.onSubmit;
    state.connected = false; await expect(oldSubmit({ q: ['A'], 'question-0': ['A'] })).rejects.toMatchObject({ effectMayHaveOccurred: false });
    expect(state.allow).not.toHaveBeenCalled(); expect(state.answer).not.toHaveBeenCalled();
    act(() => root.update(React.createElement(Component, { ...props, messages: [] }))); expect(root.root.findByType('Form').props.canInteract).toBe(false);
    state.connected = true; act(() => root.update(React.createElement(Component, { ...props, messages: [] }))); expect(root.root.findByType('Form').props.canInteract).toBe(true);
    expect(state.allow).not.toHaveBeenCalled(); expect(state.answer).not.toHaveBeenCalled(); act(() => root.unmount());
});
it('ordinary legacy inline controls retain their original offline behavior', () => {
    state.metadata = { flavor: 'claude' }; state.connected = false;
    const props = { sessionId: 'source', metadata: state.metadata, messages: [], tool: { state: 'running', permission: { id: 'approval' }, input: { questions: [{ question: 'Pick one', header: 'Choice', options: [{ label: 'A' }] }] } } as any };
    let root!: ReturnType<typeof create>; act(() => { root = create(React.createElement(AskUserQuestionView, props)); });
    expect(root.root.findByType('Form').props.canInteract).toBe(true); act(() => root.unmount());
});
