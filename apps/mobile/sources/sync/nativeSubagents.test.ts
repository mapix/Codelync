import { expect, it } from 'vitest';
import { NativeAggregateActivitySchema, NativeSubagentSchema } from './nativeSubagents';
import { AgentStateSchema } from './storageTypes';

const row = { id: 'child', name: 'worker', app: 'antigravity', nativeConversationId: 'child', parentConversationId: 'ancestor',
    hostId: 'host', ownerGeneration: 'owner', relationship: 'native-subagent', status: 'running' };

it('retains optional native ancestry without inferring missing intermediate display rows', () => {
    for (const [nativeParentConversationId, depth] of [['ancestor', 1], ['undisplayed-parent', 5], ['undisplayed-parent', 128]] as const) {
        const value = { ...row, nativeParentConversationId, depth };
        expect(NativeSubagentSchema.parse(value)).toMatchObject({ nativeParentConversationId, depth });
        expect(AgentStateSchema.parse({ subagents: [value] }).subagents?.[0]).toMatchObject({ nativeParentConversationId, depth });
    }
    expect(NativeSubagentSchema.parse(row)).not.toHaveProperty('depth');
});

it('rejects malformed ancestry pairs rather than creating a flat or self-parented child', () => {
    for (const ancestry of [{ depth: 1 }, { nativeParentConversationId: 'ancestor' }, { nativeParentConversationId: 'child', depth: 2 },
        { nativeParentConversationId: 'ancestor', depth: 2 }, { nativeParentConversationId: 'intermediate', depth: 1 },
        { nativeParentConversationId: 'intermediate', depth: 0 }, { nativeParentConversationId: 'intermediate', depth: 1.5 },
        { nativeParentConversationId: 'intermediate', depth: 129 }, { nativeParentConversationId: 'bad\u0000parent', depth: 2 }]) {
        expect(NativeSubagentSchema.safeParse({ ...row, ...ancestry }).success).toBe(false);
    }
    expect(NativeSubagentSchema.safeParse({ ...row, app: 'codex', nativeParentConversationId: 'ancestor', depth: 1 }).success).toBe(false);
});

it('keeps an unknown optional total distinct from a confirmed zero and bounds native tree counts', () => {
    expect(AgentStateSchema.parse({}).subagentsTotal).toBeUndefined();
    expect(AgentStateSchema.parse({ subagentsTotal: null }).subagentsTotal).toBeNull();
    for (const total of [0, 137, 20000]) expect(AgentStateSchema.parse({ subagentsTotal: total }).subagentsTotal).toBe(total);
    for (const total of [-1, 1.5, 20001, '137', NaN]) expect(AgentStateSchema.parse({ subagentsTotal: total }).subagentsTotal).toBeNull();
    const aggregate = { version: 1, app: 'antigravity', parentConversationId: 'ancestor', hostId: 'host', ownerGeneration: 'owner',
        ownStatus: 'idle', ownKnown: true, status: 'running', known: true, active: true, waiting: false,
        rosterAvailable: true, rosterComplete: true, childCount: 137, unknownChildren: 0, digest: 'a'.repeat(64) };
    expect(NativeAggregateActivitySchema.parse({ ...aggregate, childCount: 20000 }).childCount).toBe(20000);
    expect(NativeAggregateActivitySchema.safeParse({ ...aggregate, childCount: 20001 }).success).toBe(false);
    expect(AgentStateSchema.parse({ aggregateActivity: aggregate }).aggregateActivity?.childCount).toBe(137);
});
