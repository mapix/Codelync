import * as React from 'react';
// @ts-expect-error The native test renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Metadata } from '@/sync/storageTypes';
import { CodelyncViewportFill, codelyncNativeWindowEnd } from '@/utils/codelyncViewport';
import { nativeReadingControlsUnavailable } from '@/utils/nativeReadingWindow';
import { canSendToNoninvasiveSource } from '@/sync/noninvasiveBridge';
const peer = vi.hoisted(() => ({ id: 'peer:one', listeners: new Set<() => void>() }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerIdentity: () => peer.id,
    onStatusChange: (listener: () => void) => { peer.listeners.add(listener); return () => peer.listeners.delete(listener); } } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://fixture.invalid' }));
import { useNativeReadingWindow } from './useNativeReadingWindow';

function metadata(owner: string | null = 'owner-a'): Metadata {
    return { client: { id: 'noninvasive-bridge' }, machineId: 'machine', capabilities: { steering: true },
        bridge: { source: { app: 'claude-desktop', kind: 'session', id: 'native-one', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
            protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions', runtimeGeneration: owner, windowGeneration: null },
            controlMode: 'session', sourceStatus: owner ? 'connected' : 'owner-unavailable', currentTurnId: null } } as Metadata;
}
let state: { key: string; fill: CodelyncViewportFill; windowEnd: number; expanded: boolean; bodyVisible: boolean; open(): void };
// Exercise the real reading key + viewport object used by ChatList; the retained
// window contains one legacy row, three native tools and the confirmed reply.
function Probe({ value }: { value: Metadata }) {
    const key = useNativeReadingWindow('relay', value);
    const fill = React.useMemo(() => new CodelyncViewportFill(), [key]);
    const [windowEnd, setEnd] = React.useState(1), [expanded, setExpanded] = React.useState(false);
    React.useEffect(() => { setEnd(1); setExpanded(false); }, [fill]);
    state = { key, fill, windowEnd, expanded, bodyVisible: codelyncNativeWindowEnd(5, windowEnd) === 5,
        open() { setEnd(5); setExpanded(true); } };
    return null;
}
const screens: ReturnType<typeof create>[] = [];
beforeEach(() => { peer.id = 'peer:one'; peer.listeners.clear(); });
afterEach(() => { for (const screen of screens.splice(0)) act(() => screen.unmount()); });
function mount(value: Metadata) { let screen!: ReturnType<typeof create>; act(() => { screen = create(React.createElement(Probe, { value })); }); screens.push(screen); return screen; }

it('retains an expanded three-tool window and confirmed body when the same authenticated source temporarily loses its owner', () => {
    const value = metadata(), screen = mount(value); act(() => state.open());
    const key = state.key, fill = state.fill; expect(state.bodyVisible).toBe(true); expect(state.expanded).toBe(true);
    const lost = metadata(null); act(() => screen.update(React.createElement(Probe, { value: lost })));
    expect(state.key).toBe(key); expect(state.fill).toBe(fill); expect(state.windowEnd).toBe(5); expect(state.expanded).toBe(true); expect(state.bodyVisible).toBe(true);
    expect(lost.bridge?.source.runtimeGeneration).toBeNull(); expect(lost.bridge?.sourceStatus).toBe('owner-unavailable');
    expect(nativeReadingControlsUnavailable(lost)).toBe(true); expect(canSendToNoninvasiveSource(lost)).toBe(false);
    act(() => screen.update(React.createElement(Probe, { value: metadata() })));
    expect(state.key).toBe(key); expect(state.windowEnd).toBe(5);
});

it.each(['owner', 'peer', 'host', 'native-id', 'collection'])('isolates the reading window on positive %s replacement', change => {
    const screen = mount(metadata()); act(() => state.open()); const key = state.key, fill = state.fill;
    const value = metadata();
    if (change === 'owner') value.bridge!.source.runtimeGeneration = 'owner-b';
    if (change === 'peer') peer.id = 'peer:two';
    if (change === 'host') value.bridge!.source.hostId = 'local:claude-desktop:' + 'b'.repeat(64);
    if (change === 'native-id') value.bridge!.source.id = 'native-two';
    if (change === 'collection') { value.bridge!.source.appMode = 'chat'; value.bridge!.source.nativeCollection = 'local-agent-mode-sessions'; }
    act(() => { for (const listener of peer.listeners) listener(); screen.update(React.createElement(Probe, { value })); });
    expect(state.key).not.toBe(key); expect(state.fill).not.toBe(fill); expect(state.windowEnd).toBe(1); expect(state.expanded).toBe(false); expect(state.bodyVisible).toBe(false);
    if (change === 'owner') {
        value.bridge!.source.runtimeGeneration = null; value.bridge!.sourceStatus = 'owner-unavailable'; const replacement = state.key;
        act(() => screen.update(React.createElement(Probe, { value: { ...value } })));
        expect(state.key).toBe(replacement); expect(state.key).not.toBe(key);
    }
});

it('never inherits a prior authenticated source scope when native identity is unavailable', () => {
    const screen = mount(metadata()); act(() => state.open()); const key = state.key;
    const value = metadata(null); value.bridge!.source.id = '';
    act(() => screen.update(React.createElement(Probe, { value })));
    expect(state.key).not.toBe(key); expect(state.bodyVisible).toBe(false);
});

it('starts with an unknown reading owner when cold metadata has no controller, without inferring one from cached content', () => {
    const value = metadata(null); mount(value);
    expect(JSON.parse(state.key).owner).toBeNull(); expect(state.windowEnd).toBe(1);
    expect(nativeReadingControlsUnavailable(value)).toBe(true); expect(canSendToNoninvasiveSource(value)).toBe(false);
});
