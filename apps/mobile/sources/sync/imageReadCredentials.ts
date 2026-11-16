import { TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';

/** The connection owner saves authenticated channels; Sync retains its original account snapshot. */
export async function currentImageReadCredentials(expected: AuthCredentials): Promise<AuthCredentials> {
    const current = await TokenStorage.getCredentials();
    if (!current || current.secret !== expected.secret) throw Error('The image account changed');
    if (expected.peer || current.peer) {
        if (!expected.peer || !current.peer || expected.peer.id !== current.peer.id || expected.peer.device.publicKey !== current.peer.device.publicKey) throw Error('The image peer changed');
    } else if (current.token !== expected.token || current.serverUrl !== expected.serverUrl) throw Error('The image connection changed');
    return current;
}
