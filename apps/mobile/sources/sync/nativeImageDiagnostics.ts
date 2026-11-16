import AsyncStorage from '@react-native-async-storage/async-storage';
type Stage = 'rpc-start' | 'rpc-received' | 'rpc-failed' | 'rpc-decrypt-failed' | 'connection-changed' | 'response-invalid' | 'download-start' | 'download-failed' | 'blob-decrypt-failed' | 'image-loaded' | 'render-failed' | 'preview-scope';
const key = 'codelight-native-image-diagnostics-v1';
let tail = Promise.resolve();
/** Bounded device-private stages only; no image, path, ref, URL, credentials or conversation text. */
export function noteNativeImageStage(stage: Stage, info: { bytes?: number; ms?: number; reason?: string; keyPresent?: boolean; peerMatch?: boolean } = {}): void {
    tail = tail.catch(() => {}).then(async () => {
        let records: unknown[] = [];
        try { const value = JSON.parse(await AsyncStorage.getItem(key) ?? '[]'); if (Array.isArray(value)) records = value; } catch { /* Missing diagnostic history is optional. */ }
        records.push({ at: Date.now(), stage, ...info });
        await AsyncStorage.setItem(key, JSON.stringify(records.slice(-40)));
    }).catch(() => {});
}
