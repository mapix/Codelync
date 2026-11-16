import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ key: new Uint8Array(32), readCredentials: vi.fn(), download: vi.fn(), write: vi.fn(), remove: vi.fn(),
    bytes: new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]) }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///fixture-cache/', writeAsStringAsync: mock.write, deleteAsync: mock.remove, EncodingType: { Base64: 'base64', UTF8: 'utf8' } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'synthetic-uuid' }));
vi.mock('./sync', () => ({ sync: { getCredentials: () => ({ token: 'synthetic', secret: 'synthetic' }), encryption: { getSessionBlobKey: () => mock.key } } }));
vi.mock('./imageReadCredentials', () => ({ currentImageReadCredentials: mock.readCredentials }));
vi.mock('./apiAttachments', () => ({ downloadEncryptedAttachment: mock.download }));
vi.mock('@/encryption/blob', () => ({ decryptBlob: () => mock.bytes }));
import { loadAttachmentFile, MAX_ATTACHMENT_PREVIEW_BYTES } from './attachmentFile';
import { MAX_VIDEO_PREVIEW_BYTES } from '@/utils/attachmentMedia';
import { createAttachmentDiagnosticError } from './attachmentDiagnostics';
beforeEach(() => { vi.clearAllMocks(); mock.key = new Uint8Array(32); mock.readCredentials.mockResolvedValue({ token: 'synthetic', secret: 'synthetic' });
    mock.bytes = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    mock.download.mockResolvedValue(new Uint8Array(52)); mock.write.mockResolvedValue(undefined); mock.remove.mockResolvedValue(undefined); });
afterEach(() => vi.restoreAllMocks());

it('loads the owned encrypted ref once and deletes the local video when closed', async () => {
    const signal = new AbortController().signal;
    const file = await loadAttachmentFile('owned-session', 'owned-ref', { name: '../../clip.mp4', mimeType: 'video/mp4' }, signal);
    expect(mock.download).toHaveBeenCalledOnce(); expect(mock.download.mock.calls[0].slice(1, 3)).toEqual(['owned-session', 'owned-ref']);
    expect(file.uri).toBe('file:///fixture-cache/codelight-file-synthetic-uuid-clip.mp4');
    expect(mock.write).toHaveBeenCalledOnce();
    await file.dispose(); expect(mock.remove.mock.calls.map(call => call[0])).toEqual([file.uri]);
});
it('a changed credential owner cannot create or publish a cleartext file', async () => {
    mock.readCredentials.mockResolvedValueOnce({}).mockRejectedValueOnce(Error('Owner changed'));
    await expect(loadAttachmentFile('session', 'ref', { name: 'clip.mp4' }, new AbortController().signal)).rejects.toThrow('Owner changed');
    expect(mock.write).not.toHaveBeenCalled();
});
it('closing during a file write cleans temporary data before resolving', async () => {
    const controller = new AbortController(); mock.write.mockImplementationOnce(async () => controller.abort());
    await expect(loadAttachmentFile('session', 'ref', { name: 'clip.mp4' }, controller.signal)).rejects.toThrow('source changed');
    expect(mock.remove).toHaveBeenCalledOnce();
});
it('known oversized metadata triggers no credential, download or cleartext IO', async () => {
    await expect(loadAttachmentFile('session', 'ref', { name: 'large.bin', size: MAX_ATTACHMENT_PREVIEW_BYTES + 1 }, new AbortController().signal)).rejects.toThrow('preview limit');
    expect(mock.readCredentials).not.toHaveBeenCalled(); expect(mock.download).not.toHaveBeenCalled(); expect(mock.write).not.toHaveBeenCalled();
});

it.each([MAX_VIDEO_PREVIEW_BYTES, MAX_VIDEO_PREVIEW_BYTES + 1])('enforces the exact decimal video plaintext boundary at %s bytes', async size => {
    const prefix = mock.bytes; mock.bytes = new Uint8Array(size); mock.bytes.set(prefix);
    const load = loadAttachmentFile('session', 'ref', { name: 'clip.mp4', mimeType: 'video/mp4' }, new AbortController().signal);
    if (size === MAX_VIDEO_PREVIEW_BYTES) { const result = await load; expect(result.size).toBe(size); expect(mock.write).toHaveBeenCalledOnce(); }
    else { await expect(load).rejects.toThrow('1 MB preview limit'); expect(mock.write).not.toHaveBeenCalled(); }
    expect(mock.download.mock.calls[0][3]).toMatchObject({ maxBytes: 1_000_040, requireStreaming: true, requireSizeGate: true });
});

it('known video metadata over 1 MB triggers zero credential, download or cleartext IO', async () => {
    await expect(loadAttachmentFile('session', 'ref', { name: 'clip.mp4', size: MAX_VIDEO_PREVIEW_BYTES + 1 }, new AbortController().signal)).rejects.toThrow('1 MB preview limit');
    expect(mock.readCredentials).not.toHaveBeenCalled(); expect(mock.download).not.toHaveBeenCalled(); expect(mock.write).not.toHaveBeenCalled();
});
it('a recognized video extension with generic MIME cannot borrow the ordinary-file budget', async () => {
    await expect(loadAttachmentFile('session', 'ref', { name: 'clip.mp4', mimeType: 'application/octet-stream', size: 1_000_001 }, new AbortController().signal)).rejects.toThrow('1 MB preview limit');
    expect(mock.readCredentials).not.toHaveBeenCalled(); expect(mock.download).not.toHaveBeenCalled(); expect(mock.write).not.toHaveBeenCalled();
});

it('unknown-sized video maps the streaming cap failure to its 1 MB limit', async () => {
    mock.download.mockRejectedValueOnce(createAttachmentDiagnosticError('Attachment exceeds the read limit', { leg: 'blob-download', reason: 'read-limit-exceeded' }));
    await expect(loadAttachmentFile('session', 'ref', { name: 'clip.mp4' }, new AbortController().signal)).rejects.toThrow('1 MB preview limit');
    expect(mock.download.mock.calls[0][3]).toMatchObject({ maxBytes: 1_000_040, requireStreaming: true, requireSizeGate: true }); expect(mock.write).not.toHaveBeenCalled();
});

it('a generic declaration cannot write an actual detected oversized video', async () => {
    const prefix = mock.bytes; mock.bytes = new Uint8Array(MAX_VIDEO_PREVIEW_BYTES + 1); mock.bytes.set(prefix);
    await expect(loadAttachmentFile('session', 'ref', { name: 'generic.bin', mimeType: 'application/octet-stream' }, new AbortController().signal)).rejects.toThrow('1 MB preview limit');
    expect(mock.download.mock.calls[0][3]).toMatchObject({ maxBytes: MAX_ATTACHMENT_PREVIEW_BYTES + 40, requireStreaming: false, requireSizeGate: false });
    expect(mock.write).not.toHaveBeenCalled();
});

it.each([MAX_VIDEO_PREVIEW_BYTES + 1, MAX_ATTACHMENT_PREVIEW_BYTES])('ordinary files retain the existing 10 MiB contract at %s bytes', async size => {
    mock.bytes = new Uint8Array(size);
    const result = await loadAttachmentFile('session', 'ref', { name: 'ordinary.bin', mimeType: 'application/octet-stream', size }, new AbortController().signal);
    expect(result.size).toBe(size); expect(mock.write).toHaveBeenCalledOnce();
    expect(mock.download.mock.calls[0][3]).toMatchObject({ maxBytes: MAX_ATTACHMENT_PREVIEW_BYTES + 40, requireStreaming: false, requireSizeGate: false });
});
