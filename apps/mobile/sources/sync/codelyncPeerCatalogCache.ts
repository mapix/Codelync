import nacl from 'tweetnacl';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { encryptBlob, decryptBlob } from '@/encryption/blob';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { encodeUTF8, decodeUTF8 } from '@/encryption/text';
import { codelyncAccountScope, loadCodelyncBackgroundCache, saveCodelyncBackgroundCache } from './codelyncBackgroundCache';
import { peerDescriptorSession, type PeerSessionDescriptor } from './codelyncRecent';
const MAX_BYTES = 16 * 1024 * 1024;
type CatalogState = { sessions: PeerSessionDescriptor[]; watermark: string | null };
let catalogMemo: { scope: string; keyDigest: string; ciphertext: string; state: CatalogState } | null = null;
const secretDigest = (secret: string) => encodeBase64(nacl.hash(encodeUTF8(secret)), 'base64url');
function normalizeCachedSessions(sessions: PeerSessionDescriptor[]): PeerSessionDescriptor[] {
    return sessions.map((row: PeerSessionDescriptor) => {
        const stale = { ...row, active: false, agentState: null, basicOnly: true };
        peerDescriptorSession(stale);
        return stale;
    });
}

/** 缓存只使目录可浏览；当前会话事实仍由独立的新鲜 recent 读取确认。 */
export async function loadCodelyncPeerCatalogState(credentials: AuthCredentials): Promise<{ sessions: PeerSessionDescriptor[]; watermark: string | null }> {
    if (!credentials.peer) return { sessions: [], watermark: null };
    const scope = await codelyncAccountScope(credentials), ciphertext = loadCodelyncBackgroundCache(scope).peerCatalogCiphertext;
    if (!ciphertext || ciphertext.length > MAX_BYTES * 2) { catalogMemo = null; return { sessions: [], watermark: null }; }
    const keyDigest = secretDigest(credentials.secret);
    if (catalogMemo && catalogMemo.scope === scope && catalogMemo.keyDigest === keyDigest && catalogMemo.ciphertext === ciphertext) {
        return { sessions: [...catalogMemo.state.sessions], watermark: catalogMemo.state.watermark };
    }
    try {
        const plain = decryptBlob(decodeBase64(ciphertext, 'base64'), decodeBase64(credentials.secret, 'base64url'));
        if (!plain || plain.length > MAX_BYTES) { catalogMemo = null; return { sessions: [], watermark: null }; }
        const value = JSON.parse(decodeUTF8(plain));
        if (![1, 2].includes(value.version) || value.scope !== scope || !Array.isArray(value.sessions) || value.sessions.length > 10000) {
            catalogMemo = null;
            return { sessions: [], watermark: null };
        }
        const sessions = normalizeCachedSessions(value.sessions);
        const watermark = value.version === 2 && typeof value.watermark === 'string' && value.watermark.length <= 512 ? value.watermark : null;
        catalogMemo = { scope, keyDigest, ciphertext, state: { sessions, watermark } };
        return { sessions: [...sessions], watermark };
    } catch { catalogMemo = null; return { sessions: [], watermark: null }; }
}
export async function loadCodelyncPeerCatalog(credentials: AuthCredentials): Promise<PeerSessionDescriptor[]> { return (await loadCodelyncPeerCatalogState(credentials)).sessions; }
export async function saveCodelyncPeerCatalog(credentials: AuthCredentials, sessions: PeerSessionDescriptor[], current: () => boolean, watermark: string | null = null) {
    const scope = await codelyncAccountScope(credentials);
    if (!current() || sessions.length > 10000) return;
    const plain = encodeUTF8(JSON.stringify({ version: watermark ? 2 : 1, scope, sessions, ...(watermark ? { watermark } : {}) }));
    if (plain.length > MAX_BYTES) return;
    const peerCatalogCiphertext = encodeBase64(encryptBlob(plain, decodeBase64(credentials.secret, 'base64url')), 'base64');
    if (current()) {
        saveCodelyncBackgroundCache({ ...loadCodelyncBackgroundCache(scope), peerCatalogCiphertext, updatedAt: Date.now() });
        try {
            const normalizedWatermark = typeof watermark === 'string' && watermark.length <= 512 ? watermark : null;
            catalogMemo = {
                scope,
                keyDigest: secretDigest(credentials.secret),
                ciphertext: peerCatalogCiphertext,
                state: { sessions: normalizeCachedSessions(sessions), watermark: normalizedWatermark },
            };
        } catch { catalogMemo = null; }
    }
}
