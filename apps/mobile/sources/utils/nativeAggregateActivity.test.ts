import { expect, it } from 'vitest';
import { currentNativeAggregate } from './nativeAggregateActivity';
import type { Session } from '@/sync/storageTypes';

const aggregate = { version: 1 as const, app: 'codex' as const, parentConversationId: 'parent', hostId: 'local', ownerGeneration: 'owner', ownStatus: 'idle', ownKnown: true,
    status: 'waiting' as const, known: true, active: true, waiting: true, rosterAvailable: true, rosterComplete: true, childCount: 1, unknownChildren: 0, digest: 'a'.repeat(64) };
const session = () => ({ id: 'relay-parent', metadata: { client: { id: 'noninvasive-bridge' }, bridge: { controlMode: 'session', source: { app: 'codex', kind: 'session', id: 'parent', hostId: 'local', runtimeGeneration: 'owner' }, sourceStatus: 'connected' } }, agentState: { aggregateActivity: aggregate } } as Session);
it('uses the current native parent aggregate without providing a child turn target', () => {
    const value = currentNativeAggregate(session()); expect(value?.status).toBe('waiting'); expect(value?.ownStatus).toBe('idle'); expect(value).not.toHaveProperty('currentTurnId');
});
it('accepts Claude attention only for exact original native protocol, collection and current owner', () => {
    const value = session(), source = value.metadata!.bridge!.source;
    Object.assign(source, { app: 'claude-desktop', protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions', hostId: 'local:claude-desktop:' + 'a'.repeat(64) });
    value.agentState!.aggregateActivity = { ...aggregate, app: 'claude-desktop', hostId: source.hostId };
    expect(currentNativeAggregate(value)?.status).toBe('waiting');
    source.nativeCollection = 'local-agent-mode-sessions'; expect(currentNativeAggregate(value)).toBeNull();
    source.nativeCollection = 'claude-code-sessions'; source.protocol = 'window'; expect(currentNativeAggregate(value)).toBeNull();
    source.protocol = 'claude-desktop-native'; source.runtimeGeneration = null; expect(currentNativeAggregate(value)).toBeNull();
});
it('does not accept a legacy/window aggregate or two null owner generations as current native proof', () => {
    const value = session(); value.metadata!.bridge!.controlMode = 'window'; expect(currentNativeAggregate(value)).toBeNull();
    value.metadata!.bridge!.controlMode = 'session'; value.metadata!.bridge!.source.runtimeGeneration = null;
    value.agentState!.aggregateActivity = { ...aggregate, ownerGeneration: null }; expect(currentNativeAggregate(value)).toBeNull();
});
it('rejects stale owner, foreign parent or disconnected aggregate', () => {
    const value = session(); value.metadata!.bridge!.source.runtimeGeneration = 'new-owner'; expect(currentNativeAggregate(value)).toBeNull();
    value.metadata!.bridge!.source.runtimeGeneration = 'owner'; value.metadata!.bridge!.source.id = 'other'; expect(currentNativeAggregate(value)).toBeNull();
    value.metadata!.bridge!.source.id = 'parent'; value.metadata!.bridge!.sourceStatus = 'disconnected'; expect(currentNativeAggregate(value)).toBeNull();
});
