import * as React from 'react';
// @ts-expect-error The existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ credentials: null as any, key: new Uint8Array(32) as Uint8Array | null, peer: 'peer:one', viewed: 'session',
    metadata: null as any, stores: new Set<() => void>(), statuses: new Set<() => void>(), savedRead: vi.fn(), close: vi.fn(), diagnostic: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: { getCredentials: () => state.credentials, encryption: { getSessionBlobKey: () => state.key } } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ currentViewingSessionId: state.viewed, sessions: { session: { metadata: state.metadata } } }),
    subscribe: (f: () => void) => { state.stores.add(f); return () => state.stores.delete(f); } } }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerIdentity: () => state.peer,
    onStatusChange: (f: () => void) => { state.statuses.add(f); return () => state.statuses.delete(f); } } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://channel-one' }));
vi.mock('@/sync/imageReadCredentials', () => ({ currentImageReadCredentials: state.savedRead }));
vi.mock('@/sync/nativeImageDiagnostics', () => ({ noteNativeImageStage: state.diagnostic }));
import { useAttachmentPreviewScope } from './useAttachmentPreviewScope';
let scope!: ReturnType<typeof useAttachmentPreviewScope>, renders = 0;
function Probe({ refValue = 'ref', live = false }: { refValue?: string; live?: boolean }) { renders++; scope = useAttachmentPreviewScope('session', refValue, state.close, live); return null; }
const roots: ReturnType<typeof create>[] = [];
beforeEach(() => { vi.clearAllMocks(); renders = 0; state.credentials = { token: 'owner-token', secret: 'account-one', peer: { id: 'one', device: { publicKey: 'device-one' } } };
    state.key = new Uint8Array(32); state.peer = 'peer:one'; state.viewed = 'session'; state.metadata = { client: { id: 'noninvasive-bridge' }, machineId: 'machine',
        bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null, source: { app: 'codex', kind: 'session', id: 'native', hostId: 'local', runtimeGeneration: 'owner-a' } } };
    state.savedRead.mockResolvedValue(state.credentials); });
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); state.stores.clear(); state.statuses.clear(); });
function mount(live = false) { let root!: ReturnType<typeof create>; act(() => { root = create(React.createElement(Probe, { live })); }); roots.push(root); return root; }
function changed() { act(() => { for (const f of state.stores) f(); for (const f of state.statuses) f(); }); }

it('retains same-peer immutable bytes through channel/token refresh and native owner loss/replacement without polling credentials', async () => {
    mount(); expect(scope.valid).toBe(true); const count = renders;
    state.credentials.token = 'refreshed-token'; state.metadata.bridge.source.runtimeGeneration = null; state.metadata.bridge.sourceStatus = 'owner-unavailable'; changed();
    state.metadata.bridge.source.runtimeGeneration = 'owner-b'; changed();
    expect(scope.valid).toBe(true); expect(state.close).not.toHaveBeenCalled(); expect(renders).toBe(count); expect(state.savedRead).not.toHaveBeenCalled();
    await scope.assertCurrent(); expect(state.savedRead).toHaveBeenCalledOnce();
});
it.each(['peer', 'account', 'key', 'navigation', 'native-source'])('closes and fences stale callbacks after %s replacement with the same ref', async change => {
    mount(); const captured = scope.assertCurrent;
    if (change === 'peer') { state.credentials.peer.id = 'two'; state.peer = 'peer:two'; }
    if (change === 'account') state.credentials.secret = 'account-two';
    if (change === 'key') state.key = new Uint8Array(32).fill(1);
    if (change === 'navigation') state.viewed = 'different-session';
    if (change === 'native-source') state.metadata.bridge.source.id = 'different-native';
    changed(); expect(scope.valid).toBe(false); expect(state.close).toHaveBeenCalledOnce();
    await expect(captured()).rejects.toThrow('preview source changed'); expect(state.savedRead).not.toHaveBeenCalled();
    changed(); expect(state.close).toHaveBeenCalledOnce();
});
it('same ref props cannot silently replace the opened ref; explicitly opened live image mode permits ref refresh', () => {
    const root = mount(); act(() => root.update(React.createElement(Probe, { refValue: 'new-ref' })));
    expect(scope.valid).toBe(false); expect(state.close).toHaveBeenCalledOnce();
    const live = mount(true); act(() => live.update(React.createElement(Probe, { refValue: 'live-new-ref', live: true })));
    expect(scope.valid).toBe(true);
});
it('saved credential mismatch fences a stale Save even before active Sync/Socket publishes the change', async () => {
    mount(); state.savedRead.mockRejectedValue(Error('The image peer changed'));
    await expect(scope.assertCurrent()).rejects.toThrow('preview source changed'); expect(state.close).toHaveBeenCalledOnce();
});
it('an opened preview releases its one scoped store/status subscription', () => {
    const root = mount(); expect(state.stores.size).toBe(1); expect(state.statuses.size).toBe(1);
    act(() => root.unmount()); roots.splice(roots.indexOf(root), 1);
    expect(state.stores.size).toBe(0); expect(state.statuses.size).toBe(0);
});

it('initial null key stays unavailable until explicit Retry binds a ready key in the captured source', async () => {
    state.key = null; mount();
    expect(scope.valid).toBe(false); expect(scope.changed).toBe(false); expect(state.close).not.toHaveBeenCalled();
    expect(scope.retry()).toBe(false); await expect(scope.assertCurrent()).rejects.toThrow('preview unavailable');
    expect(state.savedRead).not.toHaveBeenCalled();
    state.key = new Uint8Array(32); changed();
    expect(scope.valid).toBe(false); expect(scope.changed).toBe(false); expect(state.close).not.toHaveBeenCalled();
    act(() => { expect(scope.retry()).toBe(true); });
    expect(scope.valid).toBe(true); await scope.assertCurrent(); expect(state.savedRead).toHaveBeenCalledOnce();
    expect(state.diagnostic.mock.calls).toEqual(expect.arrayContaining([
        ['preview-scope', { reason: 'key-unavailable', keyPresent: false, peerMatch: true }],
        ['preview-scope', { reason: 'awaiting-explicit-retry', keyPresent: true, peerMatch: true }],
    ]));
    for (const [, fields] of state.diagnostic.mock.calls) expect(Object.keys(fields).sort()).toEqual(['keyPresent', 'peerMatch', 'reason']);
});

it.each(['peer', 'account', 'device', 'navigation', 'native-source', 'machine', 'collection'])('pending key cannot bind after %s changes', async change => {
    state.key = null; mount(); const staleRetry = scope.retry, staleSave = scope.assertCurrent;
    if (change === 'peer') { state.credentials.peer.id = 'two'; state.peer = 'peer:two'; }
    if (change === 'account') state.credentials.secret = 'account-two';
    if (change === 'device') state.credentials.peer.device.publicKey = 'device-two';
    if (change === 'navigation') state.viewed = 'other';
    if (change === 'native-source') state.metadata.bridge.source.id = 'other';
    if (change === 'machine') state.metadata.machineId = 'other';
    if (change === 'collection') state.metadata.bridge.source.nativeCollection = 'other';
    state.key = new Uint8Array(32); changed();
    expect(scope.changed).toBe(true); expect(scope.valid).toBe(false); expect(state.close).toHaveBeenCalledOnce();
    expect(staleRetry()).toBe(false); await expect(staleSave()).rejects.toThrow('preview source changed');
    expect(state.savedRead).not.toHaveBeenCalled();
});

it.each(['missing', 'different'])('a bound key becoming %s closes once without another credential read', async change => {
    mount(); const staleSave = scope.assertCurrent;
    state.key = change === 'missing' ? null : new Uint8Array(32).fill(1); changed();
    expect(scope.changed).toBe(true); expect(scope.retry()).toBe(false); expect(state.close).toHaveBeenCalledOnce();
    await expect(staleSave()).rejects.toThrow('preview source changed'); expect(state.savedRead).not.toHaveBeenCalled();
});

it('initial credentials or peer mismatch cannot adopt a later trusted account on Retry', () => {
    state.credentials = null; state.key = null; mount();
    state.credentials = { token: 'later', secret: 'later-account', peer: { id: 'one', device: { publicKey: 'device-one' } } };
    state.key = new Uint8Array(32); changed();
    expect(scope.retry()).toBe(false); expect(scope.valid).toBe(false); expect(state.close).not.toHaveBeenCalled();
    state.peer = 'peer:foreign'; mount(); state.peer = 'peer:one'; changed();
    expect(scope.retry()).toBe(false); expect(scope.valid).toBe(false);
});
