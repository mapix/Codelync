import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    platform: { OS: 'ios' },
    cacheDirectory: 'file:///cache/' as string | null,
    initialSelectedImages: [] as any[],
    requestMediaLibraryPermissionsAsync: vi.fn(),
    launchImageLibraryAsync: vi.fn(),
    manipulateAsync: vi.fn(),
    generateThumbhash: vi.fn(),
    getInfoAsync: vi.fn(),
    copyAsync: vi.fn(),
    deleteAsync: vi.fn(),
    writeAsStringAsync: vi.fn(),
    hasImageAsync: vi.fn(),
    getImageAsync: vi.fn(),
    alert: vi.fn(),
    setSelectedImages: vi.fn(),
}));

// Exercise the picker callback and its state update without native UI modules.
vi.mock('react', () => ({
    useState: () => [mocks.initialSelectedImages, mocks.setSelectedImages],
    useRef: <T,>(value: T) => ({ current: value }),
    useCallback: <T,>(callback: T) => callback,
    useEffect: (effect: () => void) => { effect(); },
}));

vi.mock('react-native', () => ({
    Platform: mocks.platform,
}));

vi.mock('expo-image-picker', () => ({
    requestMediaLibraryPermissionsAsync: mocks.requestMediaLibraryPermissionsAsync,
    launchImageLibraryAsync: mocks.launchImageLibraryAsync,
}));

vi.mock('expo-image-manipulator', () => ({
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: mocks.manipulateAsync,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: mocks.alert },
}));

vi.mock('expo-file-system/legacy', () => ({
    get cacheDirectory() { return mocks.cacheDirectory; },
    getInfoAsync: mocks.getInfoAsync,
    copyAsync: mocks.copyAsync,
    deleteAsync: mocks.deleteAsync,
    writeAsStringAsync: mocks.writeAsStringAsync,
}));

vi.mock('expo-clipboard', () => ({
    hasImageAsync: mocks.hasImageAsync,
    getImageAsync: mocks.getImageAsync,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/utils/thumbhash', () => ({
    generateThumbhash: mocks.generateThumbhash,
}));

import {
    ATTACHMENT_JPEG_QUALITY,
    ATTACHMENT_MAX_DIMENSION,
    ATTACHMENT_MAX_FILE_SIZE,
    IOS_ATTACHMENT_JPEG_QUALITY,
    IOS_ATTACHMENT_MAX_DIMENSION,
    IOS_ATTACHMENT_MAX_FILE_SIZE,
    MAX_FILE_SIZE,
    MAX_IMAGES_PER_MESSAGE,
    normalizePickedAssetForUpload,
    readImageDataUri,
    resolveLocalUriByteSize,
    useImagePicker,
} from './useImagePicker';
import type { AttachmentPreview } from './useImagePicker';

const photo = {
    uri: 'file:///test/photo.HEIC',
    width: 6048,
    height: 8064,
    mimeType: 'image/heic',
    fileName: 'photo.HEIC',
    fileSize: 6_300_000,
};

beforeEach(() => {
    vi.resetAllMocks();
    mocks.platform.OS = 'ios';
    mocks.cacheDirectory = 'file:///cache/';
    mocks.initialSelectedImages = [];
    mocks.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: false, size: 3_000_000 });
    mocks.copyAsync.mockResolvedValue(undefined);
    mocks.deleteAsync.mockResolvedValue(undefined);
    mocks.manipulateAsync.mockResolvedValue({ uri: 'file:///test/normalized.jpg', width: 2304, height: 3072 });
    mocks.requestMediaLibraryPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mocks.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [photo] });
    mocks.generateThumbhash.mockResolvedValue('thumbhash');
});

describe('exported attachment constants', () => {
    it('exports cross-platform attachment constants alongside backward-compatible iOS aliases', () => {
        expect(MAX_IMAGES_PER_MESSAGE).toBe(20);
        expect(MAX_FILE_SIZE).toBe(10 * 1024 * 1024);
        expect(ATTACHMENT_JPEG_QUALITY).toBe(0.92);
        expect(ATTACHMENT_MAX_DIMENSION).toBe(3072);
        expect(ATTACHMENT_MAX_FILE_SIZE).toBe(10_485_720);
        expect(IOS_ATTACHMENT_JPEG_QUALITY).toBe(ATTACHMENT_JPEG_QUALITY);
        expect(IOS_ATTACHMENT_MAX_DIMENSION).toBe(ATTACHMENT_MAX_DIMENSION);
        expect(IOS_ATTACHMENT_MAX_FILE_SIZE).toBe(ATTACHMENT_MAX_FILE_SIZE);
    });
});

describe('resolveLocalUriByteSize', () => {
    it('returns exact file:// byte size directly from getInfoAsync without staging', async () => {
        mocks.getInfoAsync.mockResolvedValueOnce({ exists: true, isDirectory: false, size: 2_468_135 });
        await expect(resolveLocalUriByteSize('file:///cache/picked.jpg')).resolves.toBe(2_468_135);
        expect(mocks.copyAsync).not.toHaveBeenCalled();
        expect(mocks.deleteAsync).not.toHaveBeenCalled();
    });

    it('stages Android content:// directly via copyAsync without calling getInfoAsync(contentUri), avoiding IOException and 4 KB pipe under-reporting', async () => {
        const contentUri = 'content://media/picker/0/com.android.providers.media.photopicker/media/42';
        mocks.getInfoAsync.mockImplementation(async (target: string) => {
            if (target.startsWith('content://')) {
                throw new Error('IOException: stream does not support available()');
            }
            return { exists: true, isDirectory: false, size: 15_728_640 };
        });

        await expect(resolveLocalUriByteSize(contentUri)).resolves.toBe(15_728_640);

        expect(mocks.copyAsync).toHaveBeenCalledOnce();
        const stagedTarget = mocks.copyAsync.mock.calls[0][0].to as string;
        expect(mocks.copyAsync).toHaveBeenCalledWith({ from: contentUri, to: stagedTarget });
        expect(stagedTarget).toMatch(/^file:\/\/\/cache\/codelync_size_/);
        expect(mocks.getInfoAsync).toHaveBeenCalledExactlyOnceWith(stagedTarget);
        expect(mocks.deleteAsync).toHaveBeenCalledExactlyOnceWith(stagedTarget, { idempotent: true });
    });

    it('measures full staged size instead of buffered 4096-byte pipe chunk on cloud-backed content:// URIs', async () => {
        const contentUri = 'content://com.google.android.apps.photos.contentprovider/-1/1/content%3A%2F%2Fmedia%2Fexternal%2Fimages%2Fmedia%2F88/ORIGINAL/NONE/123';
        mocks.getInfoAsync.mockImplementation(async (target: string) => (
            target.startsWith('content://')
                ? { exists: true, isDirectory: false, size: 4096 }
                : { exists: true, isDirectory: false, size: 15_728_640 }
        ));

        await expect(resolveLocalUriByteSize(contentUri)).resolves.toBe(15_728_640);
        expect(mocks.getInfoAsync).not.toHaveBeenCalledWith(contentUri);
    });

    it('cleans up temp file via deleteAsync even when copyAsync or staged getInfoAsync fails', async () => {
        const contentUri = 'content://media/picker/0/com.android.providers.media.photopicker/media/99';
        mocks.copyAsync.mockRejectedValueOnce(new Error('provider stream error'));

        await expect(resolveLocalUriByteSize(contentUri)).rejects.toThrow('provider stream error');

        expect(mocks.copyAsync).toHaveBeenCalledOnce();
        const stagedTarget = mocks.copyAsync.mock.calls[0][0].to as string;
        expect(mocks.getInfoAsync).not.toHaveBeenCalled();
        expect(mocks.deleteAsync).toHaveBeenCalledExactlyOnceWith(stagedTarget, { idempotent: true });
    });

    it('cleans up temp file and throws when staged content:// copy reports 0 bytes', async () => {
        const contentUri = 'content://media/picker/0/com.android.providers.media.photopicker/media/100';
        mocks.getInfoAsync.mockResolvedValueOnce({ exists: true, isDirectory: false, size: 0 });

        await expect(resolveLocalUriByteSize(contentUri)).rejects.toThrow('Could not determine image size');

        const stagedTarget = mocks.copyAsync.mock.calls[0][0].to as string;
        expect(mocks.deleteAsync).toHaveBeenCalledExactlyOnceWith(stagedTarget, { idempotent: true });
    });

    it('falls back to getInfoAsync(uri) on content:// only when cacheDirectory is unavailable', async () => {
        mocks.cacheDirectory = null;
        const contentUri = 'content://media/picker/0/com.android.providers.media.photopicker/media/55';
        mocks.getInfoAsync.mockResolvedValueOnce({ exists: true, isDirectory: false, size: 1_234_567 });

        await expect(resolveLocalUriByteSize(contentUri)).resolves.toBe(1_234_567);
        expect(mocks.copyAsync).not.toHaveBeenCalled();
        expect(mocks.getInfoAsync).toHaveBeenCalledExactlyOnceWith(contentUri);
    });
});

describe('normalizePickedAssetForUpload', () => {
    it.each(['ios', 'android'] as const)('normalizes %s image picker assets to <=3072px 0.92 JPEG before upload', async (platform) => {
        mocks.platform.OS = platform;
        mocks.manipulateAsync.mockResolvedValue({
            uri: 'file:///tmp/ImageManipulator/IMG_9824.jpg',
            width: 3072,
            height: 2304,
        });

        const normalized = await normalizePickedAssetForUpload({
            uri: 'file:///tmp/IMG_9824.HEIC',
            width: 4032,
            height: 3024,
            fileName: 'IMG_9824.HEIC',
            fileSize: 2_701_533,
        });

        expect(mocks.manipulateAsync).toHaveBeenCalledWith(
            'file:///tmp/IMG_9824.HEIC',
            [{ resize: { width: 3072 } }],
            { compress: 0.92, format: 'jpeg' },
        );
        expect(normalized).toEqual({
            uri: 'file:///tmp/ImageManipulator/IMG_9824.jpg',
            mimeType: 'image/jpeg',
            name: 'IMG_9824.jpg',
            width: 3072,
            height: 2304,
            size: 3_000_000,
        });
    });

    it('enforces post-decode <=3072px resize and deletes intermediate file when Android content:// asset reports 0x0 dimensions', async () => {
        mocks.platform.OS = 'android';
        const rawContentUri = 'content://media/picker/0/com.android.providers.media.photopicker/media/77';
        mocks.manipulateAsync
            .mockResolvedValueOnce({ uri: 'file:///cache/first_pass.jpg', width: 6000, height: 4000 })
            .mockResolvedValueOnce({ uri: 'file:///cache/second_pass.jpg', width: 3072, height: 2048 });
        mocks.getInfoAsync.mockResolvedValueOnce({ exists: true, isDirectory: false, size: 1_850_000 });

        const normalized = await normalizePickedAssetForUpload({
            uri: rawContentUri,
            width: 0,
            height: 0,
            fileName: 'raw_photo.webp',
            fileSize: undefined,
        });

        expect(mocks.manipulateAsync).toHaveBeenNthCalledWith(
            1,
            rawContentUri,
            [],
            { compress: 0.92, format: 'jpeg' },
        );
        expect(mocks.manipulateAsync).toHaveBeenNthCalledWith(
            2,
            'file:///cache/first_pass.jpg',
            [{ resize: { width: 3072 } }],
            { compress: 0.92, format: 'jpeg' },
        );
        expect(mocks.deleteAsync).toHaveBeenCalledExactlyOnceWith('file:///cache/first_pass.jpg', { idempotent: true });
        expect(normalized).toEqual({
            uri: 'file:///cache/second_pass.jpg',
            width: 3072,
            height: 2048,
            mimeType: 'image/jpeg',
            name: 'raw_photo.jpg',
            size: 1_850_000,
        });
    });

    it('deletes intermediate first_pass file and preserves primary error when 0x0 content:// decodes >3072px and second manipulateAsync throws', async () => {
        mocks.platform.OS = 'android';
        const rawContentUri = 'content://media/picker/0/com.android.providers.media.photopicker/media/78';
        mocks.manipulateAsync
            .mockResolvedValueOnce({ uri: 'file:///cache/first_pass.jpg', width: 3073, height: 100 })
            .mockRejectedValueOnce(new Error('OutOfMemoryError: bitmap allocation failed'));
        mocks.deleteAsync.mockRejectedValueOnce(new Error('secondary unlink error'));

        await expect(normalizePickedAssetForUpload({
            uri: rawContentUri,
            width: 0,
            height: 0,
            fileName: 'giant_panorama.webp',
            fileSize: undefined,
        })).rejects.toThrow('OutOfMemoryError: bitmap allocation failed');

        expect(mocks.manipulateAsync).toHaveBeenCalledTimes(2);
        expect(mocks.manipulateAsync).toHaveBeenNthCalledWith(
            2,
            'file:///cache/first_pass.jpg',
            [{ resize: { width: 3072 } }],
            { compress: 0.92, format: 'jpeg' },
        );
        expect(mocks.deleteAsync).toHaveBeenCalledExactlyOnceWith('file:///cache/first_pass.jpg', { idempotent: true });
        expect(mocks.getInfoAsync).not.toHaveBeenCalled();
    });

    it('never deletes source asset.uri if first pass returns asset.uri unchanged and second manipulateAsync throws', async () => {
        mocks.platform.OS = 'android';
        const sourceUri = 'file:///storage/emulated/0/Pictures/original.jpg';
        mocks.manipulateAsync
            .mockResolvedValueOnce({ uri: sourceUri, width: 100, height: 3073 })
            .mockRejectedValueOnce(new Error('codec error'));

        await expect(normalizePickedAssetForUpload({
            uri: sourceUri,
            width: 0,
            height: 0,
            fileName: 'original.jpg',
            fileSize: undefined,
        })).rejects.toThrow('codec error');

        expect(mocks.deleteAsync).not.toHaveBeenCalled();
    });

    it.each([
        [6048, 8064, { height: 3072 }],
        [8064, 6048, { width: 3072 }],
        [8064, 8064, { width: 3072 }],
        [12000, 2000, { width: 3072 }],
    ])('bounds %ix%i images using one dimension to preserve framing', async (width, height, resize) => {
        await normalizePickedAssetForUpload({ ...photo, width, height });
        expect(mocks.manipulateAsync).toHaveBeenCalledExactlyOnceWith(
            photo.uri, [{ resize }], { compress: 0.92, format: 'jpeg' },
        );
    });

    it.each([[1024, 768], [3072, 2304]])('does not upscale or crop an already-small %ix%i image', async (width, height) => {
        mocks.manipulateAsync.mockResolvedValue({ uri: 'file:///test/small.jpg', width, height });
        const normalized = await normalizePickedAssetForUpload({ ...photo, width, height, fileName: 'small.jpg', mimeType: 'image/jpeg' });
        expect(mocks.manipulateAsync).toHaveBeenCalledExactlyOnceWith(
            photo.uri, [], { compress: 0.92, format: 'jpeg' },
        );
        expect(normalized).toMatchObject({ width, height, name: 'small.jpg' });
    });

    it('measures the converted URI even when source filesize is unavailable', async () => {
        const normalized = await normalizePickedAssetForUpload({ ...photo, fileSize: undefined });
        expect(mocks.getInfoAsync).toHaveBeenCalledExactlyOnceWith('file:///test/normalized.jpg');
        expect(normalized).toMatchObject({ size: 3_000_000, width: 2304, height: 3072 });
    });

    it.each([
        { exists: false },
        { exists: true, isDirectory: true, size: 100 },
        { exists: true, size: undefined },
        { exists: true, size: 0 },
        { exists: true, size: -1 },
        { exists: true, size: NaN },
        { exists: true, size: Infinity },
    ])('rejects unreadable/unknown transformed filesize and cleans up converted temp file: %j', async (info) => {
        mocks.getInfoAsync.mockResolvedValue(info);
        await expect(normalizePickedAssetForUpload(photo)).rejects.toThrow();
        expect(mocks.deleteAsync).toHaveBeenCalledExactlyOnceWith('file:///test/normalized.jpg', { idempotent: true });
    });

    it('preserves primary size-check error and skips deleting asset.uri when converted.uri matches asset.uri', async () => {
        mocks.manipulateAsync.mockResolvedValueOnce({ uri: photo.uri, width: 2304, height: 3072 });
        mocks.getInfoAsync.mockRejectedValueOnce(new Error('stat failed'));
        await expect(normalizePickedAssetForUpload(photo)).rejects.toThrow('stat failed');
        expect(mocks.deleteAsync).not.toHaveBeenCalled();
    });

    it('preserves the existing web pass-through path without calling manipulateAsync', async () => {
        mocks.platform.OS = 'web';
        const webAsset = {
            uri: 'blob:https://codelync.invalid/asset-1',
            width: 1600,
            height: 1200,
            mimeType: 'image/png',
            fileName: 'web.png',
            fileSize: 512_000,
        };
        const normalized = await normalizePickedAssetForUpload(webAsset);
        expect(normalized).toEqual({
            uri: webAsset.uri, width: webAsset.width, height: webAsset.height,
            mimeType: webAsset.mimeType, name: webAsset.fileName, size: webAsset.fileSize,
        });
        expect(mocks.manipulateAsync).not.toHaveBeenCalled();
        expect(mocks.getInfoAsync).not.toHaveBeenCalled();
    });
});

describe('useImagePicker Android Photo Picker permissions, limits & cap parity', () => {
    function addedImages(): AttachmentPreview[] {
        expect(mocks.setSelectedImages).toHaveBeenCalledTimes(1);
        return mocks.setSelectedImages.mock.calls[0][0]([]);
    }

    it('launches Android System Photo Picker without calling requestMediaLibraryPermissionsAsync even if mocked denied', async () => {
        mocks.platform.OS = 'android';
        mocks.requestMediaLibraryPermissionsAsync.mockResolvedValue({ status: 'denied' });
        mocks.launchImageLibraryAsync.mockResolvedValue({
            canceled: false,
            assets: [{
                uri: 'content://media/picker/0/com.android.providers.media.photopicker/media/101',
                width: 4032,
                height: 3024,
                mimeType: 'image/heic',
                fileName: 'IMG_ANDROID.HEIC',
                fileSize: undefined,
            }],
        });

        await useImagePicker().pickImages();

        expect(mocks.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
        expect(mocks.launchImageLibraryAsync).toHaveBeenCalledExactlyOnceWith({
            mediaTypes: ['images'],
            allowsMultipleSelection: true,
            selectionLimit: 20,
            quality: 1,
            exif: false,
        });
        expect(addedImages()).toEqual([expect.objectContaining({
            uri: 'file:///test/normalized.jpg',
            mimeType: 'image/jpeg',
            name: 'IMG_ANDROID.jpg',
            size: 3_000_000,
        })]);
        expect(mocks.alert).not.toHaveBeenCalled();
    });

    it('continues checking requestMediaLibraryPermissionsAsync on iOS and alerts when denied', async () => {
        mocks.platform.OS = 'ios';
        mocks.requestMediaLibraryPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });

        await useImagePicker().pickImages();

        expect(mocks.requestMediaLibraryPermissionsAsync).toHaveBeenCalledOnce();
        expect(mocks.launchImageLibraryAsync).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(
            'imageUpload.permissionTitle',
            'imageUpload.permissionMessage',
            expect.any(Array),
        );
    });

    it('accepts exact MAX_FILE_SIZE - 40 (10,485,720 B) and rejects 10,485,721 B on Android even when asset.fileSize was 0 or undefined', async () => {
        mocks.platform.OS = 'android';
        mocks.launchImageLibraryAsync.mockResolvedValue({
            canceled: false,
            assets: [{ ...photo, fileSize: 0 }],
        });

        mocks.getInfoAsync.mockResolvedValueOnce({ exists: true, isDirectory: false, size: MAX_FILE_SIZE - 40 });
        await useImagePicker().pickImages();
        expect(addedImages()[0].size).toBe(10_485_720);
        expect(mocks.alert).not.toHaveBeenCalled();

        mocks.setSelectedImages.mockClear();
        mocks.getInfoAsync.mockResolvedValueOnce({ exists: true, isDirectory: false, size: MAX_FILE_SIZE - 39 });
        await useImagePicker().pickImages();
        expect(mocks.setSelectedImages).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(
            'imageUpload.fileTooLargeTitle',
            'imageUpload.fileTooLargeMessage',
            expect.any(Array),
        );
    });

    it('enforces MAX_IMAGES_PER_MESSAGE = 20 cap on Android', async () => {
        mocks.platform.OS = 'android';
        mocks.initialSelectedImages = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, (_, idx) => ({
            id: `img-${idx}`,
            uri: `file:///test/${idx}.jpg`,
            width: 100,
            height: 100,
            mimeType: 'image/jpeg',
            size: 1000,
            name: `${idx}.jpg`,
        }));

        await useImagePicker().pickImages();

        expect(mocks.launchImageLibraryAsync).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(
            'imageUpload.limitTitle',
            'imageUpload.limitMessage',
            expect.any(Array),
        );
    });
});

describe('useImagePicker transformed upload validation', () => {
    function addedImages(): AttachmentPreview[] {
        expect(mocks.setSelectedImages).toHaveBeenCalledTimes(1);
        return mocks.setSelectedImages.mock.calls[0][0]([]);
    }

    it('adds the converted bytes/size, not the original oversized HEIC', async () => {
        mocks.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ ...photo, fileSize: MAX_FILE_SIZE + 1 }] });
        await useImagePicker().pickImages();
        expect(addedImages()).toEqual([expect.objectContaining({
            uri: 'file:///test/normalized.jpg', size: 3_000_000,
            width: 2304, height: 3072, name: 'photo.jpg', mimeType: 'image/jpeg', thumbhash: 'thumbhash',
        })]);
        expect(mocks.generateThumbhash).toHaveBeenCalledExactlyOnceWith('file:///test/normalized.jpg', 2304, 3072);
        expect(mocks.alert).not.toHaveBeenCalled();
    });

    it.each([MAX_FILE_SIZE + 1, MAX_FILE_SIZE, MAX_FILE_SIZE - 39])('rejects transformed size %i including encryption overhead and cleans up converted temp file', async (size) => {
        mocks.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: false, size });
        await useImagePicker().pickImages();
        expect(mocks.deleteAsync).toHaveBeenCalledExactlyOnceWith('file:///test/normalized.jpg', { idempotent: true });
        expect(mocks.alert).toHaveBeenCalledWith('imageUpload.fileTooLargeTitle', 'imageUpload.fileTooLargeMessage', expect.any(Array));
        expect(mocks.generateThumbhash).not.toHaveBeenCalled();
        expect(mocks.setSelectedImages).not.toHaveBeenCalled();
    });

    it('never deletes source asset.uri when rejecting an oversized image whose normalized URI equals asset.uri', async () => {
        mocks.manipulateAsync.mockResolvedValueOnce({ uri: photo.uri, width: 2304, height: 3072 });
        mocks.getInfoAsync.mockResolvedValueOnce({ exists: true, isDirectory: false, size: MAX_FILE_SIZE });
        await useImagePicker().pickImages();
        expect(mocks.deleteAsync).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledWith('imageUpload.fileTooLargeTitle', 'imageUpload.fileTooLargeMessage', expect.any(Array));
    });

    it('accepts the exact encrypted upload boundary and reports plaintext bytes', async () => {
        mocks.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: false, size: MAX_FILE_SIZE - 40 });
        await useImagePicker().pickImages();
        expect(addedImages()[0].size).toBe(MAX_FILE_SIZE - 40);
    });

    it('accepts unknown original filesize after measuring the JPEG', async () => {
        mocks.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ ...photo, fileSize: undefined }] });
        await useImagePicker().pickImages();
        expect(addedImages()[0].size).toBe(3_000_000);
    });

    it.each(['manipulateAsync', 'getInfoAsync'] as const)('isolates %s failure without dropping valid sibling images', async (operation) => {
        mocks.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [photo, photo] });
        mocks[operation].mockRejectedValueOnce(new Error('native failure'));
        await expect(useImagePicker().pickImages()).resolves.toBeUndefined();
        expect(addedImages()).toHaveLength(1);
        expect(mocks.alert).toHaveBeenCalledWith('imageUpload.uploadFailedTitle', 'imageUpload.uploadFailedMessage', expect.any(Array));
    });

    it('does not add an image whose converted size is unavailable', async () => {
        mocks.getInfoAsync.mockResolvedValue({ exists: false });
        await expect(useImagePicker().pickImages()).resolves.toBeUndefined();
        expect(mocks.setSelectedImages).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledTimes(1);
    });

    it.each([{ canceled: true, assets: null }, { canceled: false, assets: [] }])('does nothing on canceled/empty selection', async (result) => {
        mocks.launchImageLibraryAsync.mockResolvedValue(result);
        await useImagePicker().pickImages();
        expect(mocks.manipulateAsync).not.toHaveBeenCalled();
        expect(mocks.getInfoAsync).not.toHaveBeenCalled();
        expect(mocks.setSelectedImages).not.toHaveBeenCalled();
        expect(mocks.alert).not.toHaveBeenCalled();
    });
});

describe('readImageDataUri', () => {
    it('separates the type from the bytes', () => {
        expect(readImageDataUri('data:image/png;base64,AAAA')).toEqual({ mimeType: 'image/png', base64: 'AAAA' });
        expect(readImageDataUri('DATA:IMAGE/JPEG;BASE64,QUJD')).toEqual({ mimeType: 'image/jpeg', base64: 'QUJD' });
    });

    it.each([
        'data:text/plain;base64,AAAA',
        'data:image/png,AAAA',
        'file:///photo.png',
        'data:image/png;base64,',
        '',
    ])('refuses %s', (uri) => {
        expect(readImageDataUri(uri)).toBeNull();
    });
});

describe('useImagePicker pasting', () => {
    const clipboardImage = {
        data: 'data:image/png;base64,QUJD',
        size: { width: 1200, height: 800 },
    };

    it('attaches a clipboard image by the same road a picked one takes', async () => {
        mocks.hasImageAsync.mockResolvedValue(true);
        mocks.getImageAsync.mockResolvedValue(clipboardImage);

        await expect(useImagePicker().pasteImages()).resolves.toBe(true);

        // Written to a file first: the upload reads one, and on Android the
        // picker's own path never converts.
        expect(mocks.writeAsStringAsync).toHaveBeenCalledExactlyOnceWith(
            expect.stringMatching(/^file:\/\/\/cache\/paste_\d+\.png$/),
            'QUJD',
            { encoding: 'base64' },
        );
        const added = mocks.setSelectedImages.mock.calls[0][0]([]);
        expect(added).toEqual([expect.objectContaining({
            uri: 'file:///test/normalized.jpg', mimeType: 'image/jpeg', size: 3_000_000, thumbhash: 'thumbhash',
        })]);
    });

    // Paste was asked for by name, so an empty clipboard gets an answer.
    it('says there is nothing to paste when the clipboard holds no picture', async () => {
        mocks.hasImageAsync.mockResolvedValue(false);
        await expect(useImagePicker().pasteImages()).resolves.toBe(false);
        expect(mocks.getImageAsync).not.toHaveBeenCalled();
        expect(mocks.setSelectedImages).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(
            'imageUpload.nothingToPasteTitle', 'imageUpload.nothingToPasteMessage', expect.any(Array),
        );
    });

    // On iOS 16+ a refused paste is indistinguishable from an empty clipboard.
    it('says there is nothing to paste when the paste is refused', async () => {
        mocks.hasImageAsync.mockResolvedValue(true);
        mocks.getImageAsync.mockResolvedValue(null);
        await expect(useImagePicker().pasteImages()).resolves.toBe(false);
        expect(mocks.setSelectedImages).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(
            'imageUpload.nothingToPasteTitle', 'imageUpload.nothingToPasteMessage', expect.any(Array),
        );
    });

    it('holds a pasted image to the same size limit as a picked one', async () => {
        mocks.hasImageAsync.mockResolvedValue(true);
        mocks.getImageAsync.mockResolvedValue(clipboardImage);
        mocks.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: false, size: MAX_FILE_SIZE + 1 });

        await expect(useImagePicker().pasteImages()).resolves.toBe(false);
        expect(mocks.setSelectedImages).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledWith('imageUpload.fileTooLargeTitle', 'imageUpload.fileTooLargeMessage', expect.any(Array));
    });

    it('says so rather than throwing when the clipboard cannot be read', async () => {
        mocks.hasImageAsync.mockRejectedValue(new Error('no permission'));
        await expect(useImagePicker().pasteImages()).resolves.toBe(false);
        expect(mocks.setSelectedImages).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledExactlyOnceWith(
            'imageUpload.nothingToPasteTitle', 'imageUpload.nothingToPasteMessage', expect.any(Array),
        );
    });

    // Always offered, so Paste is somewhere to be seen: a choice that only
    // appeared when the clipboard held a picture read as missing otherwise.
    it('offers paste and the library every time, without reading the clipboard first', async () => {
        mocks.hasImageAsync.mockResolvedValue(false);
        await useImagePicker().attachImages();
        expect(mocks.hasImageAsync).not.toHaveBeenCalled();
        expect(mocks.launchImageLibraryAsync).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledExactlyOnceWith('imageUpload.attachTitle', undefined, [
            expect.objectContaining({ text: 'imageUpload.pasteFromClipboard' }),
            expect.objectContaining({ text: 'imageUpload.chooseFromLibrary' }),
            expect.objectContaining({ text: 'common.cancel', style: 'cancel' }),
        ]);
    });

    it('pastes when Paste is chosen and opens the library when the library is', async () => {
        mocks.hasImageAsync.mockResolvedValue(true);
        mocks.getImageAsync.mockResolvedValue(clipboardImage);
        await useImagePicker().attachImages();
        const buttons = mocks.alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];

        buttons.find((button) => button.text === 'imageUpload.pasteFromClipboard')!.onPress!();
        await vi.waitFor(() => expect(mocks.setSelectedImages).toHaveBeenCalledOnce());
        expect(mocks.launchImageLibraryAsync).not.toHaveBeenCalled();

        buttons.find((button) => button.text === 'imageUpload.chooseFromLibrary')!.onPress!();
        await vi.waitFor(() => expect(mocks.launchImageLibraryAsync).toHaveBeenCalledOnce());
    });

    describe('on Android', () => {
        beforeEach(() => { mocks.platform.OS = 'android'; });

        it('writes clipboard PNG to cache, normalizes to JPEG, and measures normalized bytes', async () => {
            mocks.hasImageAsync.mockResolvedValue(true);
            mocks.getImageAsync.mockResolvedValue(clipboardImage);
            mocks.getInfoAsync
                .mockResolvedValueOnce({ exists: true, isDirectory: false, size: 2_000_000 })
                .mockResolvedValueOnce({ exists: true, isDirectory: false, size: 1_234_567 });

            await expect(useImagePicker().pasteImages()).resolves.toBe(true);

            expect(mocks.manipulateAsync).toHaveBeenCalledExactlyOnceWith(
                expect.stringMatching(/^file:\/\/\/cache\/paste_\d+\.png$/),
                [],
                { compress: 0.92, format: 'jpeg' },
            );
            const added = mocks.setSelectedImages.mock.calls[0][0]([]);
            expect(added).toEqual([expect.objectContaining({
                uri: 'file:///test/normalized.jpg',
                mimeType: 'image/jpeg',
                size: 1_234_567,
            })]);
        });

        it('holds a pasted image on Android to the MAX_FILE_SIZE - 40 (10,485,720 B) limit', async () => {
            mocks.hasImageAsync.mockResolvedValue(true);
            mocks.getImageAsync.mockResolvedValue(clipboardImage);
            mocks.getInfoAsync.mockResolvedValue({ exists: true, isDirectory: false, size: MAX_FILE_SIZE - 39 });

            await expect(useImagePicker().pasteImages()).resolves.toBe(false);
            expect(mocks.setSelectedImages).not.toHaveBeenCalled();
            expect(mocks.alert).toHaveBeenCalledWith('imageUpload.fileTooLargeTitle', 'imageUpload.fileTooLargeMessage', expect.any(Array));
        });

        it('says so rather than attaching an image it could not weigh', async () => {
            mocks.hasImageAsync.mockResolvedValue(true);
            mocks.getImageAsync.mockResolvedValue(clipboardImage);
            mocks.getInfoAsync.mockResolvedValue({ exists: false });

            await expect(useImagePicker().pasteImages()).resolves.toBe(false);
            expect(mocks.setSelectedImages).not.toHaveBeenCalled();
            expect(mocks.alert).toHaveBeenCalledWith('imageUpload.uploadFailedTitle', 'imageUpload.uploadFailedMessage', expect.any(Array));
        });
    });

    // The web composer takes a paste and a drop on the document itself, and
    // there is no cache to paste into there, so the button stays a picker.
    describe('on web', () => {
        beforeEach(() => { mocks.platform.OS = 'web'; });

        it('opens the library without asking or touching the clipboard', async () => {
            mocks.hasImageAsync.mockResolvedValue(true);
            await useImagePicker().attachImages();
            expect(mocks.hasImageAsync).not.toHaveBeenCalled();
            expect(mocks.launchImageLibraryAsync).toHaveBeenCalledOnce();
            expect(mocks.alert).not.toHaveBeenCalled();
        });

        it('pastes nothing, since there is no cache to write a file into', async () => {
            mocks.hasImageAsync.mockResolvedValue(true);
            mocks.getImageAsync.mockResolvedValue(clipboardImage);
            await expect(useImagePicker().pasteImages()).resolves.toBe(false);
            expect(mocks.hasImageAsync).not.toHaveBeenCalled();
            expect(mocks.writeAsStringAsync).not.toHaveBeenCalled();
            expect(mocks.setSelectedImages).not.toHaveBeenCalled();
        });
    });
});
