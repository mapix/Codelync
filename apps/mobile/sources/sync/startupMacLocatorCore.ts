import type { AuthCredentials } from '@/auth/tokenStorage';
import { channelOrigin } from '@slopus/happy-wire/codelight';
export const STARTUP_MAC_LOCATOR_MAX_BYTES = 8192;
export const STARTUP_MAC_LOCATOR_MAX_AGE_MS = 5 * 60 * 1000;
export type StartupMacLocatorOptions = { eligible: boolean; now(): number; read(): Promise<string | null>; remove(): Promise<void>;
    credentials(): Promise<AuthCredentials | null>; bootstrap(origins: string[], expectedPeerId: string): Promise<void> };
export function sameLocatorOwner(a: AuthCredentials, b: AuthCredentials | null) {
    return !!a.peer?.device && !!b?.peer?.device && a.peer.id === b.peer.id && a.token === b.token && a.secret === b.secret
        && a.peer.key === b.peer.key && a.peer.device.publicKey === b.peer.device.publicKey && a.peer.device.secretKey === b.peer.device.secretKey;
}
/** Optional startup hint. The pinned Mac response remains the authority. */
export async function consumeStartupMacLocator(options: StartupMacLocatorOptions): Promise<boolean> {
    if (!options.eligible) return false;
    try {
        const owner = await options.credentials(); if (!owner?.peer) return false;
        const text = await options.read(); if (!text || new TextEncoder().encode(text).length > STARTUP_MAC_LOCATOR_MAX_BYTES) return false;
        const value = JSON.parse(text) as { version?: unknown; peerId?: unknown; origins?: unknown; expiresAt?: unknown };
        const now = options.now();
        if (!value || value.version !== 1 || value.peerId !== owner.peer.id || !Number.isSafeInteger(value.expiresAt)
            || typeof value.expiresAt !== 'number' || value.expiresAt <= now || value.expiresAt > now + STARTUP_MAC_LOCATOR_MAX_AGE_MS
            || !Array.isArray(value.origins) || !value.origins.length || value.origins.length > 8
            || !value.origins.every(origin => {
                if (typeof origin !== 'string' || !origin || origin.length >= 512) return false;
                try { channelOrigin(origin, origin.startsWith('http:') ? 'local' : 'cloudflare'); return true; } catch { return false; }
            }) || !sameLocatorOwner(owner, await options.credentials())) return false;
        await options.bootstrap(value.origins as string[], owner.peer.id);
        if (!sameLocatorOwner(owner, await options.credentials())) return false;
        await options.remove(); return true;
    } catch { return false; }
}
