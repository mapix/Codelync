import { expect, it } from 'vitest';
import { attachmentMediaKind, loadedAttachmentMime, safeAttachmentName, attachmentPreviewByteLimit, MAX_VIDEO_PREVIEW_BYTES, MAX_ATTACHMENT_PREVIEW_BYTES, loadedVideoExceedsPreviewLimit } from './attachmentMedia';
import { NativeFileArgumentsSchema } from '@/sync/typesRaw';

it('preserves declared file/video MIME in owned file markers instead of assuming image dimensions', () => {
    const file = NativeFileArgumentsSchema.parse({ ref: 'owned', name: 'report.pdf', mimeType: 'application/pdf' });
    expect('mimeType' in file && file.mimeType).toBe('application/pdf');
    expect(attachmentMediaKind({ name: 'report.pdf', mimeType: 'application/pdf' })).toBe('file');
    expect(attachmentMediaKind({ name: 'clip.mp4' })).toBe('video');
    expect(attachmentMediaKind({ name: 'no-extension', image: { width: 1, height: 1 } })).toBe('image');
});
it('checks bytes separately from card metadata and never assumes PDF data is PNG', () => {
    expect(loadedAttachmentMime(new TextEncoder().encode('%PDF-1.7'), { name: 'image.png', mimeType: 'image/png' })).toBe('application/pdf');
    expect(loadedAttachmentMime(new Uint8Array([0, 1, 2]), { name: 'document.bin' })).toBe('application/octet-stream');
});
it('sanitizes names without allowing file path traversal', () => {
    expect(safeAttachmentName('../../clip<script>.mp4')).toBe('clip_script_.mp4');
});
it('uses decimal 1 MB for metadata video and keeps ordinary files at 10 MiB', () => {
    expect(MAX_VIDEO_PREVIEW_BYTES).toBe(1_000_000);
    expect(attachmentPreviewByteLimit({ name: 'clip.mp4' })).toBe(1_000_000);
    expect(attachmentMediaKind({ name: 'clip.mp4', mimeType: 'application/octet-stream' })).toBe('video');
    expect(attachmentPreviewByteLimit({ name: 'clip.mp4', mimeType: 'application/octet-stream' })).toBe(1_000_000);
    expect(attachmentPreviewByteLimit({ name: 'no-extension', mimeType: 'video/webm' })).toBe(1_000_000);
    expect(attachmentPreviewByteLimit({ name: 'ordinary.pdf', mimeType: 'application/pdf' })).toBe(MAX_ATTACHMENT_PREVIEW_BYTES);
    expect(loadedVideoExceedsPreviewLimit({ mimeType: 'video/mp4', size: 1_000_000 })).toBe(false);
    expect(loadedVideoExceedsPreviewLimit({ mimeType: 'video/mp4', size: 1_000_001 })).toBe(true);
    expect(loadedVideoExceedsPreviewLimit({ mimeType: 'application/octet-stream', size: 1_000_001 })).toBe(false);
});
