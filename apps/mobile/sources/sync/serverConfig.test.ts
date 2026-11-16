import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ endpoint: 'https://paired.example' }));
vi.mock('@/config', () => ({ config: { noninvasiveLocal: true } }));
vi.mock('react-native-mmkv', () => ({ MMKV: class { getString() { return state.endpoint; } set(_key: string, value: string) { state.endpoint = value; } } }));
vi.stubGlobal('__DEV__', false);
import { commitPeerServerUrl, rewriteLoopbackHost } from './serverConfig';
it('replaces the loopback port for HTTPS and LAN and preserves the current relay prefix', () => {
    commitPeerServerUrl('https://paired.example');
    expect(rewriteLoopbackHost('http://127.0.0.1:57670/v1/image')).toBe('https://paired.example/v1/image');
    commitPeerServerUrl('http://10.0.0.2:1234');
    expect(rewriteLoopbackHost('http://localhost:57670/v1/image')).toBe('http://10.0.0.2:1234/v1/image');
    commitPeerServerUrl('https://paired.example/r/aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(rewriteLoopbackHost('http://127.0.0.1:57670/v1/image')).toBe('https://paired.example/r/aaaaaaaaaaaaaaaaaaaaaaaa/v1/image');
    expect(rewriteLoopbackHost('https://files.example/image?signature=fixture')).toBe('https://files.example/image?signature=fixture');
});
