import { parseCodeLightPairingCode, type PairingCredentials } from './codeLightPairing';
type RouteCredentials = Pick<PairingCredentials, 'peer'> & { serverUrl?: string };

/** A connected trusted peer has already completed this passive deep-link route. */
export function isCodeLightPairingRouteComplete(url: string, credentials: RouteCredentials | null, socketStatus: string, peerIdentity: string | null): boolean {
    const peer = credentials?.peer;
    if (!peer || socketStatus !== 'connected' || peerIdentity !== 'peer:' + peer.id || !/^[a-f0-9]{64}$/.test(peer.id)) return false;
    try {
        // Expiry still blocks exchange. Here no key, channel or credential changes.
        const code = parseCodeLightPairingCode(url, 0);
        return code.version === 2 && peer.key === code.key && peer.channels.some(channel => channel.url === code.origin)
            && peer.channels.some(channel => channel.url === credentials?.serverUrl);
    } catch { return false; }
}
