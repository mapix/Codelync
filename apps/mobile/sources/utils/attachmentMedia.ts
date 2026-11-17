export type AttachmentMediaKind = 'image' | 'video' | 'file';
export type AttachmentMediaMetadata = { name: string; mimeType?: string; image?: { width: number; height: number }; size?: number };
export const MAX_ATTACHMENT_PREVIEW_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_PREVIEW_BYTES = 1_000_000;

export function attachmentPreviewByteLimit(metadata: AttachmentMediaMetadata): number {
    return attachmentMediaKind(metadata) === 'video' ? MAX_VIDEO_PREVIEW_BYTES : MAX_ATTACHMENT_PREVIEW_BYTES;
}

export class AttachmentPreviewLimitError extends Error {
    constructor(readonly limit: number) {
        super(limit === MAX_VIDEO_PREVIEW_BYTES ? 'Video exceeds the 1 MB preview limit' : 'Attachment exceeds the preview limit');
        this.name = 'AttachmentPreviewLimitError';
    }
}

export function loadedVideoExceedsPreviewLimit(file: { mimeType: string; size: number }): boolean {
    return file.mimeType.startsWith('video/') && (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_VIDEO_PREVIEW_BYTES);
}

export function attachmentMediaKind(value: AttachmentMediaMetadata): AttachmentMediaKind {
    const mime = value.mimeType?.toLowerCase().split(';')[0].trim();
    if (mime?.startsWith('video/')) return 'video';
    if (mime?.startsWith('image/')) return 'image';
    const videoName = /\.(?:mp4|m4v|mov|webm|ogv|avi|mkv)$/i.test(value.name);
    if (mime === 'application/octet-stream' && videoName) return 'video';
    if (mime) return 'file';
    if (value.image) return 'image';
    if (videoName) return 'video';
    if (/\.(?:png|jpe?g|gif|webp|heic|heif|bmp|avif)$/i.test(value.name)) return 'image';
    return 'file';
}

export function safeAttachmentName(name: string): string {
    return (name.split(/[\\/]/).pop() ?? '').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').slice(0, 100) || 'Codelync-file';
}

export function attachmentByteLabel(size?: number): string | null {
    if (size === undefined || !Number.isFinite(size) || size < 0) return null;
    if (size < 1024) return `${Math.floor(size)} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function loadedAttachmentMime(bytes: Uint8Array, metadata: AttachmentMediaMetadata): string {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    const head = String.fromCharCode(...bytes.slice(0, 16));
    if (head.startsWith('GIF8')) return 'image/gif';
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
    if (head.startsWith('%PDF-')) return 'application/pdf';
    if (head.slice(4, 8) === 'ftyp') return /\.m4a$/i.test(metadata.name) || metadata.mimeType?.startsWith('audio/') ? 'audio/mp4'
        : head.slice(8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
    const mime = metadata.mimeType?.toLowerCase().split(';')[0].trim();
    if (mime && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)) return mime;
    if (/\.(?:txt|md|csv|log|json|ya?ml|toml|xml|html|css|jsx?|tsx?|py|rs|go|swift|c|cpp|h|sh)$/i.test(metadata.name)) return 'text/plain';
    return 'application/octet-stream';
}

