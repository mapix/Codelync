import nacl from 'tweetnacl';
import { getRandomBytes } from 'expo-crypto';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { openPeerBox } from '@/encryption/openPeerBox';
import { decodePeerText } from '@/encryption/decodePeerText';
import { channelPath, type PeerCredentials } from '@slopus/happy-wire/codelight';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { isSameServerEndpoint } from '@/utils/serverOrigin';
import { decodeCompactPeerPlaintext, inspectCompactPeerPlaintext, parseCompactPeerJson, PEER_RESPONSE_CODEC_HEADER, PEER_RESPONSE_CODEC_VALUE, PEER_RESPONSE_MAX_BYTES } from '@slopus/happy-wire/peer-codec';
import type { PeerDecodeObserver, PeerDecodeStage } from '@slopus/happy-wire/peer-codec';
import { decodeNativePeerPayload, nativePeerPayloadAvailable } from '@/encryption/nativePeerPayload';

function decodeStage<T>(stage: PeerDecodeStage, read: () => T, observer?: PeerDecodeObserver): T {
    if (!observer) return read();
    const started = performance.now();
    try { return read(); } finally { try { observer(stage, performance.now() - started); } catch { /* Measurement is not dispatch authority. */ } }
}

export function peerResponseHeaders(): Record<string, string> { return { [PEER_RESPONSE_CODEC_HEADER]: PEER_RESPONSE_CODEC_VALUE }; }

export const PEER_ACTIVITY_REQUEST_MAX_BYTES = 256 * 1024;
export const PEER_ACTIVITY_CARRIER_MAX_BYTES = 360 * 1024;
/** The activity request carries descriptors privately even on a local HTTP route. */
export function sealPeerRequest(peer: PeerCredentials, payload: Record<string, unknown>, path: string, method: string): [2, string, string] {
    if (path !== '/api/peer/activity' || method !== 'POST' || typeof peer.id !== 'string' || !peer.id
        || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('Unsupported sealed activity request');
    const plain = new TextEncoder().encode(JSON.stringify([peer.id, method, path, payload]));
    if (plain.length > PEER_ACTIVITY_REQUEST_MAX_BYTES) throw Error('Sealed activity request is too large');
    const nonce = getRandomBytes(24);
    const ciphertext = nacl.box(plain, nonce, decodeBase64(peer.key, 'base64url'), decodeBase64(peer.device.secretKey, 'base64url'));
    const carrier: [2, string, string] = [2, encodeBase64(nonce, 'base64url'), encodeBase64(ciphertext, 'base64url')];
    if (new TextEncoder().encode(JSON.stringify(carrier)).length > PEER_ACTIVITY_CARRIER_MAX_BYTES) throw Error('Sealed activity carrier is too large');
    return carrier;
}

export function peerAuthorization(token: string, peer: PeerCredentials, origin: string, method: string, url: string): string {
    if (!peer.channels.some(channel => channel.url === origin)) throw Error('The selected channel does not belong to this Mac');
    // 冷启动 sync 早于 PairingProvider：nonce 直接取系统安全随机源，不能依赖界面安装全局 PRNG。
    const nonce = getRandomBytes(24);
    const payload = new TextEncoder().encode(JSON.stringify({ version: 2, token, origin, method, path: channelPath(origin, url), at: Date.now() }));
    const ciphertext = nacl.box(payload, nonce, decodeBase64(peer.key, 'base64url'), decodeBase64(peer.device.secretKey, 'base64url'));
    return 'CodeLight ' + encodeBase64(new TextEncoder().encode(JSON.stringify({ publicKey: peer.device.publicKey, nonce: encodeBase64(nonce, 'base64url'), ciphertext: encodeBase64(ciphertext, 'base64url') })), 'base64url');
}
export function credentialHeaders(credentials:AuthCredentials,url:string,method:string,base:string):Record<string,string> {
    if(credentials.peer){
        const channel=credentials.peer.channels.find(current=>isSameServerEndpoint(url,current.url));
        return channel?{...peerResponseHeaders(),Authorization:peerAuthorization(credentials.token,credentials.peer,channel.url,method,url)}:{};
    }
    return isSameServerEndpoint(url,base)?{Authorization:`Bearer ${credentials.token}`}:{ };
}

function openPeerResponse(peer: PeerCredentials, value: unknown, onStage?: PeerDecodeObserver): { plain: Uint8Array; compact: boolean } {
    const compact = Array.isArray(value) && value.length === 3 && value[0] === 3;
    const packet = value as { version?: number; nonce: string; ciphertext: string };
    const nonce = compact ? value[1] : packet?.nonce, ciphertext = compact ? value[2] : packet?.ciphertext;
    if (decodeStage('validate', () => !compact && packet?.version !== 2 || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(nonce)
        || typeof ciphertext !== 'string' || ciphertext.length > Math.ceil((PEER_RESPONSE_MAX_BYTES + 16) * 4 / 3)
        || !/^[A-Za-z0-9_-]+$/.test(ciphertext), onStage)) throw Error('Invalid Mac response');
    const encoded = decodeStage('base64', () => decodeBase64(ciphertext, 'base64url'), onStage); if (encoded.length < 16 || encoded.length > PEER_RESPONSE_MAX_BYTES + 16) throw Error('Invalid Mac response');
    const plain = decodeStage('authenticate', () => openPeerBox(encoded, decodeBase64(nonce, 'base64url'), decodeBase64(peer.key, 'base64url'), decodeBase64(peer.device.secretKey, 'base64url')), onStage);
    if (!plain) throw Error('The response did not authenticate this Mac');
    return { plain, compact };
}
function parsePeerPlaintext(peer: PeerCredentials, plain: Uint8Array, compact: boolean, onStage?: PeerDecodeObserver): unknown {
    if (compact) return decodeCompactPeerPlaintext(plain, peer.id, { onStage, decodeText: decodePeerText });
    let decoded: { peerId: string; payload: unknown }; try {
        const text = decodeStage('utf8', () => decodePeerText(plain), onStage);
        decoded = decodeStage('json', () => JSON.parse(text), onStage);
    } catch { throw Error('Invalid Mac response payload'); }
    if (decoded.peerId !== peer.id) throw Error('The response belongs to another Mac');
    return decoded.payload;
}

export function decodePeerResponse(peer: PeerCredentials, value: unknown, onStage?: PeerDecodeObserver): unknown {
    const opened = openPeerResponse(peer, value, onStage);
    return parsePeerPlaintext(peer, opened.plain, opened.compact, onStage);
}

export type PeerAsyncDecodeOptions = { signal?: AbortSignal; isCurrent?: () => boolean; onStage?: PeerDecodeObserver; onNativeMetrics?: (metrics: Record<string, number>) => void };

/** Data-only native work starts after pinned-Mac authentication and cannot replay a request. */
export async function decodePeerResponseAsync(peer: PeerCredentials, value: unknown, options: PeerAsyncDecodeOptions = {}): Promise<unknown> {
    const current = () => { if (options.signal?.aborted || options.isCurrent?.() === false) throw Error('Peer decode context changed'); };
    current();
    const { plain, compact } = openPeerResponse(peer, value, options.onStage);
    current();
    if (!compact || !nativePeerPayloadAvailable()) return parsePeerPlaintext(peer, plain, compact, options.onStage);
    const frame = inspectCompactPeerPlaintext(plain, peer.id);
    if (frame.expectedBytes < 64 * 1024) return parsePeerPlaintext(peer, plain, compact, options.onStage);
    const request = { bodyBase64: encodeBase64(frame.body, 'base64'), expectedBytes: frame.expectedBytes,
        compression: frame.compressed ? 'gzip' as const : 'none' as const, includeMetrics: !!options.onNativeMetrics };
    for (let attempt = 0; attempt < 3; attempt++) {
        current(); const started = performance.now();
        try {
            const result = await decodeNativePeerPayload(request); current();
            if (!result || typeof result.text !== 'string') throw Error('Invalid native peer payload');
            try { options.onStage?.('native-body', performance.now() - started); } catch { /* Metrics never change decoding. */ }
            if (result.metrics) try { options.onNativeMetrics?.(result.metrics); } catch { /* Metrics never change decoding. */ }
            return decodeStage('json', () => parseCompactPeerJson(result.text, frame.compact), options.onStage);
        } catch (error) {
            current();
            const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null;
            if (code === 'E_CODEC_UTF8') return decodeCompactPeerPlaintext(plain, peer.id, { onStage: options.onStage, decodeText: decodePeerText });
            if (code !== 'E_CODEC_BUSY' || attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 5 * (attempt + 1))); current();
        }
    }
    throw Error('Native peer payload unavailable');
}
