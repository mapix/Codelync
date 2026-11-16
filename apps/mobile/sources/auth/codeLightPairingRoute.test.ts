import { expect, it } from 'vitest';
import { encodeBase64 } from '../encryption/base64';
import type { PairingCredentials } from './codeLightPairing';
import { isCodeLightPairingRouteComplete } from './codeLightPairingRoute';

const origin = 'http://127.0.0.1:57070', key = 'b'.repeat(43), peerId = 'a'.repeat(64);
const channels = [{ id: 'lan', kind: 'local' as const, url: origin, order: 0 }];
const credentials = { token: 'fixture-token', secret: 'c'.repeat(43), serverUrl: origin,
    peer: { id: peerId, key, channels, device: { publicKey: 'd'.repeat(43), secretKey: 'e'.repeat(43) }, automatic: true } } as PairingCredentials;
function url() {
    const value = new URL('codelight://pair');
    for (const [field, text] of Object.entries({ v: '2', origin, key, invite: 'f'.repeat(43), expires: '1000',
        channels: encodeBase64(new TextEncoder().encode(JSON.stringify(channels)), 'base64url') })) value.searchParams.set(field, text);
    return value.toString();
}

it('finishes a consumed expired invitation route only for its currently connected trusted peer', () => {
    expect(isCodeLightPairingRouteComplete(url(), credentials, 'connected', 'peer:' + peerId)).toBe(true);
    expect(isCodeLightPairingRouteComplete(url(), credentials, 'connecting', 'peer:' + peerId)).toBe(false);
    expect(isCodeLightPairingRouteComplete(url(), credentials, 'disconnected', 'peer:' + peerId)).toBe(false);
    expect(isCodeLightPairingRouteComplete(url(), credentials, 'connected', 'peer:' + 'd'.repeat(64))).toBe(false);
    expect(isCodeLightPairingRouteComplete(url(), null, 'connected', 'peer:' + peerId)).toBe(false);
});

it('never skips exchange for a different Mac key or an untrusted route/selected origin', () => {
    const other = new URL(url()); other.searchParams.set('key', 'x'.repeat(43));
    expect(isCodeLightPairingRouteComplete(other.toString(), credentials, 'connected', 'peer:' + peerId)).toBe(false);
    expect(isCodeLightPairingRouteComplete(url(), { ...credentials, serverUrl: 'https://different.example' }, 'connected', 'peer:' + peerId)).toBe(false);
    const different = { ...credentials, peer: { ...credentials.peer!, channels: [{ ...channels[0], url: 'http://127.0.0.1:58080' }] } };
    expect(isCodeLightPairingRouteComplete(url(), different, 'connected', 'peer:' + peerId)).toBe(false);
    const extra = new URL(url()); extra.searchParams.set('unknown', '1');
    expect(isCodeLightPairingRouteComplete(extra.toString(), credentials, 'connected', 'peer:' + peerId)).toBe(false);
});
