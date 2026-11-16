import { describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { consumeStartupMacLocator, sameLocatorOwner, STARTUP_MAC_LOCATOR_MAX_BYTES, STARTUP_MAC_LOCATOR_MAX_AGE_MS } from './startupMacLocatorCore';

const owner: AuthCredentials = { token: 'fixture-token', secret: 'fixture-account', serverUrl: 'https://old.example',
    peer: { id: 'fixture-mac', key: 'fixture-mac-key', channels: [], device: { publicKey: 'fixture-device-public', secretKey: 'fixture-device-private' } } };
const now = 1_800_000_000_000;
const hint = () => ({ version: 1, peerId: owner.peer!.id, origins: ['http://10.0.0.2:8800', 'https://current.example/r/aaaaaaaaaaaaaaaaaaaaaaaa'], expiresAt: now + 1000 });
function fixture(overrides: Record<string, unknown> = {}) {
    return { eligible: true, now: () => now, credentials: vi.fn(async () => owner as AuthCredentials | null),
        read: vi.fn(async () => JSON.stringify(hint()) as string | null), remove: vi.fn(async () => {}), bootstrap: vi.fn(async () => {}), ...overrides };
}
describe('one-shot paired startup locator', () => {
    it('does no locator work when ineligible, absent or unpaired', async () => {
        const disabled = fixture({ eligible: false }); expect(await consumeStartupMacLocator(disabled)).toBe(false);
        expect(disabled.credentials).not.toHaveBeenCalled(); expect(disabled.read).not.toHaveBeenCalled();
        const unpaired = fixture({ credentials: vi.fn(async () => null) }); expect(await consumeStartupMacLocator(unpaired)).toBe(false);
        expect(unpaired.read).not.toHaveBeenCalled(); expect(unpaired.bootstrap).not.toHaveBeenCalled();
        const absent = fixture({ read: vi.fn(async () => null) }); expect(await consumeStartupMacLocator(absent)).toBe(false);
        expect(absent.read).toHaveBeenCalledOnce(); expect(absent.bootstrap).not.toHaveBeenCalled(); expect(absent.remove).not.toHaveBeenCalled();
    });
    it.each([
        { peerId: 'different-mac' }, { version: 2 }, { expiresAt: now }, { expiresAt: now + STARTUP_MAC_LOCATOR_MAX_AGE_MS + 1 },
        { expiresAt: 1.5 }, { origins: [] }, { origins: Array.from({ length: 9 }, () => 'https://current.example') },
        { origins: ['file:///tmp/file'] }, { origins: ['https://user:password@current.example'] },
        { origins: ['https://current.example?key=fixture'] }, { origins: ['https://current.example#fragment'] },
        { origins: ['https://current.example/api/peer'] }, { origins: [22] }, { origins: ['https://' + 'a'.repeat(512)] },
    ])('rejects malformed or foreign locator %j before probing', async invalid => {
        const options = fixture({ read: vi.fn(async () => JSON.stringify({ ...hint(), ...invalid })) });
        expect(await consumeStartupMacLocator(options)).toBe(false);
        expect(options.bootstrap).not.toHaveBeenCalled(); expect(options.remove).not.toHaveBeenCalled();
    });
    it.each(['{broken', 'null', ' '.repeat(STARTUP_MAC_LOCATOR_MAX_BYTES + 1), '汉'.repeat(STARTUP_MAC_LOCATOR_MAX_BYTES / 2)])('silently rejects invalid/oversized input', async text => {
        const options = fixture({ read: vi.fn(async () => text) });
        expect(await consumeStartupMacLocator(options)).toBe(false); expect(options.bootstrap).not.toHaveBeenCalled();
    });
    it('authenticates only the saved owner, removes once and never creates keys', async () => {
        const options = fixture(), before = JSON.stringify(owner);
        expect(await consumeStartupMacLocator(options)).toBe(true);
        expect(options.read).toHaveBeenCalledOnce(); expect(options.bootstrap).toHaveBeenCalledExactlyOnceWith(hint().origins, owner.peer!.id);
        expect(options.remove).toHaveBeenCalledOnce(); expect(JSON.stringify(owner)).toBe(before);
    });
    it('rejects an owner change during file reading before bootstrap', async () => {
        const options = fixture(); options.credentials.mockResolvedValueOnce(owner).mockResolvedValueOnce({ ...owner, token: 'new-account' });
        expect(await consumeStartupMacLocator(options)).toBe(false); expect(options.bootstrap).not.toHaveBeenCalled(); expect(options.remove).not.toHaveBeenCalled();
    });
    it('cannot remove the locator after an owner change during bootstrap', async () => {
        const options = fixture(); options.credentials.mockResolvedValueOnce(owner).mockResolvedValueOnce(owner).mockResolvedValueOnce({ ...owner, peer: { ...owner.peer!, key: 'new-mac-key' } });
        expect(await consumeStartupMacLocator(options)).toBe(false); expect(options.bootstrap).toHaveBeenCalledOnce(); expect(options.remove).not.toHaveBeenCalled();
    });
    it('retains the file and credentials when authenticated bootstrap fails', async () => {
        const options = fixture({ bootstrap: vi.fn(async () => { throw Error('private failure must remain private'); }) });
        expect(await consumeStartupMacLocator(options)).toBe(false); expect(options.remove).not.toHaveBeenCalled();
    });
    it('handles incomplete credentials without throwing or accepting a new authority', () => {
        expect(sameLocatorOwner(owner, null)).toBe(false);
        expect(sameLocatorOwner({ token: owner.token, secret: owner.secret }, owner)).toBe(false);
        expect(sameLocatorOwner(owner, { ...owner, peer: { ...owner.peer!, device: undefined } } as unknown as AuthCredentials)).toBe(false);
        for (const next of [{ ...owner, token: 'new' }, { ...owner, secret: 'new' }, { ...owner, peer: { ...owner.peer!, device: { ...owner.peer!.device, publicKey: 'new' } } }]) expect(sameLocatorOwner(owner, next)).toBe(false);
        expect(sameLocatorOwner(owner, { ...owner, serverUrl: 'https://new.example', peer: { ...owner.peer!, selectedChannel: 'new', channels: [] } })).toBe(true);
    });
});
