import { z } from 'zod';
import { NativeSubagentStatusSchema } from './nativeSubagents';

const identity = z.string().min(1).max(512).refine(value => !!value.trim() && !/[\x00-\x1f\x7f]|Bearer\s/i.test(value));
const generation = z.string().min(1).max(2048).refine(value => !!value.trim() && !/[\x00-\x1f\x7f]|Bearer\s/i.test(value));
export const NativeTaskScopeSchema = z.object({
    app: z.literal('claude-desktop'), nativeCollection: z.enum(['claude-code-sessions', 'local-agent-mode-sessions']),
    hostId: identity.max(256), parentConversationId: identity, ownerGeneration: generation, runtimeGeneration: generation,
    queryToken: identity.nullable(), cliSessionId: identity.nullable(),
});
export type NativeTaskScope = z.infer<typeof NativeTaskScopeSchema>;
export const NativeTaskStatusSchema = z.enum(['pending', 'running', 'paused', 'completed', 'failed', 'stopped', 'unknown']);
export const NativeTaskKindSchema = z.enum(['agent', 'shell', 'workflow', 'remote-agent', 'other']);
export const NativeTaskSchema = z.object({
    nativeTaskId: identity.max(256), name: identity.max(160), taskType: identity.max(64), kind: NativeTaskKindSchema,
    status: NativeTaskStatusSchema, isBackgrounded: z.boolean().nullable(), statusSource: identity.max(64),
    observedEventAt: identity.max(80).nullable().optional(), agentId: identity.max(256).nullable().optional(),
});
export type NativeTask = z.infer<typeof NativeTaskSchema>;
export const NativeTaskDispatchSchema = z.object({
    nativeConversationId: identity, name: identity.max(160), nativeCollection: z.enum(['claude-code-sessions', 'local-agent-mode-sessions']),
    hostId: identity.max(256), ownerGeneration: generation, status: NativeSubagentStatusSchema, statusSource: identity.max(64),
});
export const NativeTasksSchema = z.object({
    version: z.literal(1), scope: NativeTaskScopeSchema, tasks: z.array(NativeTaskSchema).max(128),
    tasksAvailable: z.boolean(), tasksComplete: z.boolean(), backgroundTasksComplete: z.boolean(), tasksTruncated: z.boolean(),
    dispatchChildren: z.array(NativeTaskDispatchSchema).max(128), dispatchChildrenAvailable: z.boolean(),
    dispatchChildrenComplete: z.boolean(), dispatchChildrenTruncated: z.boolean(), partial: z.boolean(),
    digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type NativeTasks = z.infer<typeof NativeTasksSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const taskFlags = {
    tasksAvailable: z.boolean(), tasksComplete: z.boolean(), backgroundTasksComplete: z.boolean(), tasksTruncated: z.boolean(),
    dispatchChildrenAvailable: z.boolean(), dispatchChildrenComplete: z.boolean(), dispatchChildrenTruncated: z.boolean(), partial: z.boolean(),
    taskCount: z.number().int().min(0).max(128), dispatchChildCount: z.number().int().min(0).max(128),
};
export const NativeTaskSignalSchema = z.object({ version: z.literal(1), scope: NativeTaskScopeSchema, digest, ...taskFlags }).strict();
export type NativeTaskSignal = z.infer<typeof NativeTaskSignalSchema>;
const dispatchKey = z.string().min(1).max(1024).refine(value => !/[\x00-\x1f\x7f]|Bearer\s/i.test(value));
export const NativeTaskDeltaSchema = z.object({
    kind: z.literal('native-task-delta'), version: z.literal(1), scope: NativeTaskScopeSchema, baseDigest: digest, digest, ...taskFlags,
    taskUpserts: z.array(NativeTaskSchema).max(128), taskRemovedIds: z.array(identity.max(256)).max(128),
    dispatchUpserts: z.array(NativeTaskDispatchSchema).max(128), dispatchRemovedKeys: z.array(dispatchKey).max(128),
    taskOrder: z.array(identity.max(256)).max(128).optional(), dispatchOrder: z.array(dispatchKey).max(128).optional(),
});
export const NativeTaskUnchangedSchema = z.object({ kind: z.literal('native-task-unchanged'), version: z.literal(1), scope: NativeTaskScopeSchema, digest, ...taskFlags });
export const NativeTaskReadReplySchema = z.union([NativeTasksSchema.extend({ kind: z.undefined().optional() }), NativeTaskDeltaSchema, NativeTaskUnchangedSchema]);
export type NativeTaskReadReply = z.infer<typeof NativeTaskReadReplySchema>;

export const NativeTaskLogSchema = z.object({
    id: identity, identity: z.literal('local-log'), sequence: z.number().int().nonnegative(),
    nativeEventId: identity.nullable().default(null), nativeTaskId: identity.max(256), subtype: identity.max(64),
    taskType: identity.max(64), kind: NativeTaskKindSchema, status: NativeTaskStatusSchema,
    nativeStatus: identity.max(64).nullable(), isBackgrounded: z.boolean().nullable(), timestamp: identity.max(80).nullable().default(null),
});
export type NativeTaskLog = z.infer<typeof NativeTaskLogSchema>;
export const NativeTaskLogPageSchema = z.object({
    scope: NativeTaskScopeSchema, status: identity.max(64), available: z.boolean(), logs: z.array(NativeTaskLogSchema).max(100),
    hasMore: z.boolean().nullable(), nextCursor: identity.max(256).nullable(), truncated: z.boolean().optional(),
});
export type NativeTaskLogPage = z.infer<typeof NativeTaskLogPageSchema>;

export const NativeTaskOutputSchema = z.object({
    scope: NativeTaskScopeSchema, taskId: identity.max(256),
    output: z.string().refine(value => new TextEncoder().encode(value).byteLength <= 65536),
    truncated: z.boolean(),
}).strict();
export type NativeTaskOutput = z.infer<typeof NativeTaskOutputSchema>;
