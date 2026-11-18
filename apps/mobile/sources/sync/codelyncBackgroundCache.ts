import { MMKV } from 'react-native-mmkv';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import type { AuthCredentials } from '@/auth/tokenStorage';
import type { CodelyncBackgroundCache } from './codelyncBackgroundCore';
import { getServerUrl } from './serverConfig';

const cacheStorage = new MMKV({ id: 'codelync-ciphertext-cache-v1' });
const KEY = 'snapshot', SELECTED_KEY = 'selected';
let memoText: string | undefined, memo: CodelyncBackgroundCache | null = null;
let selectedText: string | undefined, selectedMemo: { scope: string; selected: string[] } | null = null;

function readSelectedIndex(scope: string): string[] | null {
    try {
        const text = cacheStorage.getString(SELECTED_KEY) ?? 'null';
        if (text !== selectedText) {
            selectedMemo = JSON.parse(text) as { scope: string; selected: string[] } | null;
            selectedText = text;
        }
        if (selectedMemo?.scope === scope && Array.isArray(selectedMemo.selected)) {
            return selectedMemo.selected;
        }
    } catch { /* A selected-index parse failure falls back to snapshot or empty. */ }
    return null;
}

export const codelyncAccountScope = (credentials: AuthCredentials) => digestStringAsync(CryptoDigestAlgorithm.SHA256,
    JSON.stringify([credentials.peer ? 'peer:' + credentials.peer.id : credentials.serverUrl ?? getServerUrl(), credentials.token, credentials.secret]));
export function loadCodelyncBackgroundCache(scope: string): CodelyncBackgroundCache {
    try {
        const text = cacheStorage.getString(KEY) ?? 'null';
        if (text !== memoText) { memo = JSON.parse(text) as CodelyncBackgroundCache | null; memoText = text; }
        const value = memo;
        if (value?.scope === scope && Array.isArray(value.sessions) && Array.isArray(value.selected) && value.messages) {
            const recent = readSelectedIndex(scope);
            return recent ? { ...value, selected: recent } : value;
        }
    } catch { /* A cache parse failure must not prevent fresh synchronization. */ }
    return { scope, updatedAt: 0, sessions: [], selected: [], messages: {} };
}
export function saveCodelyncBackgroundCache(value: CodelyncBackgroundCache) {
    const current = loadCodelyncBackgroundCache(value.scope);
    if (current.updatedAt > value.updatedAt) return;
    // A visit during background IO still owns the selected-session list.
    const next: CodelyncBackgroundCache = { ...value, selected: current.selected.length ? current.selected : value.selected };
    const serialized = JSON.stringify(next);
    cacheStorage.set(KEY, serialized);
    memoText = serialized;
    memo = next;
}
export async function rememberCodelyncSession(credentials: AuthCredentials, sessionId: string) {
    const scope = await codelyncAccountScope(credentials);
    const selected = readSelectedIndex(scope) ?? loadCodelyncBackgroundCache(scope).selected;
    if (selected[0] === sessionId) return;
    // 会话选择只写小索引，旧实现每次进入都 JSON 重写整个多 MB 密文目录。
    const next = { scope, selected: [sessionId, ...selected.filter(id => id !== sessionId)].slice(0, 16) };
    const serialized = JSON.stringify(next);
    cacheStorage.set(SELECTED_KEY, serialized);
    selectedText = serialized;
    selectedMemo = next;
}
export function clearCodelyncBackgroundCache() {
    cacheStorage.delete(KEY);
    cacheStorage.delete(SELECTED_KEY);
    memoText = undefined;
    memo = null;
    selectedText = undefined;
    selectedMemo = null;
}
