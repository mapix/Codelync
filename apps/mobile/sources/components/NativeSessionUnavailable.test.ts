import * as React from 'react';
// @ts-expect-error The existing test renderer has no shipped declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Button', ActivityIndicator: 'Spinner', FlatList: 'List' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray' } } }) }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
vi.mock('@/sync/storage', () => ({ useSessionMessages: () => ({ messages: [] }) }));
vi.mock('@/sync/persistence', () => ({ loadSessionDrafts: () => ({}) }));
import { NativeSessionUnavailable } from './NativeSessionUnavailable';
import { nativeSessionAvailabilityLabels } from '@/text/nativeSessionAvailabilityLabels';

it('places unavailable text and Retry below the header owned by this surface', () => {
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(NativeSessionUnavailable, { sessionId: 'uncached', known: null, loading: false,
        topInset: 111, onRetry: vi.fn(), onBack: vi.fn() })); });
    expect(screen.root.findByProps({ testID: 'codelync-session-unavailable' }).props.style.paddingTop).toBe(131);
    expect(screen.root.findByProps({ testID: 'codelync-unavailable-retry' }).props.disabled).toBe(false);
    act(() => screen.update(React.createElement(NativeSessionUnavailable, { sessionId: 'uncached', known: null, loading: false,
        topInset: 0, onRetry: vi.fn(), onBack: vi.fn() })));
    expect(screen.root.findByProps({ testID: 'codelync-session-unavailable' }).props.style.paddingTop).toBe(20);
    act(() => screen.unmount());
});

it('coalesces a real unavailable Retry and keeps the route while an exact read fails', async () => {
    let reject!: (error: Error) => void;
    const retry = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; })), back = vi.fn();
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(NativeSessionUnavailable, { sessionId: 'child', known: null, loading: false,
        topInset: 111, onRetry: retry, onBack: back })); });
    const button = screen.root.findByProps({ testID: 'codelync-unavailable-retry' });
    await act(async () => { button.props.onPress(); button.props.onPress(); });
    expect(retry).toHaveBeenCalledOnce(); expect(back).not.toHaveBeenCalled();
    expect(screen.root.findByProps({ testID: 'codelync-unavailable-retry' }).props.disabled).toBe(true);
    await act(async () => { reject(Error('Private source details stay outside UI')); });
    expect(screen.root.findByProps({ testID: 'codelync-unavailable-retry' }).props.disabled).toBe(false);
    const text = screen.root.findAllByType('Text').map((node: any) => node.props.children).join(' ');
    expect(text).toContain('This session could not be refreshed'); expect(text).not.toContain('session list'); expect(text).not.toContain('Private source');
    expect(back).not.toHaveBeenCalled(); act(() => screen.unmount());
});

it('keeps exact-session refresh labels in every supported language', () => {
    for (const labels of Object.values(nativeSessionAvailabilityLabels)) {
        expect(labels.loading.trim()).not.toBe(''); expect(labels.refreshFailed.trim()).not.toBe('');
        expect(labels.refreshFailed).not.toMatch(/session list|会话列表|會話列表|セッション一覧|список сеансов|listy sesji|lista de sesi|elenco delle sessioni|llista de sessions/i);
    }
});
