import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';

export const MAX_CAPPED_ATTACHMENT_BYTES = 10 * 1024 * 1024 + 40;

export class CappedAttachmentError extends Error {
    readonly status: 400 | 404 | 409 | 413 | 503;

    constructor(status: 400 | 404 | 409 | 413 | 503, message: string) {
        super(message);
        this.name = 'CappedAttachmentError';
        this.status = status;
    }
}

function validateLimit(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_CAPPED_ATTACHMENT_BYTES) {
        throw new CappedAttachmentError(400, 'Invalid attachment byte limit');
    }
}

async function checkedStat(file: FileHandle, maxBytes: number): Promise<Stats> {
    const stat = await file.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
        throw new CappedAttachmentError(503, 'Attachment size unavailable');
    }
    if (stat.size > maxBytes) throw new CappedAttachmentError(413, 'Attachment exceeds the byte limit');
    return stat;
}

async function withCappedFile<T>(fullPath: string, maxBytes: number, body: (file: FileHandle, stat: Stats) => Promise<T>): Promise<T> {
    validateLimit(maxBytes);
    let file: FileHandle | undefined;
    try {
        file = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const stat = await checkedStat(file, maxBytes);
        return await body(file, stat);
    } catch (error) {
        if (error instanceof CappedAttachmentError) throw error;
        const code = (error as NodeJS.ErrnoException)?.code;
        throw new CappedAttachmentError(['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code ?? '') ? 404 : 503,
            ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code ?? '') ? 'Attachment not found' : 'Attachment size unavailable');
    } finally {
        await file?.close().catch(() => {});
    }
}

/** Metadata only: no file byte is read while deciding whether to issue a URL. */
export function statCappedLocalAttachment(fullPath: string, maxBytes: number): Promise<number> {
    return withCappedFile(fullPath, maxBytes, async (_file, stat) => stat.size);
}

/** Hold bounded response bytes in memory before sending any blob byte. */
export function readCappedLocalAttachment(fullPath: string, maxBytes: number): Promise<Buffer> {
    return withCappedFile(fullPath, maxBytes, async (file, before) => {
        const buffer = Buffer.allocUnsafe(before.size);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
            if (!bytesRead) throw new CappedAttachmentError(409, 'Attachment changed during capped read');
            offset += bytesRead;
        }
        const after = await checkedStat(file, maxBytes);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw new CappedAttachmentError(409, 'Attachment changed during capped read');
        }
        return buffer;
    });
}

/** Async bounded non-symlink read for ordinary local encrypted attachments. */
export function readLocalAttachment(fullPath: string): Promise<Buffer> {
    return readCappedLocalAttachment(fullPath, MAX_CAPPED_ATTACHMENT_BYTES);
}
