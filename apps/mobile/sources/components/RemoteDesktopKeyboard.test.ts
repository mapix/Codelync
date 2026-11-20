import * as React from 'react';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopInputQueue, desktopInputAcknowledged } from '@/sync/desktopInputQueue';
import { acknowledgeDesktopText, desktopTextSubmission } from '@/sync/desktopKeyboardDraft';

const native = vi.hoisted(() => ({ focused: false, focus: vi.fn(), blur: vi.fn(), listeners: new Map<string, (event?: unknown) => void>() }));
vi.hoisted(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => { callback(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    Platform: { OS: 'ios' }, Dimensions: { get: () => ({ width: 800, height: 400 }) },
    StyleSheet: { create: (styles: unknown) => styles },
    Keyboard: { dismiss: vi.fn(), addListener: (name: string, listener: (event?: unknown) => void) => {
        native.listeners.set(name, listener); return { remove: () => native.listeners.delete(name) };
    } },
}));
vi.mock('expo-blur', () => ({ BlurView: 'BlurView' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/text/remoteDesktopLabels', () => ({ remoteDesktopLabels: () => ({ text: '输入文字', send: '输入', close: '关闭' }) }));
import { RemoteDesktopKeyboard, type RemoteDesktopKeyboardProps } from './RemoteDesktopKeyboard';

let renderer: ReturnType<typeof create> | undefined;
const byId = (id: string) => renderer.root.findAll((node: { props: { testID?: string } }) => node.props.testID === id)[0];
function mount(onInput: RemoteDesktopKeyboardProps['onInput'], extra: Partial<RemoteDesktopKeyboardProps> = {}) {
    const props = { visible: true, enabled: true, onInput, onClose: vi.fn(), ...extra };
    act(() => {
        renderer = create(React.createElement(RemoteDesktopKeyboard, props), { createNodeMock: (element: { type: string }) => element.type === 'TextInput' ? {
            focus: () => { native.focus(); native.focused = true; }, blur: () => { native.blur(); native.focused = false; }, isFocused: () => native.focused,
        } : null });
    });
    return props;
}
function edit(value: string) { act(() => byId('desktop-text-input').props.onChangeText(value)); }
function press(id: string) {
    let result!: Promise<boolean>;
    act(() => { result = byId(id).props.onPress(); });
    return result;
}
function commit(value: string) { act(() => byId('desktop-text-input').props.onEndEditing({ nativeEvent: { text: value } })); }
function expandKeys() { act(() => byId('desktop-keyboard-shortcuts').props.onPress()); }

beforeEach(() => { native.focused = false; native.listeners.clear(); vi.clearAllMocks(); });
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; });

describe('remote desktop keyboard regression', () => {
    it('focuses a real native input, commits Chinese IME before dispatch, and reports only OS keyboard height', async () => {
        const dispatch = vi.fn().mockResolvedValue(true), height = vi.fn();
        mount(dispatch, { enabled: false, onKeyboardHeight: height });
        expect(native.focus).toHaveBeenCalled();
        expect(byId('desktop-text-input').props.autoFocus).toBe(true);
        expect(byId('desktop-text-input').props.disableFullscreenUI).toBe(true);
        expect(byId('desktop-text-input').props.editable).not.toBe(false);
        edit('zhong');
        expect(byId('desktop-type').props.disabled).toBe(true);
        native.listeners.get('keyboardWillChangeFrame')!({ endCoordinates: { screenY: 200, height: 200 } });
        expect(height).toHaveBeenLastCalledWith(200);
        native.listeners.get('keyboardDidHide')!(); expect(height).toHaveBeenLastCalledWith(0);
        act(() => renderer.update(React.createElement(RemoteDesktopKeyboard, { visible: true, enabled: true, onInput: dispatch, onClose: vi.fn(), onKeyboardHeight: height })));
        const result = press('desktop-type');
        expect(native.blur).toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
        commit('中文');
        await act(async () => { expect(await result).toBe(true); });
        expect(dispatch).toHaveBeenCalledExactlyOnceWith({ action: 'text', text: '中文' });
        expect(byId('desktop-text-input').props.value).toBe('');
        expandKeys();
        await act(async () => { await byId('desktop-key-c-command').props.onPress(); });
        expect(dispatch).toHaveBeenLastCalledWith({ action: 'key', key: 'c', modifiers: ['command'] });
    });

    it('treats missing, refused or wrong-sequence HTTP 200 receipts as unconfirmed and never drains later keys', async () => {
        expect(desktopInputAcknowledged({ accepted: true, sequence: 4 }, 4)).toBe(true);
        for (const receipt of [{ sequence: 4 }, { accepted: false, sequence: 4 }, { accepted: true, sequence: 3 }]) {
            const dispatch = vi.fn(async () => { if (!desktopInputAcknowledged(receipt, 4)) throw new Error('desktop-operation-unknown'); });
            const queue = new DesktopInputQueue(dispatch, vi.fn());
            expect(await queue.send({ action: 'text', text: '中文' })).toBe(false);
            expect(await queue.send({ action: 'key', key: 'enter', modifiers: [] })).toBe(false);
            expect(dispatch).toHaveBeenCalledTimes(1);
        }
    });

    it('blocks a second tap while a receipt is pending and retains edits made before its late acceptance', async () => {
        let accept!: (value: boolean) => void;
        const dispatch = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve; }));
        const props = mount(dispatch);
        edit('hello'); const result = press('desktop-type'); commit('hello');
        expect(await press('desktop-type')).toBe(false); expect(dispatch).toHaveBeenCalledTimes(1);
        edit('hello世界');
        await act(async () => { accept(true); await result; });
        expect(byId('desktop-text-input').props.value).toBe('世界');
        act(() => renderer.update(React.createElement(RemoteDesktopKeyboard, { ...props, visible: false })));
        act(() => renderer.update(React.createElement(RemoteDesktopKeyboard, props)));
        expect(byId('desktop-text-input').props.value).toBe('世界');
        expect(acknowledgeDesktopText({ text: 'hallo!', revision: 2 }, { text: 'hello', revision: 1 })).toBe('hallo!');
        expect(acknowledgeDesktopText({ text: 'hello世界', revision: 3 }, { text: 'hello', revision: 1 }, false)).toBe('hello世界');
    });

    it('keeps an unconfirmed draft and does not send Enter after the failed text attempt', async () => {
        const dispatch = vi.fn().mockResolvedValue(false); mount(dispatch);
        expandKeys();
        edit('中文'); const result = press('desktop-key-enter-plain'); commit('中文');
        await act(async () => { expect(await result).toBe(false); });
        expect(byId('desktop-text-input').props.value).toBe('中文');
        expect(dispatch).toHaveBeenCalledExactlyOnceWith({ action: 'text', text: '中文' });
    });

    it('does not resend confirmed text when the following Enter outcome is unknown', async () => {
        const dispatch = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('desktop-operation-unknown')); mount(dispatch);
        expandKeys();
        edit('hello'); const result = press('desktop-key-enter-plain'); commit('hello');
        await act(async () => { expect(await result).toBe(false); });
        expect(dispatch.mock.calls.map(([input]) => input)).toEqual([{ action: 'text', text: 'hello' }, { action: 'key', key: 'enter', modifiers: [] }]);
        expect(byId('desktop-text-input').props.value).toBe(''); expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it('bounds Unicode text in UTF-16 units without truncating or partially submitting it', () => {
        expect(desktopTextSubmission({ text: '🙂'.repeat(1024), revision: 1 })?.text.length).toBe(2048);
        expect(desktopTextSubmission({ text: '🙂'.repeat(1025), revision: 2 })).toBeNull();
    });
});
