import { parseCodelyncPairingCode, safeNormalizeOrigin, type PairingCredentials } from './codelyncPairing';
type RouteCredentials = Pick<PairingCredentials, 'peer'> & { serverUrl?: string };

/** A connected trusted peer has already completed this passive deep-link route. */
export function isCodelyncPairingRouteComplete(url: string, credentials: RouteCredentials | null, socketStatus: string, peerIdentity: string | null): boolean {
    const peer = credentials?.peer;
    if (!peer || socketStatus !== 'connected' || peerIdentity !== 'peer:' + peer.id || !/^[a-f0-9]{64}$/.test(peer.id)) return false;
    const serverUrl = safeNormalizeOrigin(credentials?.serverUrl);
    if (!serverUrl || !Array.isArray(peer.channels)) return false;
    try {
        // Expiry still blocks exchange. Here no key, channel or credential changes.
        const code = parseCodelyncPairingCode(url, 0);
        return code.version === 2 && peer.key === code.key
            && peer.channels.some(channel => safeNormalizeOrigin(channel?.url) === code.origin)
            && peer.channels.some(channel => safeNormalizeOrigin(channel?.url) === serverUrl);
    } catch { return false; }
}
