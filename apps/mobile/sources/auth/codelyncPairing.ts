import { normalizeServerOrigin } from '../utils/serverOrigin';
import { channelList, type PeerChannel, type PeerCredentials } from '@codelync/wire/codelync';
import { decodeBase64 } from '@/encryption/base64';

export type CodelyncPairingCode = { url: string; origin: string; invite: string; key: string; expires: number; version?: number; channels?: PeerChannel[] };
export type PairingDeviceKey = { publicKey: string; secretKey: string; name?: string };
export type PendingCodelyncPairing = { url: string; device: PairingDeviceKey };
export type PairingCredentials = { token: string; secret: string; serverUrl: string; peer?: PeerCredentials };
export type PairingPacket = { publicKey: string; nonce: string; ciphertext: string };
export class CodelyncPairingError extends Error {
    constructor(public code: 'invalid' | 'expired' | 'storage' | 'busy' | 'network' | 'identity' | 'used' | 'location', message: string) { super(message); }
}

const KEY = /^[A-Za-z0-9_-]{43}$/;
export function safeNormalizeOrigin(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try { return normalizeServerOrigin(value); } catch { return null; }
}
function canonicalPairingUrl(value: string): string {
    const trimmed = value.trim();
    try {
        const url = new URL(trimmed);
        if (url.protocol !== 'codelync:' || url.hostname !== 'pair') return trimmed;
        url.searchParams.sort();
        return url.toString();
    } catch { return trimmed; }
}
export function parseCodelyncPairingCode(rawValue: string, now = Date.now()): CodelyncPairingCode {
    const value = rawValue.trim();
    if (value.length > 4096) throw new CodelyncPairingError('invalid', 'The QR payload is too large.');
    let url: URL;
    try { url = new URL(value); } catch { throw new CodelyncPairingError('invalid', 'The QR is invalid.'); }
    const fields = [...url.searchParams.keys()];
    const version = Number(url.searchParams.get('v'));
    if (url.protocol !== 'codelync:' || url.hostname !== 'pair' || url.port || url.username || url.password || url.pathname || url.hash ||
        fields.sort().join(',') !== (version === 2 ? 'channels,expires,invite,key,origin,v' : 'expires,invite,key,origin,v') || ![1, 2].includes(version)) {
        throw new CodelyncPairingError('invalid', 'The QR format is unsupported.');
    }
    const origin = normalizeServerOrigin(url.searchParams.get('origin') ?? '');
    const target = new URL(origin), local = target.hostname === 'localhost' || target.hostname === '127.0.0.1' || target.hostname === '[::1]' ||
        /^10\.\d+\.\d+\.\d+$/.test(target.hostname) || /^192\.168\.\d+\.\d+$/.test(target.hostname) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(target.hostname);
    if (target.protocol !== 'https:' && !local) throw new CodelyncPairingError('invalid', 'A public Mac connection requires HTTPS.');
    const invite = url.searchParams.get('invite') ?? '', key = url.searchParams.get('key') ?? '', expires = Number(url.searchParams.get('expires'));
    if (!KEY.test(invite) || !KEY.test(key) || !Number.isSafeInteger(expires)) throw new CodelyncPairingError('invalid', 'The QR keys are invalid.');
    if (expires <= now) throw new CodelyncPairingError('expired', 'The QR has expired.');
    let channels: PeerChannel[] | undefined;
    if (version === 2) {
        try { channels = channelList(JSON.parse(new TextDecoder().decode(decodeBase64(url.searchParams.get('channels') ?? '', 'base64url')))); }
        catch { throw new CodelyncPairingError('invalid', 'Invalid Mac connection channels'); }
        if (!channels.some(channel => channel.url === origin)) throw new CodelyncPairingError('invalid', 'The primary channel is missing');
    }
    return { url: value, origin, invite, key, expires, version, channels };
}

export function validateCodelyncPairingCredentials(value: unknown, code: CodelyncPairingCode): PairingCredentials {
    const data = value as { version?: number; origin?: string; macKey?: string; credentials?: PairingCredentials; peer?: { id:string; key:string; channels:PeerChannel[] } };
    const credentials = data?.credentials;
    if (!credentials || typeof credentials.token !== 'string' || !credentials.token.trim() || !KEY.test(credentials.secret)) throw new CodelyncPairingError('identity', 'Invalid Mac credentials');
    const dataOrigin = safeNormalizeOrigin(data?.origin), serverUrl = safeNormalizeOrigin(credentials.serverUrl);
    let sameOrigin = false;
    if (code.version === 2) {
        let peerChannels: PeerChannel[] | null = null;
        try { peerChannels = channelList(data?.peer?.channels); } catch { peerChannels = null; }
        sameOrigin = data?.peer?.key === code.key && /^[a-f0-9]{64}$/.test(data?.peer?.id ?? '') && peerChannels !== null
            && peerChannels.some(channel => channel.url === code.origin)
            && dataOrigin !== null && serverUrl === dataOrigin && peerChannels.some(channel => channel.url === dataOrigin);
    } else {
        sameOrigin = dataOrigin === code.origin && serverUrl === code.origin;
    }
    if (data?.version !== (code.version ?? 1) || !sameOrigin || data.macKey !== code.key) {
        throw new CodelyncPairingError('identity', 'The pairing response does not match this Mac.');
    }
    return { ...credentials, serverUrl: code.origin };
}

function mapPairingExchangeError(error: unknown, fallbackMessage: string): CodelyncPairingError {
    if (error instanceof CodelyncPairingError) return error;
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 410) return new CodelyncPairingError('expired', 'The pairing invitation expired.');
    if (status === 409) return new CodelyncPairingError('used', 'The pairing invitation was used by another device.');
    return new CodelyncPairingError('network', fallbackMessage);
}

export class CodelyncPairingController {
    private flight: { key: string; promise: Promise<void> } | null = null;
    constructor(private readonly dependencies: {
        load: () => Promise<PendingCodelyncPairing | null>;
        save: (pending: PendingCodelyncPairing) => Promise<void>;
        clear: () => Promise<void>;
        generateKey: () => PairingDeviceKey | Promise<PairingDeviceKey>;
        encrypt: (code: CodelyncPairingCode, device: PairingDeviceKey) => PairingPacket;
        exchange: (origin: string, packet: PairingPacket) => Promise<unknown>;
        decrypt: (code: CodelyncPairingCode, device: PairingDeviceKey, reply: unknown) => unknown;
        currentOrigin: () => string;
        selectOrigin: (origin: string) => void;
        credentials: () => PairingCredentials | null;
        saveCredentials: (credentials: PairingCredentials) => Promise<void>;
        login: (credentials: PairingCredentials) => Promise<void>;
        reload: () => Promise<void>;
        now?: () => number;
        validatePeer?: (id:string,key:string,secret:string)=>Promise<boolean>;
        recoverPeerLocation?: (code: CodelyncPairingCode, owner: PairingCredentials) => Promise<void>;
    }) {}

    connect(rawUrl: string): Promise<void> {
        const url = rawUrl.trim(), key = canonicalPairingUrl(url);
        if (this.flight) return this.flight.key === key ? this.flight.promise : Promise.reject(new CodelyncPairingError('busy', 'Another Mac is being paired.'));
        const promise = this.perform(url).finally(() => { if (this.flight?.promise === promise) this.flight = null; });
        this.flight = { key, promise }; return promise;
    }
    async resume(): Promise<void> { const pending = await this.dependencies.load(); if (pending) await this.connect(pending.url); }
    private async perform(url: string) {
        const code = parseCodelyncPairingCode(url, this.dependencies.now?.());
        const owner = this.dependencies.credentials();
        if (code.version === 2 && owner?.peer?.key === code.key) {
            if (!this.dependencies.recoverPeerLocation) throw new CodelyncPairingError('location', 'The saved Mac location could not be verified.');
            try { await this.dependencies.recoverPeerLocation(code, owner); }
            catch { throw new CodelyncPairingError('location', 'The saved Mac location could not be verified.'); }
            return;
        }
        let pending = await this.dependencies.load();
        if (!pending || canonicalPairingUrl(pending.url) !== canonicalPairingUrl(url)) {
            pending = { url, device: await this.dependencies.generateKey() };
            // 手机私钥先进入安全存储，丢 ACK/重载后仍用同一设备身份兑换原邀请。
            try { await this.dependencies.save(pending); } catch { throw new CodelyncPairingError('storage', 'The pending scan could not be saved.'); }
        }
        if (code.version === 2) {
            const device = pending.device;
            const result = await Promise.any((code.channels ?? []).map(async channel => {
                const candidate = { ...code, origin: channel.url };
                const encrypted = this.dependencies.encrypt(candidate, device);
                let response: unknown;
                try {
                    response = await this.dependencies.exchange(channel.url, encrypted);
                } catch (error) {
                    throw mapPairingExchangeError(error, 'The Mac could not be reached.');
                }
                const decoded = this.dependencies.decrypt(candidate, device, response) as { peer: {id:string;key:string;channels:PeerChannel[]} };
                const credentials = validateCodelyncPairingCredentials(decoded, candidate);
                if (!this.dependencies.validatePeer || !await this.dependencies.validatePeer(decoded.peer.id, code.key, credentials.secret)) throw new CodelyncPairingError('identity', 'Wrong peer identity');
                return { ...credentials, peer: { ...decoded.peer, channels: channelList(decoded.peer.channels), device, automatic: true, selectedChannel: channel.id } };
            })).catch((err: unknown) => {
                const errors = err instanceof AggregateError ? err.errors : [err];
                for (const code of ['used', 'expired', 'identity', 'invalid'] as const) {
                    const matched = errors.find((item): item is CodelyncPairingError => item instanceof CodelyncPairingError && item.code === code);
                    if (matched) throw matched;
                }
                throw new CodelyncPairingError('network', 'No authenticated Mac channel could be reached');
            });
            // 通道候选只能在 Mac 密钥验证之后成为认证来源；一次扫码保存同一 peer 的设备私钥与地址集。
            await this.dependencies.saveCredentials(result); await this.dependencies.clear();
            this.dependencies.selectOrigin(result.serverUrl); await this.dependencies.reload(); return;
        }
        if (this.dependencies.currentOrigin() !== code.origin) {
            // 旧 sync runtime 不能在 await 后向新来源发送旧凭据；扫码保存后重载并自动续接。
            this.dependencies.selectOrigin(code.origin); await this.dependencies.reload(); return;
        }
        const packet = this.dependencies.encrypt(code, pending.device);
        let response: unknown;
        try { response = await this.dependencies.exchange(code.origin, packet); } catch (error) {
            throw mapPairingExchangeError(error, 'The Mac could not be reached.');
        }
        const credentials = validateCodelyncPairingCredentials(this.dependencies.decrypt(code, pending.device, response), code);
        const existing = this.dependencies.credentials();
        if (existing && (existing.secret !== credentials.secret || existing.serverUrl !== credentials.serverUrl)) {
            // 只在已验证 Mac 的密钥之后切换身份；现有初始化所有者通过重载退出。
            await this.dependencies.saveCredentials(credentials); await this.dependencies.clear(); await this.dependencies.reload(); return;
        }
        if (!existing) await this.dependencies.login(credentials);
        await this.dependencies.clear();
    }
}
