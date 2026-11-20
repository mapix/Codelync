import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';

const mocks = vi.hoisted(() => ({
    cacheDirectory: 'file:///cache/' as string | null,
    copyAsync: vi.fn(),
    deleteAsync: vi.fn(),
    readAsStringAsync: vi.fn(),
}));

vi.mock('expo-file-system/legacy', () => ({
    get cacheDirectory() {
        return mocks.cacheDirectory;
    },
    EncodingType: { Base64: 'base64' },
    copyAsync: mocks.copyAsync,
    deleteAsync: mocks.deleteAsync,
    readAsStringAsync: mocks.readAsStringAsync,
}));

import { readFileBytes } from './readFileBytes';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.cacheDirectory = 'file:///cache/';
    mocks.copyAsync.mockResolvedValue(undefined);
    mocks.deleteAsync.mockResolvedValue(undefined);
});

describe('readFileBytes', () => {
    it('reads file:// URIs directly as Base64 without copyAsync staging', async () => {
        const expected = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
        mocks.readAsStringAsync.mockResolvedValueOnce(encodeBase64(expected));

        const bytes = await readFileBytes('file:///cache/photo.jpg');

        expect(Array.from(bytes)).toEqual(Array.from(expected));
        expect(mocks.readAsStringAsync).toHaveBeenCalledExactlyOnceWith('file:///cache/photo.jpg', { encoding: 'base64' });
        expect(mocks.copyAsync).not.toHaveBeenCalled();
        expect(mocks.deleteAsync).not.toHaveBeenCalled();
    });

    it('stages Android content:// URIs via copyAsync into cacheDirectory and deletes temp file after reading', async () => {
        const contentUri = 'content://media/picker/0/com.android.providers.media.photopicker/media/99';
        const expected = new Uint8Array([1, 2, 3, 4, 5, 250, 255]);
        mocks.readAsStringAsync.mockResolvedValueOnce(encodeBase64(expected));

        const bytes = await readFileBytes(contentUri);

        expect(Array.from(bytes)).toEqual(Array.from(expected));
        expect(mocks.copyAsync).toHaveBeenCalledOnce();
        const tempUri = mocks.copyAsync.mock.calls[0][0].to as string;
        expect(mocks.copyAsync).toHaveBeenCalledWith({ from: contentUri, to: tempUri });
        expect(tempUri).toMatch(/^file:\/\/\/cache\/codelync_read_/);
        expect(mocks.readAsStringAsync).toHaveBeenCalledExactlyOnceWith(tempUri, { encoding: 'base64' });
        expect(mocks.deleteAsync).toHaveBeenCalledExactlyOnceWith(tempUri, { idempotent: true });
    });

    it('always cleans up staged temp file via deleteAsync when readAsStringAsync rejects', async () => {
        const contentUri = 'content://media/picker/0/com.android.providers.media.photopicker/media/100';
        mocks.readAsStringAsync.mockRejectedValueOnce(new Error('disk read failure'));

        await expect(readFileBytes(contentUri)).rejects.toThrow('disk read failure');

        expect(mocks.copyAsync).toHaveBeenCalledOnce();
        const tempUri = mocks.copyAsync.mock.calls[0][0].to as string;
        expect(mocks.deleteAsync).toHaveBeenCalledExactlyOnceWith(tempUri, { idempotent: true });
    });
});
