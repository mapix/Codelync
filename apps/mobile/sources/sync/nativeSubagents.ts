import { z } from 'zod';

export const NativeSubagentStatusSchema = z.enum(['pending', 'running', 'waiting', 'idle', 'stopped', 'completed', 'failed', 'unknown']);
export const NativeSubagentSchema = z.object({
    id: z.string().min(1).max(512),
    name: z.string().min(1).max(256),
    app: z.enum(['codex', 'antigravity', 'claude-desktop']),
    nativeConversationId: z.string().min(1).max(512),
    parentConversationId: z.string().min(1).max(512),
    nativeParentConversationId: z.string().min(1).max(512).regex(/^[^\x00-\x1f]+$/).optional(),
    depth: z.number().int().min(1).max(128).optional(),
    hostId: z.string().min(1).max(256),
    ownerGeneration: z.string().min(1).max(2048),
    relationship: z.literal('native-subagent'),
    status: NativeSubagentStatusSchema,
    statusSource: z.string().max(64).optional(),
    nativeCollection: z.enum(['claude-code-sessions', 'local-agent-mode-sessions']).optional(),
    parentNativeCollection: z.enum(['claude-code-sessions', 'local-agent-mode-sessions']).optional(),
    parentHostId: z.string().min(1).max(256).optional(),
    parentOwnerGeneration: z.string().min(1).max(2048).optional(),
    runtimeGeneration: z.string().min(1).max(2048).optional(),
}).refine(value => value.app !== 'claude-desktop' || !!value.nativeCollection && !!value.parentNativeCollection
    && !!value.parentHostId && !!value.parentOwnerGeneration && !!value.runtimeGeneration, {
    message: 'Claude dispatch children require their own collection and exact parent scope',
}).refine(value => value.nativeParentConversationId === undefined && value.depth === undefined
    || value.app === 'antigravity' && value.nativeParentConversationId !== undefined && value.depth !== undefined
        && value.nativeParentConversationId !== value.nativeConversationId
        && (value.depth === 1) === (value.nativeParentConversationId === value.parentConversationId), {
    message: 'Native descendant ancestry requires a matching parent and depth pair',
});
export type NativeSubagent = z.infer<typeof NativeSubagentSchema>;
export type NativeSubagentStatus = z.infer<typeof NativeSubagentStatusSchema>;

export const NativeAggregateActivitySchema = z.object({
    version: z.literal(1), app: z.enum(['codex', 'antigravity', 'claude-desktop']), parentConversationId: z.string().min(1).max(512),
    hostId: z.string().min(1).max(256), ownerGeneration: z.string().min(1).max(2048).nullable(),
    ownStatus: z.string().min(1).max(128), ownKnown: z.boolean(), status: NativeSubagentStatusSchema,
    known: z.boolean(), active: z.boolean(), waiting: z.boolean(), rosterAvailable: z.boolean(), rosterComplete: z.boolean(),
    childCount: z.number().int().nonnegative().max(20000), unknownChildren: z.number().int().nonnegative().max(20000),
    taskCount: z.number().int().nonnegative().max(128).optional(), unknownTasks: z.number().int().nonnegative().max(128).optional(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type NativeAggregateActivity = z.infer<typeof NativeAggregateActivitySchema>;
