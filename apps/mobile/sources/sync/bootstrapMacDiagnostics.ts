import { channelList } from '@codelync/wire/codelync';
import { TokenStorage } from '@/auth/tokenStorage';
import { recoverCodelyncConnection, probeCodelyncChannel, readCodelyncChannelManifest } from './codelyncConnection';
import { sameLocatorOwner } from './startupMacLocatorCore';

/** Private USB diagnosis supplies locators only. The existing pinned Mac key remains the authority. */
export async function bootstrapMacDiagnostics(urls: unknown, options: { expectedPeerId?: string } = {}): Promise<void> {
    if (!Array.isArray(urls) || !urls.length || urls.length > 8 || !urls.every(url => typeof url === 'string' && url.length < 512)) throw Error('Invalid diagnostic locators');
    const credentials = await TokenStorage.getCredentials();
    if (!credentials?.peer) throw Error('An existing Mac pairing is required');
    if (options.expectedPeerId && credentials.peer.id !== options.expectedPeerId) throw Error('The saved Mac changed');
    const peer = credentials.peer;
    const candidates = channelList(urls.map((url, index) => ({ id: `usb-locator-${index}`, kind: url.startsWith('http:') ? 'local' : 'cloudflare', url, label: 'Mac diagnostic locator' })));
    const temporary = { ...peer, channels: candidates };
    const value = { ...credentials, peer: temporary }, abort = new AbortController();
    let verified;
    try {
        const proof = await Promise.any(candidates.map(channel => probeCodelyncChannel(channel, value, abort.signal)));
        verified = await readCodelyncChannelManifest(proof, value, abort.signal);
    } finally { abort.abort(); }
    if (!sameLocatorOwner(credentials, await TokenStorage.getCredentials())) throw Error('The saved Mac changed');
    // Locator proof refreshes candidates; the selection owner retains manual intent.
    await recoverCodelyncConnection(verified, credentials);
}
