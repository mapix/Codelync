import { expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';
const state = vi.hoisted(() => ({ current: null as AuthCredentials | null }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: async () => state.current } }));
import { currentImageReadCredentials } from './imageReadCredentials';
it('uses refreshed authenticated same-peer channels and rejects account, peer and device changes', async () => {
    const old = { token: 'token', secret: 'account', serverUrl: 'http://10.0.0.2:1000', peer: { id: 'mac', device: { publicKey: 'device' }, channels: [] } } as unknown as AuthCredentials;
    state.current = { ...old, serverUrl: 'http://10.0.0.2:2000', peer: { ...old.peer!, channels: [{ id: 'local', kind: 'local', label: 'Local', url: 'http://10.0.0.2:2000' }] } };
    await expect(currentImageReadCredentials(old)).resolves.toBe(state.current);
    state.current = { ...old, secret: 'another-account' }; await expect(currentImageReadCredentials(old)).rejects.toThrow('account changed');
    state.current = { ...old, peer: { ...old.peer!, id: 'another-mac' } }; await expect(currentImageReadCredentials(old)).rejects.toThrow('peer changed');
    state.current = { ...old, peer: { ...old.peer!, device: { ...old.peer!.device, publicKey: 'another-device' } } }; await expect(currentImageReadCredentials(old)).rejects.toThrow('peer changed');
});
