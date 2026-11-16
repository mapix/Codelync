import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ os: 'ios', appId: 'com.learnings.codelight', directory: 'file:///fixture/Documents/',
    info: vi.fn(), read: vi.fn(), remove: vi.fn(), bootstrap: vi.fn(), credentials: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { get OS() { return state.os; } } }));
vi.mock('expo-application', () => ({ get applicationId() { return state.appId; } }));
vi.mock('expo-file-system/legacy', () => ({ get documentDirectory() { return state.directory; }, getInfoAsync: state.info, readAsStringAsync: state.read, deleteAsync: state.remove }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: state.credentials } }));
vi.mock('./bootstrapMacDiagnostics', () => ({ bootstrapMacDiagnostics: state.bootstrap }));
import { consumeNativeStartupMacLocator } from './startupMacLocator.native';
beforeEach(() => {
    vi.clearAllMocks(); state.os = 'ios'; state.appId = 'com.learnings.codelight'; state.directory = 'file:///fixture/Documents/';
    state.credentials.mockResolvedValue({ token: 'fixture', secret: 'fixture', peer: { id: 'fixture-mac', key: 'fixture-key', channels: [], device: { publicKey: 'fixture-public', secretKey: 'fixture-private' } } });
    state.info.mockResolvedValue({ exists: true, isDirectory: false, size: 100 }); state.bootstrap.mockResolvedValue(undefined); state.remove.mockResolvedValue(undefined);
    state.read.mockResolvedValue(JSON.stringify({ version: 1, peerId: 'fixture-mac', origins: ['https://fixture.example'], expiresAt: Date.now() + 60_000 }));
});
it('reads and deletes only the fixed private Documents locator through one startup attempt', async () => {
    expect(await consumeNativeStartupMacLocator()).toBe(true);
    const path = 'file:///fixture/Documents/codelight-mac-locator.json';
    expect(state.info).toHaveBeenCalledExactlyOnceWith(path); expect(state.read).toHaveBeenCalledExactlyOnceWith(path);
    expect(state.remove).toHaveBeenCalledExactlyOnceWith(path, { idempotent: true });
    expect(state.bootstrap).toHaveBeenCalledExactlyOnceWith(['https://fixture.example'], { expectedPeerId: 'fixture-mac' });
});
it.each([{ os: 'android' }, { appId: 'com.learnings.codelight.preview' }, { directory: '' }])('does no file or credential work outside the shipping iOS sandbox', async change => {
    Object.assign(state, change); expect(await consumeNativeStartupMacLocator()).toBe(false);
    expect(state.info).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled(); expect(state.credentials).not.toHaveBeenCalled();
});
it.each([{ exists: false }, { exists: true, isDirectory: true }, { exists: true, isDirectory: false, size: 8193 }])('does not read absent/directory/oversized locators', async info => {
    state.info.mockResolvedValue(info); expect(await consumeNativeStartupMacLocator()).toBe(false);
    expect(state.info).toHaveBeenCalledOnce(); expect(state.read).not.toHaveBeenCalled(); expect(state.bootstrap).not.toHaveBeenCalled(); expect(state.remove).not.toHaveBeenCalled();
});
