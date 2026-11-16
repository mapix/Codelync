import { expect, it } from 'vitest';
import type { Session } from '../sync/storageTypes';
import { captureNativeDispatchContext, matchesNativeDispatchContext } from './nativeDispatchContext';
const session = () => ({ metadata: { machineId: 'mac', client: { id: 'noninvasive-bridge' }, bridge: { controlMode: 'session', sourceStatus: 'connected', source: { app: 'codex', id: 'native-child', hostId: 'local', kind: 'session', runtimeGeneration: 'owner' } } } }) as Session;
it('captures only bounded immutable native identity and rejects owner/source changes', () => {
    const before = session(), context = captureNativeDispatchContext(before)!;
    expect(context).toEqual({ version: 1, app: 'codex', nativeConversationId: 'native-child', hostId: 'local', machineId: 'mac', ownerGeneration: 'owner' });
    expect(matchesNativeDispatchContext(before, context)).toBe(true);
    for (const change of [
        (s: Session) => { s.metadata!.bridge!.source.runtimeGeneration = 'new-owner'; },
        (s: Session) => { s.metadata!.bridge!.source.hostId = 'other-host'; },
        (s: Session) => { s.metadata!.bridge!.source.id = 'other-child'; },
        (s: Session) => { s.metadata!.machineId = 'other-mac'; },
        (s: Session) => { s.metadata!.bridge!.sourceStatus = 'disconnected'; },
    ]) { const after = session(); change(after); expect(matchesNativeDispatchContext(after, context)).toBe(false); }
    expect(context.ownerGeneration).toBe('owner');
});
it('does not fabricate dispatch identity for unknown owners or oversized fields', () => {
    const unknown = session(); unknown.metadata!.bridge!.source.runtimeGeneration = null;
    expect(captureNativeDispatchContext(unknown)).toBe(null);
    const large = session(); large.metadata!.bridge!.source.id = 'x'.repeat(513);
    expect(captureNativeDispatchContext(large)).toBe(null);
});

it('retains exact Claude native protocol/collection and rejects collection changes even with a reused host/id', () => {
    const current = session(); Object.assign(current.metadata!.bridge!.source, { app: 'claude-desktop', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
        protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions' });
    const context = captureNativeDispatchContext(current)!;
    expect(context).toMatchObject({ app: 'claude-desktop', protocol: 'claude-desktop-native', nativeCollection: 'claude-code-sessions' });
    Object.assign(current.metadata!.bridge!.source, { appMode: 'chat', nativeCollection: 'local-agent-mode-sessions' });
    expect(matchesNativeDispatchContext(current, context)).toBe(false);
});
