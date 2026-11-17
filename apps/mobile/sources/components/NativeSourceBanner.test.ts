import React from 'react';
// @ts-expect-error This workspace does not ship declarations for its existing react-test-renderer runtime.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ select: vi.fn(), visible: vi.fn(), state: 'connecting', progress: 'idle', connected: true, recovering: false, revalidating:false, revalidationFailed:false, session: { id: 'test-session', metadata: { bridge: { sourceStatus: 'owner-unavailable' } } } }));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray', groupped: { background: 'white' } } } }) }));
vi.mock('@/sync/codelyncSessionSelection', () => ({ selectCodelyncSession: mocks.select, useCodelyncSelectionState: () => mocks.state }));
vi.mock('@/sync/storage', () => ({ useSession: () => mocks.session, useSocketStatus: () => ({ status: mocks.connected ? 'connected' : mocks.recovering ? 'connecting' : 'error' }) }));
vi.mock('@/sync/codelyncLoadingProgress', () => ({ useCodelyncMessageProgress: () => ({ phase: mocks.progress, revalidating:mocks.revalidating,revalidationFailed:mocks.revalidationFailed }) }));
vi.mock('@/sync/sync', () => ({ sync: { retryCodelyncSession: mocks.visible } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en', t: (value: string) => value }));
vi.mock('./NativeParentControl', () => ({ NativeParentControl: 'ParentControl' }));
import { NativeSourceBanner } from './NativeSourceBanner';
import { nativeSessionAvailabilityLabels } from '@/text/nativeSessionAvailabilityLabels';
import { nativeReadRecoveryLabels } from '@/text/nativeReadRecoveryLabels';

it('cached confirmation has distinct nonblocking copy and a failed revalidation retains an explicit read retry', () => {
    mocks.progress='complete';mocks.revalidating=true;
    let renderer!:ReturnType<typeof create>;act(()=>{renderer=create(React.createElement(NativeSourceBanner,{sessionId:'test-session'}));});
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
    expect(renderer.root.findAllByType('Text').map((node:any)=>node.props.children)).toContain(nativeReadRecoveryLabels.en.checking);
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    mocks.revalidating=false;mocks.revalidationFailed=true;
    act(()=>renderer.update(React.createElement(NativeSourceBanner,{sessionId:'test-session'})));
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
    expect(renderer.root.findAllByType('Text').map((node:any)=>node.props.children)).toContain(nativeReadRecoveryLabels.en.failed);
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(1);
    act(()=>renderer.unmount());mocks.revalidationFailed=false;
});

it('shows automatic progress without an Open Desktop button or navigation on preload mount', () => {
    mocks.state = 'connecting'; mocks.progress = 'idle'; mocks.select.mockReset();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session', topInset: 120 })); });
    expect(renderer.root.findAllByType('View')[0].props.style.paddingTop).toBe(134);
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    expect(mocks.select).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});
it('idle selection failure Retry only reads messages and coalesces repeated presses', async () => {
    mocks.state = 'failed'; mocks.progress = 'idle'; mocks.connected = true; mocks.recovering = false;
    mocks.select.mockClear(); mocks.visible.mockClear();
    let renderer!: ReturnType<typeof create>; act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    const retry = renderer.root.findByProps({ testID: 'codelync-retry-session-sync' }).props.onPress;
    await act(async () => { retry(); retry(); });
    expect(mocks.visible).toHaveBeenCalledExactlyOnceWith('test-session'); expect(mocks.select).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});
it('socket failure does not replace an in-flight source read with a connection error', () => {
    mocks.state = 'connecting'; mocks.progress = 'idle'; mocks.connected = false; mocks.recovering = false;
    let renderer!: ReturnType<typeof create>; act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).toContain('codelyncLoading.messages');
    act(() => renderer.unmount()); mocks.connected = true;
});
it('retries a failed message read without repeating a failed desktop selection', async () => {
    mocks.state = 'failed'; mocks.progress = 'error'; mocks.select.mockResolvedValue(undefined);
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    const button = renderer.root.findByType('Pressable');
    expect(button.props.testID).toBe('codelync-retry-session-sync'); expect(button.props.style.minHeight).toBe(44);
    expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).toContain('common.retry');
    await act(async () => { button.props.onPress(); }); expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.visible).toHaveBeenCalledWith('test-session');
    act(() => renderer.unmount());
});
it('cached disconnection and an older error show synchronization while a new read is loading', () => {
    mocks.state = 'selected'; mocks.progress = 'loading'; mocks.session.metadata.bridge.sourceStatus = 'disconnected';
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).toContain('codelyncLoading.messages');
    act(() => renderer.unmount());
});
it('a current fresh-read failure offers a read Retry without another desktop navigation', () => {
    mocks.state = 'selected'; mocks.progress = 'error'; mocks.select.mockClear(); mocks.visible.mockClear();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    act(() => renderer.root.findByType('Pressable').props.onPress());
    expect(mocks.visible).toHaveBeenCalledWith('test-session'); expect(mocks.select).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});
it('a read failure keeps its explicit Retry while the independent route recovers', () => {
    mocks.state = 'failed'; mocks.progress = 'error'; mocks.connected = false; mocks.recovering = true;
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(1);
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
    expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).toContain(nativeSessionAvailabilityLabels.en.readFailed);
    act(() => renderer.unmount()); mocks.connected = true; mocks.recovering = false;
});

it('keeps a terminal read failure actionable when the peer route has also failed', () => {
    mocks.state = 'selected'; mocks.progress = 'error'; mocks.connected = false; mocks.recovering = false;
    mocks.select.mockClear(); mocks.visible.mockClear();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
    expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).toContain(nativeSessionAvailabilityLabels.en.readFailed);
    act(() => renderer.root.findByType('Pressable').props.onPress());
    expect(mocks.visible).toHaveBeenCalledExactlyOnceWith('test-session');
    expect(mocks.select).not.toHaveBeenCalled();
    act(() => renderer.unmount()); mocks.connected = true;
});

it.each(['disconnected', 'owner-unavailable', 'locked', 'permission-required'])('a completed %s source offers read Retry without a permanent spinner', (status) => {
    mocks.state = 'selected'; mocks.progress = 'complete'; mocks.connected = true;
    mocks.session.metadata.bridge.sourceStatus = status; mocks.select.mockClear(); mocks.visible.mockClear();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
    expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).toContain(status === 'locked' ? nativeSessionAvailabilityLabels.en.locked : status === 'permission-required' ? nativeSessionAvailabilityLabels.en.permissionRequired : nativeSessionAvailabilityLabels.en.sourceUnavailable);
    expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.visible).not.toHaveBeenCalled();
    act(() => renderer.root.findByType('Pressable').props.onPress());
    expect(mocks.visible).toHaveBeenCalledExactlyOnceWith('test-session'); expect(mocks.select).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});

it('a new queued message read masks the previous completed unavailable source', () => {
    mocks.state = 'connecting'; mocks.progress = 'loading'; mocks.connected = true;
    mocks.session.metadata.bridge.sourceStatus = 'disconnected';
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
    expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).toContain('codelyncLoading.messages');
    act(() => renderer.unmount());
});

it.each(['connecting', 'failed'])('a successful fresh read clears synchronization UI despite %s desktop navigation', (state) => {
    mocks.state = state; mocks.progress = 'complete'; mocks.connected = true;
    mocks.session.metadata.bridge.sourceStatus = 'connected'; mocks.select.mockClear(); mocks.visible.mockClear();
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    expect(renderer.toJSON()).toBeNull();
    expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.visible).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});

it('a successful HTTP message read does not wait for the independent websocket to reconnect', () => {
    mocks.state = 'failed'; mocks.progress = 'complete'; mocks.connected = false; mocks.recovering = true;
    mocks.session.metadata.bridge.sourceStatus = 'connected';
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(NativeSourceBanner, { sessionId: 'test-session' })); });
    expect(renderer.toJSON()).toBeNull();
    act(() => renderer.unmount()); mocks.connected = true; mocks.recovering = false;
});
