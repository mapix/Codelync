import * as React from 'react';
// @ts-expect-error The existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', () => ({ ActivityIndicator: 'Spinner', Pressable: 'Button', Text: 'Text', View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray' } } }),
    StyleSheet: { create: () => ({ root: {}, action: { minHeight: 44, minWidth: 44 } }) } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/useCodelyncConnectionState', () => ({ useCodelyncConnectionState: vi.fn() }));
vi.mock('@/sync/codelyncConnection', () => ({ getConnectionSnapshot: vi.fn(), retryCodelyncConnection: vi.fn(), selectConnection: vi.fn() }));
vi.mock('./PeerChannelControlView', () => ({ PeerChannelControlView: (props: any) => React.createElement('PickerControl', props) }));
import { CodelyncConnectionNoticeView } from './CodelyncConnectionNotice';
const snapshot: any = { peerId: 'paired', selectedId: 'local', automatic: true, connecting: false, channels: [] };
const state: any = { kind: 'failed', canRetry: true, canInspect: true, busy: false };
function mount(props: any = {}) { let view!: ReturnType<typeof create>; act(() => { view = create(React.createElement(CodelyncConnectionNoticeView,
    { state, snapshot, onRetry: vi.fn(), onSelect: vi.fn(), onScan: vi.fn(), ...props })); }); return view; }
it('terminal connection failure has actionable fixed text without a loading spinner', () => {
    const view = mount(); expect(view.root.findAllByType('Spinner')).toHaveLength(0);
    expect(view.root.findAllByType('Text').map((n: any) => n.props.children)).toContain('codelyncChannels.failedTitle');
    expect(view.root.findByProps({ testID: 'codelync-retry-mac-connection' }).props.accessibilityRole).toBe('button');
    expect(view.root.findAllByType('PickerControl')).toHaveLength(1); act(() => view.unmount());
});
it('connecting keeps the picker available without causing a connection action on mount', () => {
    const onSelect = vi.fn(), onRetry = vi.fn(); const view = mount({ state: { ...state, kind: 'connecting', busy: true }, onSelect, onRetry });
    expect(view.root.findAllByType('Spinner')).toHaveLength(1); expect(view.root.findAllByType('PickerControl')).toHaveLength(1);
    expect(onSelect).not.toHaveBeenCalled(); expect(onRetry).not.toHaveBeenCalled(); act(() => view.unmount());
});
it('a repeated retry coalesces, displays no raw exception, and clears after recovery', async () => {
    let reject!: (error: Error) => void; const onRetry = vi.fn(() => new Promise<void>((_yes, no) => { reject = no; }));
    const view = mount({ onRetry }); const retry = view.root.findByProps({ testID: 'codelync-retry-mac-connection' });
    act(() => { retry.props.onPress(); retry.props.onPress(); }); expect(onRetry).toHaveBeenCalledOnce();
    expect(view.root.findByProps({ testID: 'codelync-retry-mac-connection' }).props.disabled).toBe(true);
    await act(async () => reject(Error('private-token-fixture https://private.invalid')));
    expect(JSON.stringify(view.toJSON())).not.toContain('private-token-fixture');
    act(() => view.update(React.createElement(CodelyncConnectionNoticeView, { state: { ...state, kind: 'connected' }, snapshot, onRetry, onSelect: vi.fn(), onScan: vi.fn() })));
    expect(view.toJSON()).toBeNull(); act(() => view.unmount());
});
it('access refusal only scans after the user explicitly presses the current Mac action', () => {
    const onScan = vi.fn(), onRetry = vi.fn(); const view = mount({ state: { ...state, kind: 'access-ended', canRetry: false }, onScan, onRetry });
    expect(onScan).not.toHaveBeenCalled(); expect(view.root.findAllByProps({ testID: 'codelync-retry-mac-connection' })).toHaveLength(0);
    act(() => view.root.findByProps({ testID: 'codelync-scan-current-mac' }).props.onPress()); expect(onScan).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled(); act(() => view.unmount());
});
it('an old Mac completion cannot change a new Mac notice', async () => {
    let reject!: (e: Error) => void; const onRetry = vi.fn(() => new Promise<void>((_yes, no) => { reject = no; }));
    const view = mount({ onRetry }); act(() => view.root.findByProps({ testID: 'codelync-retry-mac-connection' }).props.onPress());
    act(() => view.update(React.createElement(CodelyncConnectionNoticeView, { state: { ...state, kind: 'connecting', busy: true },
        snapshot: { ...snapshot, peerId: 'other' }, onRetry, onSelect: vi.fn(), onScan: vi.fn() })));
    await act(async () => reject(Error('old failure'))); expect(view.root.findAllByType('Spinner')).toHaveLength(1); act(() => view.unmount());
});
