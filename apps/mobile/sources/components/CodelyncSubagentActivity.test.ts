import * as React from 'react';
// @ts-expect-error The existing native renderer ships no declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { subscribeCodelyncLatestViewport } from '@/utils/codelyncSubagentActivityIntent';
import { codelyncActivityLabels } from '@/text/codelyncActivityLabels';
import { SUPPORTED_LANGUAGE_CODES } from '@/text/_all';
const mock = vi.hoisted(() => ({ read: vi.fn(), stop: vi.fn(), dismiss: vi.fn(), scope: '', snapshots: [] as Array<{ scope: string; rows: any[] }> }));
vi.mock('react-native', () => ({ ActivityIndicator: 'Spinner', Text: 'Text', View: 'View', Pressable: 'Button', Keyboard: { dismiss: mock.dismiss },
    Modal: (props: any) => props.visible ? React.createElement('Modal', props, props.children) : null,
    FlatList: (props: any) => { mock.snapshots.push({ scope: mock.scope, rows: props.data }); return React.createElement('List', props, props.data.map((item: any) => props.renderItem({ item })), !props.data.length && props.ListEmptyComponent); } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({}) }, useUnistyles: () => ({ theme: { colors: { textSecondary: 'gray' } } }) }));
vi.mock('@/sync/noninvasiveRpc', () => ({ readNoninvasiveOperationLogs: mock.read, subscribeNoninvasiveOperationLogs: () => mock.stop }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
vi.mock('@/sync/storage', () => ({ useSessionMessages: () => ({ messages: [] }) }));
import { CodelyncSubagentActivity } from './CodelyncSubagentActivity';
const session = { id: 'child', metadata: { client: { id: 'noninvasive-bridge' }, bridge: { controlMode: 'session', sourceStatus: 'connected', source: { app: 'codex', id: 'native-child', hostId: 'local', kind: 'session', runtimeGeneration: 'owner' } } } } as Session;
const source = { sessionId: 'child', app: 'codex', nativeConversationId: 'native-child', hostId: 'local', ownerGeneration: 'owner' };
const text = (view: ReturnType<typeof create>) => view.root.findAllByType('Text').map((node: any) => node.props.children).flat().join(' ');

it('reads only local receipts on expansion and returns messages/tools to the existing latest viewport', async () => {
    mock.read.mockReset(); mock.read.mockResolvedValue([{ authority: 'peer:one', entityId: 'child', source, method: 'abort', commandId: 'command', stage: 'unconfirmed', at: 1 }]);
    const latest = vi.fn(), stop = subscribeCodelyncLatestViewport(session.id, latest);
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(CodelyncSubagentActivity, { session })); });
    expect(mock.read).not.toHaveBeenCalled();
    await act(async () => { view.root.findByProps({ testID: 'codelync-subagent-activity' }).props.onPress(); });
    expect(mock.read).toHaveBeenCalledExactlyOnceWith('child'); expect(text(view)).toContain('Delivery unconfirmed'); expect(text(view)).not.toContain('Retry');
    act(() => view.root.findByProps({ testID: 'codelync-subagent-message-log' }).props.onPress());
    expect(latest).toHaveBeenCalledOnce(); expect(view.root.findAllByProps({ testID: 'codelync-subagent-activity-panel' })).toHaveLength(0);
    act(() => view.unmount()); stop();
});
it('does not fabricate a log control for an unverified owner', () => {
    mock.read.mockClear(); let view!: ReturnType<typeof create>;
    const unknown = { ...session, metadata: { ...session.metadata, bridge: { ...session.metadata!.bridge, source: { ...session.metadata!.bridge!.source, runtimeGeneration: null } } } } as Session;
    act(() => { view = create(React.createElement(CodelyncSubagentActivity, { session: unknown })); });
    expect(view.root.findAllByType('Button')).toHaveLength(0); expect(mock.read).not.toHaveBeenCalled(); act(() => view.unmount());
});

it('does not render a previous-owner snapshot under the new owner before its fresh local read', async () => {
    const events = [{ authority: 'peer:one', entityId: 'child', source, method: 'abort', commandId: 'old-command', stage: 'unconfirmed', at: 1 }];
    mock.read.mockReset(); mock.read.mockResolvedValueOnce(events); mock.snapshots = []; mock.scope = 'owner';
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(CodelyncSubagentActivity, { session })); });
    await act(async () => view.root.findByProps({ testID: 'codelync-subagent-activity' }).props.onPress());
    let finish!: (value: typeof events) => void;
    mock.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const changed = { ...session, metadata: { ...session.metadata, bridge: { ...session.metadata!.bridge,
        source: { ...session.metadata!.bridge!.source, runtimeGeneration: 'new-owner' } } } } as Session;
    mock.scope = 'new-owner';
    act(() => view.update(React.createElement(CodelyncSubagentActivity, { session: changed })));
    expect(mock.snapshots.filter(entry => entry.scope === 'new-owner').flatMap(entry => entry.rows)).toHaveLength(0);
    expect(text(view)).toContain('Reading receipts');
    await act(async () => finish(events));
    expect(text(view)).toContain('Previous owner');
    act(() => view.unmount()); mock.scope = '';
});

it('retries only the failed local receipt read without replaying a linked operation', async () => {
    mock.read.mockReset(); mock.read.mockRejectedValueOnce(Error('Local read unavailable')).mockResolvedValueOnce([]);
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(CodelyncSubagentActivity, { session })); });
    await act(async () => view.root.findByProps({ testID: 'codelync-subagent-activity' }).props.onPress());
    expect(text(view)).toContain('Receipt logs unavailable.');
    await act(async () => view.root.findByProps({ testID: 'codelync-retry-operation-log' }).props.onPress());
    expect(mock.read).toHaveBeenCalledTimes(2);
    expect(text(view)).toContain('No linked control receipts');
    expect(view.root.findAllByProps({ testID: 'codelync-retry-operation-log' })).toHaveLength(0);
    act(() => view.unmount());
});
it.each(SUPPORTED_LANGUAGE_CODES)('%s labels every receipt outcome and unavailable log state', language => {
    const labels = codelyncActivityLabels[language];
    for (const value of [labels.title, labels.messages, labels.empty, labels.loading, labels.unavailable, labels.close, labels.owner, labels.previousOwner, ...Object.values(labels.status)]) expect(value.trim()).not.toBe('');
});
