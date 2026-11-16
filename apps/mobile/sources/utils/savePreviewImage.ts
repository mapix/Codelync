import { Platform } from 'react-native';
import { cacheDirectory, writeAsStringAsync, deleteAsync, EncodingType } from 'expo-file-system/legacy';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { randomUUID } from 'expo-crypto';

/** Save only the already-loaded preview; never fetch the original file again. */
export async function savePreviewImage(uri: string, name: string, beforeShare?: () => Promise<void>): Promise<void> {
    const image = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
    if (!image) throw Error('The preview is not an image');
    const mime = image[1], extension = mime === 'image/jpeg' ? 'jpg' : mime.slice(6);
    const filename = (name.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 80) || 'CodeLight-image') + '.' + extension;
    if (Platform.OS === 'web') {
        await beforeShare?.();
        const link = document.createElement('a'); link.href = uri; link.download = filename; link.click(); return;
    }
    if (!cacheDirectory || !await isAvailableAsync()) throw Error('The system save menu is unavailable');
    await beforeShare?.();
    const path = `${cacheDirectory}codelight-image-${randomUUID()}-${filename}`;
    try {
        await writeAsStringAsync(path, image[2], { encoding: EncodingType.Base64 });
        await beforeShare?.();
        await shareAsync(path, { mimeType: mime, UTI: mime === 'image/jpeg' ? 'public.jpeg' : `public.${extension}` });
    } finally { await deleteAsync(path, { idempotent: true }).catch(() => {}); }
}
