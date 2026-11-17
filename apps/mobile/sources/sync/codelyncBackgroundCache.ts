import { MMKV } from 'react-native-mmkv';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import type { AuthCredentials } from '@/auth/tokenStorage';
import type { CodelyncBackgroundCache } from './codelyncBackgroundCore';
import { getServerUrl } from './serverConfig';

const cacheStorage = new MMKV({ id: 'codelync-ciphertext-cache-v1' });
const KEY = 'snapshot', SELECTED_KEY = 'selected';
let memoText: string | undefined, memo: CodelyncBackgroundCache | null = null;
export const codelyncAccountScope = (credentials: AuthCredentials) => digestStringAsync(CryptoDigestAlgorithm.SHA256,
    JSON.stringify([credentials.peer ? 'peer:' + credentials.peer.id : credentials.serverUrl ?? getServerUrl(), credentials.token, credentials.secret]));
export function loadCodelyncBackgroundCache(scope: string): CodelyncBackgroundCache {
    try {
        const text = cacheStorage.getString(KEY) ?? 'null';
        if (text !== memoText) { memo = JSON.parse(text) as CodelyncBackgroundCache | null; memoText = text; }
        const value = memo;
        if (value?.scope === scope && Array.isArray(value.sessions) && Array.isArray(value.selected) && value.messages) {
            const recent = JSON.parse(cacheStorage.getString(SELECTED_KEY) ?? 'null') as { scope: string; selected: string[] } | null;
            return recent?.scope === scope && Array.isArray(recent.selected) ? { ...value, selected: recent.selected } : value;
        }
    } catch { /* A cache parse failure must not prevent fresh synchronization. */ }
    return { scope, updatedAt: 0, sessions: [], selected: [], messages: {} };
}
export function saveCodelyncBackgroundCache(value: CodelyncBackgroundCache) {
    const current = loadCodelyncBackgroundCache(value.scope);
    if (current.updatedAt > value.updatedAt) return;
    // A visit during background IO still owns the selected-session list.
    cacheStorage.set(KEY, JSON.stringify({ ...value, selected: current.selected.length ? current.selected : value.selected }));
    memoText = undefined;
}
export async function rememberCodelyncSession(credentials: AuthCredentials, sessionId: string) {
    const cache = loadCodelyncBackgroundCache(await codelyncAccountScope(credentials));
    if (cache.selected[0] === sessionId) return;
    // 会话选择只写小索引，旧实现每次进入都 JSON 重写整个多 MB 密文目录。
    cacheStorage.set(SELECTED_KEY, JSON.stringify({ scope: cache.scope, selected: [sessionId, ...cache.selected.filter(id => id !== sessionId)].slice(0, 16) }));
}
export function clearCodelyncBackgroundCache() { cacheStorage.delete(KEY); cacheStorage.delete(SELECTED_KEY); memoText = undefined; memo = null; }
