import { channelList } from '@slopus/happy-wire/codelight';
import { TokenStorage } from '@/auth/tokenStorage';
import { peerAuthorization, decodePeerResponse } from './peerNetwork';
import { initializeCodeLightConnection, selectConnection } from './codeLightConnection';
import { abortBudget } from './abortBudget';
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
    const verified = await Promise.any(candidates.map(async channel => {
        const deadline = abortBudget(undefined, channel.kind === 'local' ? 2500 : 7000), url = channel.url + '/api/peer/channels';
        try {
            const response = await fetch(url, { headers: { Authorization: peerAuthorization(credentials.token, temporary, channel.url, 'GET', url) }, signal: deadline.signal });
            if (!response.ok) throw Error('The locator is unavailable');
            const payload = decodePeerResponse(peer, await response.json()) as { channels: unknown };
            const channels = channelList(payload.channels);
            if (!channels.some(current => current.url === channel.url)) throw Error('This Mac has disabled the locator');
            return channels;
        } finally { deadline.dispose(); }
    }));
    if (!sameLocatorOwner(credentials, await TokenStorage.getCredentials())) throw Error('The saved Mac changed');
    // 先认证原 peer，再复用唯一选路 owner；失败不改写原凭据或未知操作。
    initializeCodeLightConnection({ ...credentials, peer: { ...peer, channels: verified } });
    try { await selectConnection('auto'); }
    catch (error) { const current = await TokenStorage.getCredentials(); if (sameLocatorOwner(credentials, current)) initializeCodeLightConnection(current!); throw error; }
}
