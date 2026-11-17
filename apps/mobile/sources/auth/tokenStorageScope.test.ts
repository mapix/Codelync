import { afterEach, expect, it, vi } from 'vitest';
const { getItem, setItem, deleteItem, origin } = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), deleteItem: vi.fn(), origin: { current: 'https://fixture.example' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: getItem, setItemAsync: setItem, deleteItemAsync: deleteItem, AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 6 }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active' } }));
vi.mock('@/config', () => ({ config: { noninvasiveLocal: true } }));
vi.mock('@/sync/codelyncBackgroundCache', () => ({ clearCodelyncBackgroundCache: vi.fn() }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => origin.current }));
import { TokenStorage } from './tokenStorage';
afterEach(() => { getItem.mockReset(); setItem.mockReset(); deleteItem.mockReset(); origin.current = 'https://fixture.example'; });

it('does not return stored credentials bound to another selected server', async () => {
    getItem.mockResolvedValue(JSON.stringify({ token: 'fixture-token', secret: 'fixture-secret', serverUrl: 'https://other.example' }));
    expect(await TokenStorage.getCredentials()).toBeNull();
});
it('stores credentials with the frozen selected server origin', async () => {
    setItem.mockResolvedValue(undefined);
    expect(await TokenStorage.setCredentials({ token: 'fixture-token', secret: 'fixture-secret' })).toBe(true);
    expect(setItem.mock.calls[0][0]).toBe('codelync_auth_credentials_v1');
    expect(JSON.parse(setItem.mock.calls[0][1])).toMatchObject({ serverUrl: 'https://fixture.example' });
});
it('does not read or migrate credentials from the previous product namespace', async () => {
    const previous = JSON.stringify({ token: 'fixture-token', secret: 'fixture-secret', serverUrl: origin.current });
    getItem.mockImplementation(async (key: string) => key === 'auth_credentials' ? previous : null);
    expect(await TokenStorage.readCredentials()).toEqual({ status: 'missing', credentials: null });
    expect(getItem.mock.calls).toEqual([['codelync_auth_credentials_v1']]);
    expect(setItem).not.toHaveBeenCalled();
    expect(deleteItem).not.toHaveBeenCalled();
});
it('returns failure when native secure storage rejects the credential write', async () => {
    setItem.mockRejectedValue(Error('fixture Keychain unavailable'));
    expect(await TokenStorage.setCredentials({ token: 'fixture-token', secret: 'fixture-secret' })).toBe(false);
});
it('distinguishes unavailable secure storage from absent credentials without deleting anything', async () => {
    getItem.mockRejectedValueOnce(Error('fixture Keychain inaccessible'));
    expect(await TokenStorage.readCredentials()).toEqual({ status: 'unavailable', credentials: null });
    expect(deleteItem).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled();
    getItem.mockResolvedValueOnce(null);
    expect(await TokenStorage.readCredentials()).toEqual({ status: 'missing', credentials: null });
});
it('keeps nullable read callers fail-closed and permits a later read of the same saved connection', async () => {
    getItem.mockRejectedValueOnce(Error('fixture unavailable'));
    expect(await TokenStorage.getCredentials()).toBeNull();
    getItem.mockResolvedValueOnce(JSON.stringify({ token: 'fixture-token', secret: 'fixture-secret', serverUrl: origin.current }));
    setItem.mockResolvedValue(undefined);
    const result = await TokenStorage.readCredentials();
    expect(result.status).toBe('available');
    expect(result.credentials?.serverUrl).toBe(origin.current); expect(deleteItem).not.toHaveBeenCalled();
});
