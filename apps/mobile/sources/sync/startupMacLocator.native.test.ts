import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ os: 'ios', appId: 'com.learnings.codelync', directory: 'file:///fixture/Documents/',
    info: vi.fn(), read: vi.fn(), remove: vi.fn(), bootstrap: vi.fn(), credentials: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { get OS() { return state.os; } } }));
vi.mock('expo-application', () => ({ get applicationId() { return state.appId; } }));
vi.mock('expo-file-system/legacy', () => ({ get documentDirectory() { return state.directory; }, getInfoAsync: state.info, readAsStringAsync: state.read, deleteAsync: state.remove }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: state.credentials } }));
vi.mock('./bootstrapMacDiagnostics', () => ({ bootstrapMacDiagnostics: state.bootstrap }));
import { consumeNativeStartupMacLocator } from './startupMacLocator.native';
beforeEach(() => {
    vi.clearAllMocks(); state.os = 'ios'; state.appId = 'com.learnings.codelync'; state.directory = 'file:///fixture/Documents/';
    state.credentials.mockResolvedValue({ token: 'fixture', secret: 'fixture', peer: { id: 'fixture-mac', key: 'fixture-key', channels: [], device: { publicKey: 'fixture-public', secretKey: 'fixture-private' } } });
    state.info.mockResolvedValue({ exists: true, isDirectory: false, size: 100 }); state.bootstrap.mockResolvedValue(undefined); state.remove.mockResolvedValue(undefined);
    state.read.mockResolvedValue(JSON.stringify({ version: 1, peerId: 'fixture-mac', origins: ['https://fixture.example'], expiresAt: Date.now() + 60_000 }));
});
it.each([
    ['ios', 'file:///fixture/Documents/', ['https://fixture.example']],
    ['android', 'file:///data/user/0/com.learnings.codelync/files/', ['http://192.168.3.186:50256', 'https://fixture.example']],
] as const)('reads, bootstraps, and deletes the fixed private %s locator through one startup attempt', async (os, directory, origins) => {
    state.os = os;
    state.directory = directory;
    state.read.mockResolvedValue(JSON.stringify({ version: 1, peerId: 'fixture-mac', origins: [...origins], expiresAt: Date.now() + 60_000 }));
    expect(await consumeNativeStartupMacLocator()).toBe(true);
    const path = directory + 'codelync-mac-locator.json';
    expect(state.info).toHaveBeenCalledExactlyOnceWith(path); expect(state.read).toHaveBeenCalledExactlyOnceWith(path);
    expect(state.remove).toHaveBeenCalledExactlyOnceWith(path, { idempotent: true });
    expect(state.bootstrap).toHaveBeenCalledExactlyOnceWith([...origins], { expectedPeerId: 'fixture-mac' });
});
it.each([{ os: 'web' }, { appId: 'com.learnings.codelync.preview' }, { appId: 'com.learnings.codelync.dev' }, { directory: '' }])('does no file or credential work outside shipping iOS and Android sandboxes: %j', async change => {
    Object.assign(state, change); expect(await consumeNativeStartupMacLocator()).toBe(false);
    expect(state.info).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled(); expect(state.credentials).not.toHaveBeenCalled();
});
it.each([
    ['ios', { exists: false }],
    ['ios', { exists: true, isDirectory: true }],
    ['ios', { exists: true, isDirectory: false, size: 8193 }],
    ['android', { exists: false }],
    ['android', { exists: true, isDirectory: true }],
    ['android', { exists: true, isDirectory: false, size: 8193 }],
] as const)('does not read absent/directory/oversized locators on %s: %j', async (os, info) => {
    state.os = os;
    state.directory = os === 'android' ? 'file:///data/user/0/com.learnings.codelync/files/' : 'file:///fixture/Documents/';
    state.info.mockResolvedValue(info); expect(await consumeNativeStartupMacLocator()).toBe(false);
    expect(state.info).toHaveBeenCalledOnce(); expect(state.read).not.toHaveBeenCalled(); expect(state.bootstrap).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled();
});
