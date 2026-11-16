import type { AuthCredentials } from '@/auth/tokenStorage';
import { encryptBlob, decryptBlob } from '@/encryption/blob';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { encodeUTF8, decodeUTF8 } from '@/encryption/text';
import { codeLightAccountScope, loadCodeLightBackgroundCache, saveCodeLightBackgroundCache } from './codeLightBackgroundCache';
import { peerDescriptorSession, type PeerSessionDescriptor } from './codeLightRecent';
const MAX_BYTES = 16 * 1024 * 1024;

/** 缓存只使目录可浏览；当前会话事实仍由独立的新鲜 recent 读取确认。 */
export async function loadCodeLightPeerCatalogState(credentials: AuthCredentials): Promise<{ sessions: PeerSessionDescriptor[]; watermark: string | null }> {
    if (!credentials.peer) return { sessions: [], watermark: null };
    const scope = await codeLightAccountScope(credentials), ciphertext = loadCodeLightBackgroundCache(scope).peerCatalogCiphertext;
    if (!ciphertext || ciphertext.length > MAX_BYTES * 2) return { sessions: [], watermark: null };
    try {
        const plain = decryptBlob(decodeBase64(ciphertext, 'base64'), decodeBase64(credentials.secret, 'base64url'));
        if (!plain || plain.length > MAX_BYTES) return { sessions: [], watermark: null };
        const value = JSON.parse(decodeUTF8(plain));
        if (![1, 2].includes(value.version) || value.scope !== scope || !Array.isArray(value.sessions) || value.sessions.length > 10000) return { sessions: [], watermark: null };
        const sessions = value.sessions.map((row: PeerSessionDescriptor) => {
            const stale = { ...row, active: false, agentState: null, basicOnly: true };
            peerDescriptorSession(stale); return stale;
        });
        return { sessions, watermark: value.version === 2 && typeof value.watermark === 'string' && value.watermark.length <= 512 ? value.watermark : null };
    } catch { return { sessions: [], watermark: null }; }
}
export async function loadCodeLightPeerCatalog(credentials: AuthCredentials): Promise<PeerSessionDescriptor[]> { return (await loadCodeLightPeerCatalogState(credentials)).sessions; }
export async function saveCodeLightPeerCatalog(credentials: AuthCredentials, sessions: PeerSessionDescriptor[], current: () => boolean, watermark: string | null = null) {
    const scope = await codeLightAccountScope(credentials);
    if (!current() || sessions.length > 10000) return;
    const plain = encodeUTF8(JSON.stringify({ version: watermark ? 2 : 1, scope, sessions, ...(watermark ? { watermark } : {}) }));
    if (plain.length > MAX_BYTES) return;
    const peerCatalogCiphertext = encodeBase64(encryptBlob(plain, decodeBase64(credentials.secret, 'base64url')), 'base64');
    if (current()) saveCodeLightBackgroundCache({ ...loadCodeLightBackgroundCache(scope), peerCatalogCiphertext, updatedAt: Date.now() });
}
