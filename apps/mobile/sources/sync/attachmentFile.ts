import { Platform } from 'react-native';
import { cacheDirectory, writeAsStringAsync, deleteAsync, EncodingType } from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import { sync } from './sync';
import { currentImageReadCredentials } from './imageReadCredentials';
import { downloadEncryptedAttachment } from './apiAttachments';
import { decryptBlob } from '@/encryption/blob';
import { encodeBase64 } from '@/encryption/base64';
import { decodePeerText } from '@/encryption/decodePeerText';
import { AttachmentPreviewLimitError, attachmentPreviewByteLimit, loadedAttachmentMime, safeAttachmentName,
    MAX_VIDEO_PREVIEW_BYTES, type AttachmentMediaMetadata } from '@/utils/attachmentMedia';
import { getAttachmentDiagnostic } from './attachmentDiagnostics';

export { MAX_ATTACHMENT_PREVIEW_BYTES } from '@/utils/attachmentMedia';
export type LoadedAttachmentFile = { uri: string; mimeType: string; name: string; size: number; text: string | null; dispose(): Promise<void> };

/** Called only by the explicitly opened attachment preview. */
export async function loadAttachmentFile(sessionId: string, ref: string, metadata: AttachmentMediaMetadata, signal: AbortSignal): Promise<LoadedAttachmentFile> {
    const expected = sync.getCredentials();
    if (!expected || signal.aborted) throw Error('Attachment source unavailable');
    const limit = attachmentPreviewByteLimit(metadata);
    if (metadata.size !== undefined && metadata.size > limit) throw new AttachmentPreviewLimitError(limit);
    const credentials = await currentImageReadCredentials(expected);
    const sourceKey = sync.encryption.getSessionBlobKey(sessionId);
    if (!sourceKey || sourceKey.length !== 32) throw Error('Attachment key unavailable');
    const key = new Uint8Array(sourceKey);
    const assertCurrent = async () => {
        await currentImageReadCredentials(expected);
        const currentKey = sync.encryption.getSessionBlobKey(sessionId);
        if (signal.aborted || !currentKey || currentKey.length !== key.length || !key.every((byte, index) => currentKey[index] === byte)) throw Error('Attachment source changed');
    };
    let encrypted: Uint8Array;
    try { encrypted = await downloadEncryptedAttachment(credentials, sessionId, ref, { signal, maxBytes: limit + 40,
        requireStreaming: limit === MAX_VIDEO_PREVIEW_BYTES, requireSizeGate: limit === MAX_VIDEO_PREVIEW_BYTES }); }
    catch (error) {
        if (getAttachmentDiagnostic(error)?.reason === 'read-limit-exceeded') throw new AttachmentPreviewLimitError(limit);
        throw error;
    }
    await assertCurrent();
    const bytes = decryptBlob(encrypted, key);
    if (!bytes) throw Error('Attachment could not be decrypted');
    if (bytes.length > limit) throw new AttachmentPreviewLimitError(limit);
    const name = safeAttachmentName(metadata.name), mimeType = loadedAttachmentMime(bytes, metadata);
    if (mimeType.startsWith('video/') && bytes.length > MAX_VIDEO_PREVIEW_BYTES) throw new AttachmentPreviewLimitError(MAX_VIDEO_PREVIEW_BYTES);
    let text: string | null = null;
    if (mimeType.startsWith('text/') || /^(?:application\/(?:json|xml))$/.test(mimeType)) {
        const end = Math.min(bytes.length, 64 * 1024);
        for (let trim = 0; trim < 4 && text === null; trim++) {
            try { text = decodePeerText(bytes.subarray(0, Math.max(0, end - trim))); } catch { /* Avoid a cut UTF8 code point. */ }
        }
    }
    let uri: string;
    let dispose: () => Promise<void>;
    if (Platform.OS === 'web') {
        uri = URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type: mimeType }));
        dispose = async () => { URL.revokeObjectURL(uri); };
    } else {
        if (!cacheDirectory) throw Error('Attachment cache unavailable');
        uri = `${cacheDirectory}codelync-file-${randomUUID()}-${name}`;
        dispose = async () => { await deleteAsync(uri, { idempotent: true }).catch(() => {}); };
        try {
            await writeAsStringAsync(uri, encodeBase64(bytes), { encoding: EncodingType.Base64 });
        }
        catch (error) { await dispose(); throw error; }
    }
    try { await assertCurrent(); } catch (error) { await dispose(); throw error; }
    return { uri, name, mimeType, size: bytes.length, text, dispose };
}
