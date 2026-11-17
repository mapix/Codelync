import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Clipboard from 'expo-clipboard';
import type { AgentTextMessage, UserTextMessage } from '@/sync/typesMessage';
import type { Metadata } from '@/sync/storageTypes';
import { canSendToNoninvasiveSource } from '@/sync/noninvasiveBridge';

const optionsMock = vi.hoisted(() => ({ connected: true, state: { sessions: {} as Record<string, any> }, subscribers: new Set<() => void>(), send: vi.fn() }));

vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), Pressable: host('Pressable'),
        Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
    };
});
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { dark: false, colors: { text: '#000' } } }),
    StyleSheet: { create: (factory: (theme: any) => unknown) => factory({ colors: { input: {} } }) },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key, getCurrentLanguage: () => 'en' }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: optionsMock.send } }));
vi.mock('@/sync/storage', () => ({ useSetting: () => 'default', storage: { getState: () => optionsMock.state,
    subscribe: (callback: () => void) => { optionsMock.subscribers.add(callback); return () => optionsMock.subscribers.delete(callback); } } }));
vi.mock('@/utils/userMessageBubbleColor', () => ({ resolveUserMessageBubbleColor: () => ({}) }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('./markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('./tools/ToolView', () => ({ ToolView: 'ToolView' }));
vi.mock('./CodelyncHandoff', () => ({ CodelyncHandoff: () => null }));
vi.mock('./LongPressCopyable', async () => {
    const ReactModule = await import('react');
    return { LongPressCopyable: (props: any) => ReactModule.createElement('LongPressCopyable', props, props.children) };
});

vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerConnected: () => optionsMock.connected, onStatusChange: (f: () => void) => { optionsMock.subscribers.add(f); return () => optionsMock.subscribers.delete(f); } } }));
import { MessageView } from './MessageView';

const renderers: ReturnType<typeof create>[] = [];
const base: UserTextMessage = {
    kind: 'user-text', id: 'message', localId: 'local', createdAt: Date.now(), text: 'hello',
};

function render(message: UserTextMessage | AgentTextMessage, renderer?: ReturnType<typeof create>, metadata: Metadata | null = null) {
    const element = React.createElement(MessageView, { message, sessionId: 'session', metadata });
    if (renderer) {
        act(() => renderer.update(element));
        return renderer;
    }
    let next!: ReturnType<typeof create>;
    act(() => { next = create(element); });
    renderers.push(next);
    return next;
}

function labels(renderer: ReturnType<typeof create>) {
    return renderer.root.findAllByType('Text').map((node: any) => node.props.children);
}

afterEach(() => {
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
    vi.useRealTimers();
    optionsMock.connected = true; optionsMock.state.sessions = {}; optionsMock.subscribers.clear(); optionsMock.send.mockReset();
});

describe('user message frame', () => {
    it('shows native Queued admission after Sending has settled without an execution claim', () => {
        const queued = { ...base, pending: false, nativeAdmission: { nativeMessageId: 'original-uuid', disposition: 'queued' as const } };
        const renderer = render(queued);
        expect(labels(renderer)).toContain('Queued');
        expect(labels(renderer)).not.toContain('message.sending');
    });
    it('shows an explicit nonterminal unconfirmed result instead of Sending or send failure', () => {
        const renderer = render({ ...base, pending: true, deliveryUnconfirmed: true });
        expect(labels(renderer)).toContain('sourceBridge.deliveryUnconfirmed');
        expect(labels(renderer)).not.toContain('message.sending');
        expect(labels(renderer)).not.toContain('message.sendFailed');
        render({ ...base, pending: false }, renderer);
        expect(labels(renderer)).not.toContain('sourceBridge.deliveryUnconfirmed');
    });
    it.each([undefined, false])('does not flash status or dim an idle/new-chat send (%s)', (queuedWhileBusy) => {
        const message = { ...base, pending: true, meta: { queuedWhileBusy } };
        const renderer = render(message);
        const body = renderer.root.findByType('LongPressCopyable').parent.parent;
        expect(labels(renderer)).toEqual(['']);
        expect(body.props.style).not.toContainEqual({ opacity: 0.45 });

        render({ ...message, pending: false }, renderer);
        expect(labels(renderer)).toEqual(['']);
        expect(renderer.root.findByType('LongPressCopyable').parent.parent).toBe(body);
    });

    it.each([undefined, false])('shows Sending after the grace period when an idle/new-chat send is still unacknowledged (%s)', (queuedWhileBusy) => {
        vi.useFakeTimers();
        const message = { ...base, createdAt: Date.now(), pending: true, meta: { queuedWhileBusy } };
        const renderer = render(message);
        const body = renderer.root.findByType('LongPressCopyable').parent.parent;
        expect(labels(renderer)).toEqual(['']);

        act(() => vi.advanceTimersByTime(1_999));
        expect(labels(renderer)).toEqual(['']);
        act(() => vi.advanceTimersByTime(1));
        expect(labels(renderer)).toContain('message.sending');
        expect(renderer.root.findByType('LongPressCopyable').parent.parent).toBe(body);

        render({ ...message, pending: false }, renderer);
        expect(labels(renderer)).toEqual(['']);
    });

    it.each([
        'hello',
        '<command-name>/review</command-name><command-message>review</command-message><command-args>changes</command-args>',
        '<command-name>/goal</command-name><command-message>goal</command-message><command-args>ship it</command-args>',
    ])('shows the busy-send status until acceptance and preserves the bubble (%s)', (text) => {
        const message = { ...base, text, pending: true, meta: { queuedWhileBusy: true } };
        const renderer = render(message);
        const bubble = renderer.root.findByType('LongPressCopyable');
        expect(labels(renderer)).toContain('message.sendsAfterThisTurn');
        expect(labels(renderer)).not.toContain('message.sending');

        render({ ...message, pending: false }, renderer);
        expect(labels(renderer)).not.toContain('message.sendsAfterThisTurn');
        expect(renderer.root.findByType('LongPressCopyable')).toBe(bubble);
    });

    it('puts the other participant’s name above their message', () => {
        const renderer = render({ ...base, author: { id: 'other', name: 'Alex', owner: false } });
        const author = renderer.root.findAllByType('Text')[0];
        expect(author.props.children).toBe('Alex');
        const container = author.parent.parent;
        expect(container.children[0]).toBe(author.parent);
        expect(container.children[1].findByType('MarkdownView').props.markdown).toBe('hello');
    });

    it.each([undefined, { id: 'owner', name: 'You', owner: true }])('does not label the reader’s own messages (%j)', (author) => {
        expect(labels(render({ ...base, author }))).toEqual(['']);
    });

    it('still shows send failures for an idle send', () => {
        expect(labels(render({ ...base, sendError: 'Unavailable', meta: { queuedWhileBusy: false } })))
            .toContain('message.sendFailed');
    });
});
describe('agent message copy button', () => {
    const agent: AgentTextMessage = { kind: 'agent-text', id: 'agent', localId: null, createdAt: Date.now(), text: 'first part' };

    it('shows on every agent text row and copies that row’s own text', async () => {
        const renderer = render(agent);
        const button = renderer.root.findByType('Pressable');
        await act(async () => { await button.props.onPress(); });
        expect(Clipboard.setStringAsync).toHaveBeenCalledWith('first part');
    });

    it('stays mounted as the text streams in', () => {
        const renderer = render(agent);
        const button = renderer.root.findByType('Pressable');
        render({ ...agent, text: 'first part, then more' }, renderer);
        expect(renderer.root.findByType('Pressable')).toBe(button);
    });

    it('does not show on thinking rows', () => {
        expect(render({ ...agent, isThinking: true }).root.findAllByType('Pressable')).toHaveLength(0);
    });
});

describe('native child Markdown option restriction', () => {
    function metadata(app: 'codex' | 'antigravity', isSubagent: boolean): Metadata {
        return { client: { id: 'noninvasive-bridge' }, nativeSession: { isSubagent, parentId: 'native-parent' },
            bridge: { controlMode: 'session', sourceStatus: 'connected', source: { app, id: 'native-session', kind: 'session',
                hostId: app === 'codex' ? 'local' : 'local:antigravity:' + 'a'.repeat(64),
                protocol: app === 'antigravity' ? 'antigravity-connect' : undefined, runtimeGeneration: 'owner' } },
            capabilities: { steering: true } } as unknown as Metadata;
    }
    function publish(next: Metadata) {
        optionsMock.state.sessions = { session: { id: 'session', metadata: next } };
        for (const callback of optionsMock.subscribers) callback();
    }
    function message(kind: 'user-text' | 'agent-text') {
        return { ...base, kind, text: '<options>\n<option>Continue</option>\n</options>' } as UserTextMessage | AgentTextMessage;
    }
    it('retains native message options but disables them offline and fences an old callback', () => {
        publish(metadata('codex', false)); const renderer = render(message('agent-text'));
        const click = renderer.root.findByType('MarkdownView').props.onOptionPress;
        optionsMock.connected = false; act(() => { for (const callback of optionsMock.subscribers) callback(); });
        expect(renderer.root.findByType('MarkdownView').props.optionsDisabled).toBe(true);
        act(() => click({ title: 'Continue' })); expect(optionsMock.send).not.toHaveBeenCalled();
        optionsMock.connected = true; act(() => { for (const callback of optionsMock.subscribers) callback(); });
        expect(renderer.root.findByType('MarkdownView').props.optionsDisabled).toBe(false); expect(optionsMock.send).not.toHaveBeenCalled();
    });
    it.each([['codex', 'user-text'], ['codex', 'agent-text'], ['antigravity', 'user-text'], ['antigravity', 'agent-text']] as const)(
        'disables %s %s options even when the source currently allows steering', (app, kind) => {
            const current = metadata(app, true); publish(current);
            expect(current.capabilities?.steering).toBe(true);
            expect(canSendToNoninvasiveSource(current)).toBe(false);
            const markdown = render(message(kind)).root.findByType('MarkdownView');
            expect(markdown.props.optionsDisabled).toBe(true);
            act(() => markdown.props.onOptionPress({ title: 'Continue' }));
            expect(optionsMock.send).not.toHaveBeenCalled();
        });
    it.each(['user-text', 'agent-text'] as const)('rechecks the latest store for a captured %s callback and updates its presentation', kind => {
        publish(metadata('antigravity', false));
        const renderer = render(message(kind)), captured = renderer.root.findByType('MarkdownView').props.onOptionPress;
        expect(renderer.root.findByType('MarkdownView').props.optionsDisabled).toBe(false);
        act(() => { publish(metadata('antigravity', true)); captured({ title: 'Continue' }); });
        expect(optionsMock.send).not.toHaveBeenCalled();
        expect(renderer.root.findByType('MarkdownView').props.optionsDisabled).toBe(true);
        act(() => publish(metadata('antigravity', false)));
        act(() => renderer.root.findByType('MarkdownView').props.onOptionPress({ title: 'Continue' }));
        expect(optionsMock.send).toHaveBeenCalledWith('session', 'Continue', { source: 'option' });
    });
    it.each(['codex', 'antigravity'] as const)('keeps ordinary %s parents and forks interactive', app => {
        const parent = metadata(app, false); publish(parent);
        const renderer = render(message('agent-text'), undefined, metadata(app, true));
        const markdown = renderer.root.findByType('MarkdownView');
        expect(markdown.props.optionsDisabled).toBe(false);
        act(() => markdown.props.onOptionPress({ title: 'Continue' }));
        expect(optionsMock.send).toHaveBeenCalledWith('session', 'Continue', { source: 'option' });
    });
});
