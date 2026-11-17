import * as React from 'react';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { surface: 'white', divider: 'gray', text: 'black', textSecondary: 'gray' } };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (factory: any) => factory(theme), hairlineWidth: 1 } };
});
vi.mock('./StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ getCurrentLanguage:()=> 'en',t: (key: string, params?: { ms: number }) => params ? `${params.ms} ms` : key }));
vi.mock('./PickerSheet', () => ({
    PickerSheet: ({ children, ...props }: any) => React.createElement('PickerSheet', props, children),
    PickerSheetOption: (props: any) => React.createElement('Option', props),
}));
import { PeerChannelControlView, type PeerChannelSnapshot } from './PeerChannelControlView';

const snapshot: PeerChannelSnapshot = { peerId: 'verified-peer', selectedId: 'local-id', automatic: true, connecting: false,
    channels: [{ id: 'local-id', kind: 'local', url: 'http://192.0.2.10:4567', state: 'connected', latencyMs: 8.1 },
        { id: 'cloud-id', kind: 'cloudflare', url: 'https://tunnel.example', state: 'available', latencyMs: 80 },
        { id: 'relay-id', kind: 'relay', url: 'https://relay.example', state: 'failed' }] };

it('renders only verified routes with real state/latency and opens automatic plus manual choices', () => {
    const select = vi.fn(async () => {}); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(PeerChannelControlView, { snapshot, onSelect: select })); });
    const open = renderer.root.findAll((node: any) => node.props.testID === 'codelync-channel-open')[0];
    act(() => open.props.onPress());
    expect(renderer.root.findByType('PickerSheet').props.visible).toBe(true);
    const options = renderer.root.findAllByType('Option'); expect(options).toHaveLength(4); expect(options[0].props.selected).toBe(true);
    expect(options[1].props.description).toContain('192.0.2.10:4567'); expect(options[1].props.description).toContain('8 ms');
    expect(options[3].props.description).toContain('codelyncChannels.latencyUnknown'); expect(options[3].props.disabled).not.toBe(true);
    expect(select).not.toHaveBeenCalled(); act(() => renderer.unmount());
});

it('serializes manual choice and reports failure without changing the existing selected route', async () => {
    let reject!: (error: Error) => void;
    const select = vi.fn(() => new Promise<void>((_resolve, no) => { reject = no; })); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(PeerChannelControlView, { snapshot: { ...snapshot, automatic: false }, onSelect: select })); });
    act(() => renderer.root.findAll((node: any) => node.props.testID === 'codelync-channel-open')[0].props.onPress());
    const relay = renderer.root.findAllByType('Option')[3];
    act(() => { relay.props.onPress(); relay.props.onPress(); });
    expect(select).toHaveBeenCalledTimes(1); expect(select).toHaveBeenCalledWith('relay-id');
    expect(renderer.root.findAllByType('Option').every((node: any) => node.props.disabled !== true)).toBe(true);
    await act(async () => { reject(Error('credential value must never enter UI')); });
    expect(renderer.root.findByType('PickerSheet').props.visible).toBe(true);
    expect(renderer.root.findAllByType('Option')[1].props.selected).toBe(true);
    expect(renderer.root.findAll((node: any) => node.props.testID === 'codelync-channel-error')[0].props.children).toBe('Choice saved. It is not connected yet.');
    act(() => renderer.unmount());
});

it('an old peer completion cannot close a newly opened peer sheet', async () => {
    let finish!: () => void; const select = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(PeerChannelControlView, { snapshot, onSelect: select })); });
    act(() => renderer.root.findAll((node: any) => node.props.testID === 'codelync-channel-open')[0].props.onPress());
    act(() => renderer.root.findAllByType('Option')[2].props.onPress());
    act(() => renderer.update(React.createElement(PeerChannelControlView, { snapshot: { ...snapshot, peerId: 'new-verified-peer' }, onSelect: select })));
    act(() => renderer.root.findAll((node: any) => node.props.testID === 'codelync-channel-open')[0].props.onPress());
    await act(async () => { finish(); });
    expect(renderer.root.findByType('PickerSheet').props.visible).toBe(true);
    act(() => renderer.unmount());
});

it('a global settings row keeps route selection explicit and uses the same automatic/manual picker', async () => {
    const select = vi.fn(async () => {}); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(PeerChannelControlView, { snapshot, onSelect: select, presentation: 'settings' })); });
    expect(select).not.toHaveBeenCalled();
    const trigger = renderer.root.findAll((node: any) => node.props.testID === 'codelync-channel-open')[0];
    expect(trigger.findAll((node: any) => node.type === 'Text' && node.props.children === 'codelyncChannels.title')).toHaveLength(1);
    act(() => trigger.props.onPress());
    const automatic = renderer.root.findAllByType('Option')[0];
    await act(async () => { automatic.props.onPress(); });
    expect(select).toHaveBeenCalledOnce(); expect(select).toHaveBeenCalledWith('auto');
    expect(renderer.root.findByType('PickerSheet').props.visible).toBe(false);
    act(() => renderer.unmount());
});

it('a header indicator has no visible route label and opens the same picker only when clicked', () => {
    const select = vi.fn(async () => {}); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(PeerChannelControlView, { snapshot, onSelect: select, presentation: 'header' })); });
    const trigger = renderer.root.findAll((node: any) => node.props.testID === 'codelync-channel-open')[0];
    expect(trigger.findAllByType('Text')).toHaveLength(0);
    expect(trigger.props.accessibilityLabel).toContain('codelyncChannels.automatic');
    expect(select).not.toHaveBeenCalled();
    act(() => trigger.props.onPress()); expect(renderer.root.findByType('PickerSheet').props.visible).toBe(true);
    act(() => renderer.unmount());
});

it('an external connection recovery clears an obsolete picker error', async () => {
    const select=vi.fn().mockRejectedValue(Error('fixed fixture failure'));let renderer!:ReturnType<typeof create>;
    act(()=>{renderer=create(React.createElement(PeerChannelControlView,{snapshot,onSelect:select}));});
    act(()=>renderer.root.findAll((n:any)=>n.props.testID==='codelync-channel-open')[0].props.onPress());
    await act(async()=>renderer.root.findAllByType('Option')[3].props.onPress());
    expect(renderer.root.findAll((n:any)=>n.props.testID==='codelync-channel-error').length).toBeGreaterThan(0);
    const recovered={...snapshot,channels:snapshot.channels.map(channel=>channel.id===snapshot.selectedId?{...channel,state:'connected' as const}:channel)};
    act(()=>renderer.update(React.createElement(PeerChannelControlView,{snapshot:recovered,onSelect:select})));
    expect(renderer.root.findAll((n:any)=>n.props.testID==='codelync-channel-error')).toHaveLength(0);act(()=>renderer.unmount());
});
it('saved routes can still be inspected while a connection probe is running',()=>{
    const select=vi.fn();let renderer!:ReturnType<typeof create>;
    act(()=>{renderer=create(React.createElement(PeerChannelControlView,{snapshot:{...snapshot,connecting:true},onSelect:select}));});
    act(()=>renderer.root.findAll((n:any)=>n.props.testID==='codelync-channel-open')[0].props.onPress());
    expect(renderer.root.findByType('PickerSheet').props.visible).toBe(true);expect(select).not.toHaveBeenCalled();act(()=>renderer.unmount());
});

it('header geometry and icon node remain fixed across socket flapping, with details only inside the picker', () => {
    const select = vi.fn(async () => {}); let renderer!: ReturnType<typeof create>;
    const state = (kind: 'connected' | 'connecting' | 'failed') => ({ kind, busy: kind === 'connecting', canRetry: true, canInspect: true });
    act(() => { renderer = create(React.createElement(PeerChannelControlView, { snapshot, onSelect: select, presentation: 'header', connectionState: state('connected') })); });
    const slot = renderer.root.findByProps({ testID: 'codelync-channel-header-slot' });
    const trigger = renderer.root.findByProps({ testID: 'codelync-channel-open' });
    const icon = renderer.root.findByProps({ testID: 'codelync-channel-status-icon' });
    expect(slot.props.style[0]).toMatchObject({ width: 44, height: 44 }); expect(trigger.props.style).toMatchObject({ width: 44, height: 44 });
    for (const [kind, name] of [['connecting', 'sync-outline'], ['failed', 'alert-circle-outline'], ['connected', 'wifi-outline']] as const) {
        act(() => renderer.update(React.createElement(PeerChannelControlView, { snapshot, onSelect: select, presentation: 'header', connectionState: state(kind) })));
        expect(renderer.root.findByProps({ testID: 'codelync-channel-header-slot' })).toBe(slot);
        expect(renderer.root.findByProps({ testID: 'codelync-channel-status-icon' })).toBe(icon); expect(icon.props.name).toBe(name);
        expect(trigger.findAllByType('ActivityIndicator')).toHaveLength(0); expect(trigger.findAllByType('Text')).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'codelync-channel-connection-error' })).toHaveLength(0);
    }
    act(() => renderer.update(React.createElement(PeerChannelControlView, { snapshot, onSelect: select, presentation: 'header', connectionState: state('failed') })));
    act(() => trigger.props.onPress()); expect(renderer.root.findByProps({ testID: 'codelync-channel-connection-error' }).props.children).toBe('codelyncChannels.failedHelp');
    expect(renderer.root.findAllByType('PickerSheet')).toHaveLength(1); expect(select).not.toHaveBeenCalled(); act(() => renderer.unmount());
});
it('source read failure keeps its explicit retry during independent socket recovery and coalesces presses', async () => {
    let finish!: () => void; const retry = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), select = vi.fn();
    const props = { snapshot, onSelect: select, presentation: 'header' as const, sourceNotice: { scope: 'session-a', message: 'Read failed fixture', failed: true, retry } };
    let renderer!: ReturnType<typeof create>; act(() => { renderer = create(React.createElement(PeerChannelControlView, props)); });
    expect(renderer.root.findAllByProps({ testID: 'codelync-channel-source-notice' })).toHaveLength(0);
    act(() => renderer.root.findByProps({ testID: 'codelync-channel-open' }).props.onPress());
    const button = renderer.root.findByProps({ testID: 'codelync-channel-read-retry' });
    await act(async () => { button.props.onPress(); button.props.onPress(); }); expect(retry).toHaveBeenCalledOnce(); expect(select).not.toHaveBeenCalled();
    act(() => renderer.update(React.createElement(PeerChannelControlView, { ...props, connectionState: { kind: 'connecting', busy: true, canRetry: true, canInspect: true } })));
    expect(renderer.root.findByProps({ testID: 'codelync-channel-source-notice' }).props.children).toBe('Read failed fixture');
    expect(renderer.root.findByProps({ testID: 'codelync-channel-read-retry' }).props.disabled).toBe(true);
    await act(async () => { finish(); }); expect(renderer.root.findByProps({ testID: 'codelync-channel-read-retry' }).props.disabled).toBe(false); act(() => renderer.unmount());
});
it('an old source retry completion cannot reset busy state for the new source', async () => {
    let oldFinish!: () => void, nextFinish!: () => void;
    const oldRetry = vi.fn(() => new Promise<void>(resolve => { oldFinish = resolve; })), nextRetry = vi.fn(() => new Promise<void>(resolve => { nextFinish = resolve; }));
    const props = { snapshot, onSelect: vi.fn(), presentation: 'header' as const, sourceNotice: { scope: 'old', message: 'Fixture read failed', failed: true, retry: oldRetry } };
    let renderer!: ReturnType<typeof create>; act(() => { renderer = create(React.createElement(PeerChannelControlView, props)); });
    act(() => renderer.root.findByProps({ testID: 'codelync-channel-open' }).props.onPress());
    await act(async () => renderer.root.findByProps({ testID: 'codelync-channel-read-retry' }).props.onPress());
    act(() => renderer.update(React.createElement(PeerChannelControlView, { ...props, sourceNotice: { ...props.sourceNotice, scope: 'new', retry: nextRetry } })));
    await act(async () => renderer.root.findByProps({ testID: 'codelync-channel-read-retry' }).props.onPress());
    await act(async () => oldFinish()); expect(renderer.root.findByProps({ testID: 'codelync-channel-read-retry' }).props.disabled).toBe(true);
    await act(async () => nextFinish()); expect(renderer.root.findByProps({ testID: 'codelync-channel-read-retry' }).props.disabled).toBe(false); act(() => renderer.unmount());
});
it('cold unpaired header keeps the same slot and a scan recovery without any selection', () => {
    const scan = vi.fn(), select = vi.fn(); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(PeerChannelControlView, { snapshot: { ...snapshot, peerId: null, channels: [] }, onSelect: select, presentation: 'header', onScan: scan })); });
    expect(renderer.root.findByProps({ testID: 'codelync-channel-status-icon' }).props.name).toBe('alert-circle-outline');
    act(() => renderer.root.findByProps({ testID: 'codelync-channel-open' }).props.onPress());
    act(() => renderer.root.findByProps({ testID: 'codelync-channel-scan' }).props.onPress()); expect(scan).toHaveBeenCalledOnce(); expect(select).not.toHaveBeenCalled(); act(() => renderer.unmount());
});

it('manual intent stays checked while another admitted route remains readable and a failed choice is visible',()=>{
 const pending={...snapshot,automatic:false,selectedId:'local-id',activeId:'cloud-id',desiredKind:'local' as const,writable:false,failureCode:'connection-failed' as const};let renderer!:ReturnType<typeof create>;
 act(()=>{renderer=create(React.createElement(PeerChannelControlView,{snapshot:pending,onSelect:vi.fn(),presentation:'settings'}));});
 const open=renderer.root.findByProps({testID:'codelync-channel-open'});expect(open.props.accessibilityLabel).toContain('Selected: codelyncChannels.local');expect(open.props.accessibilityLabel).toContain('Current connection: codelyncChannels.cloudflare');
 act(()=>open.props.onPress());expect(renderer.root.findAllByType('Option')[0].props.selected).toBe(false);expect(renderer.root.findAllByType('Option')[1].props.selected).toBe(true);
 expect(renderer.root.findByProps({testID:'codelync-channel-error'}).props.children).toBe('Choice saved. It is not connected yet.');act(()=>renderer.unmount());
});
