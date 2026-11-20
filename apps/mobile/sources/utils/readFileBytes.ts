/**
 * Read file bytes from a URI — native implementation.
 * Uses expo-file-system/legacy directly for file:// URIs and stages non-SAF
 * Android content:// URIs via copyAsync into cacheDirectory before reading.
 */
import { cacheDirectory, copyAsync, deleteAsync, readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { decodeBase64 } from '@/encryption/base64';

export async function readFileBytes(uri: string): Promise<Uint8Array> {
    if (uri.startsWith('content://') && cacheDirectory) {
        const tempUri = `${cacheDirectory}codelync_read_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        try {
            await copyAsync({ from: uri, to: tempUri });
            const base64 = await readAsStringAsync(tempUri, { encoding: EncodingType.Base64 });
            return decodeBase64(base64);
        } finally {
            await deleteAsync(tempUri, { idempotent: true }).catch(() => {});
        }
    }
    const base64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
    return decodeBase64(base64);
}
