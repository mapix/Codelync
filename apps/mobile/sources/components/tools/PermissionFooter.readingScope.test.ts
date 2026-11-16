import * as React from 'react';
// @ts-expect-error The native test renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ metadata: null as any, connected: true, listeners: new Set<() => void>(), allow: vi.fn(), deny: vi.fn(), modes: vi.fn() }));
vi.mock('react-native', async () => {
    const React = await import('react'); const host = (name: string) => (p: any) => React.createElement(name, p, p.children);
    return { View: host('View'), Text: host('Text'), ScrollView: host('Scroll'), TouchableOpacity: host('Button'),
        Platform: { OS: 'ios', select: (p: any) => p.ios ?? p.default }, StyleSheet: { create: (p: any) => p, absoluteFillObject: {} },
        useWindowDimensions: () => ({ width: 402, height: 874 }), Easing: { linear: () => 0 },
        Animated: { Value: class { setValue() {} stopAnimation() {} interpolate() { return 0; } }, View: host('AnimatedView'),
            timing: () => ({}), sequence: () => ({}), loop: () => ({ start() {}, stop() {} }) } };
});
vi.mock('react-native-unistyles', async () => { const { lightTheme } = await import('@/theme'); return { useUnistyles: () => ({ theme: lightTheme }) }; });
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: { relay: { metadata: mocks.metadata } } }),
    subscribe: (f: () => void) => { mocks.listeners.add(f); return () => mocks.listeners.delete(f); } } }));
vi.mock('@/sync/ops', () => ({ sessionAllow: mocks.allow, sessionDeny: mocks.deny, sessionSetAgentModes: mocks.modes }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => false }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerConnected: () => mocks.connected, onStatusChange: (f: () => void) => { mocks.listeners.add(f); return () => mocks.listeners.delete(f); } } }));
import { PermissionFooter } from './PermissionFooter';
const roots: ReturnType<typeof create>[] = [];
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); vi.clearAllMocks(); mocks.connected = true; mocks.listeners.clear(); });
const connected = () => ({ client: { id: 'noninvasive-bridge' }, flavor: 'codex', capabilities: { readOnly: false, steering: true },
    bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: 'turn', source: { app: 'codex', kind: 'session', id: 'native', hostId: 'local', runtimeGeneration: 'owner-a' } } });
const permission = { id: 'native-approval', status: 'pending' as const };

it('keeps cached approval visible but disables every action after temporary owner loss, including a stale captured click', async () => {
    mocks.metadata = connected(); let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(PermissionFooter, { permission, sessionId: 'relay', toolName: 'CodexBash', toolInput: {}, metadata: mocks.metadata })); }); roots.push(root);
    const initial = root.root.findAllByType('Button'); expect(initial.some((n: any) => n.props.disabled === false)).toBe(true);
    const captured = initial.find((n: any) => n.props.disabled === false)!.props.onPress;
    mocks.metadata = connected(); mocks.metadata.bridge.sourceStatus = 'owner-unavailable'; mocks.metadata.bridge.source.runtimeGeneration = null;
    act(() => { for (const listener of mocks.listeners) listener(); });
    expect(root.root.findAllByType('Button').every((n: any) => n.props.disabled === true)).toBe(true);
    await act(async () => captured()); expect(mocks.allow).not.toHaveBeenCalled(); expect(mocks.deny).not.toHaveBeenCalled(); expect(mocks.modes).not.toHaveBeenCalled();
    expect(permission.status).toBe('pending'); expect(mocks.metadata.bridge.source.runtimeGeneration).toBeNull();
});

it('readonly original-owner policy never enables cached approval buttons', () => {
    mocks.metadata = connected(); mocks.metadata.capabilities.readOnly = true; let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(PermissionFooter, { permission, sessionId: 'relay', toolName: 'CodexBash', toolInput: {}, metadata: mocks.metadata })); }); roots.push(root);
    expect(root.root.findAllByType('Button').every((n: any) => n.props.disabled === true)).toBe(true);
});
it('cached native approval remains visible offline, while every button and its captured callback are fenced', async () => {
    mocks.metadata = connected(); let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(PermissionFooter, { permission, sessionId: 'relay', toolName: 'CodexBash', toolInput: {}, metadata: mocks.metadata })); }); roots.push(root);
    const click = root.root.findAllByType('Button').find((node: any) => node.props.disabled === false)!.props.onPress;
    mocks.connected = false; act(() => { for (const listener of mocks.listeners) listener(); });
    expect(root.root.findAllByType('Button').every((node: any) => node.props.disabled === true)).toBe(true);
    await act(async () => click()); expect(mocks.allow).not.toHaveBeenCalled(); expect(mocks.deny).not.toHaveBeenCalled(); expect(mocks.modes).not.toHaveBeenCalled();
    expect(permission.status).toBe('pending'); expect(mocks.metadata.bridge.sourceStatus).toBe('connected');
    mocks.connected = true; act(() => { for (const listener of mocks.listeners) listener(); });
    expect(root.root.findAllByType('Button').some((node: any) => node.props.disabled === false)).toBe(true);
    expect(mocks.allow).not.toHaveBeenCalled();
});

it.each(['owner', 'turn'])('a captured pending approval never follows a positive %s replacement', async change => {
    const capturedMetadata = connected(); mocks.metadata = capturedMetadata; let root!: ReturnType<typeof create>;
    act(() => { root = create(React.createElement(PermissionFooter, { permission, sessionId: 'relay', toolName: 'CodexBash', toolInput: {}, metadata: capturedMetadata })); }); roots.push(root);
    const click = root.root.findAllByType('Button').find((n: any) => n.props.disabled === false)!.props.onPress;
    mocks.metadata = connected();
    if (change === 'owner') mocks.metadata.bridge.source.runtimeGeneration = 'owner-b';
    else mocks.metadata.bridge.currentTurnId = 'replacement-turn';
    act(() => { for (const listener of mocks.listeners) listener(); });
    expect(root.root.findAllByType('Button').every((n: any) => n.props.disabled === true)).toBe(true);
    await act(async () => click()); expect(mocks.allow).not.toHaveBeenCalled(); expect(mocks.deny).not.toHaveBeenCalled(); expect(mocks.modes).not.toHaveBeenCalled();
});
