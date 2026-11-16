import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://fixture.invalid', rewriteLoopbackHost: (value: string) => value }));
vi.mock('./peerNetwork', () => ({ credentialHeaders: () => ({}) }));
vi.mock('./uploadFormFile', () => ({ appendFormFile: vi.fn() }));
import { downloadEncryptedAttachment } from './apiAttachments';
const credentials = { token: 'synthetic', secret: 'synthetic' };
afterEach(() => vi.unstubAllGlobals());

it('rejects an oversized declared file before consuming its body', async () => {
    const body = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ downloadUrl: 'https://fixture.invalid/blob' })))
        .mockResolvedValueOnce({ ok: true, headers: new Headers({ 'content-length': '101' }), arrayBuffer: body }));
    await expect(downloadEncryptedAttachment(credentials, 'session', 'ref', { maxBytes: 100 })).rejects.toThrow('read limit');
    expect(body).not.toHaveBeenCalled();
});
it('cancels a streamed body once the actual byte limit is crossed', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = { read: vi.fn().mockResolvedValueOnce({ done: false, value: new Uint8Array(80) }).mockResolvedValueOnce({ done: false, value: new Uint8Array(30) }), cancel };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ downloadUrl: 'https://fixture.invalid/blob' })))
        .mockResolvedValueOnce({ ok: true, headers: new Headers(), body: { getReader: () => reader } }));
    await expect(downloadEncryptedAttachment(credentials, 'session', 'ref', { maxBytes: 100 })).rejects.toThrow('read limit');
    expect(cancel).toHaveBeenCalledOnce(); expect(reader.read).toHaveBeenCalledTimes(2);
});
