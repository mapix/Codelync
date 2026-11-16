import * as React from 'react';
// @ts-expect-error Existing renderer declarations are not shipped.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Button', ActivityIndicator: 'Spinner' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray', groupped: { background: 'white' } } } }) }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
import { NativeStoredConnectionUnavailable } from './NativeStoredConnectionUnavailable';
it('offers retained-storage Retry instead of pairing and shows its active read state', () => {
    const retry = vi.fn(); let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(NativeStoredConnectionUnavailable, { busy: false, onRetry: retry })); });
    const text = view.root.findAllByType('Text').map((node: any) => node.props.children).join(' ');
    expect(text).toContain('Connection could not be restored'); expect(text).toContain('Unlock your phone'); expect(text).not.toContain('Scan');
    act(() => view.root.findByType('Button').props.onPress()); expect(retry).toHaveBeenCalledOnce();
    act(() => view.update(React.createElement(NativeStoredConnectionUnavailable, { busy: true, onRetry: retry })));
    expect(view.root.findByType('Button').props.disabled).toBe(true); expect(view.root.findAllByType('Spinner')).toHaveLength(1);
    act(() => view.root.findByType('Button').props.onPress()); expect(retry).toHaveBeenCalledOnce();
    act(() => view.unmount());
});
