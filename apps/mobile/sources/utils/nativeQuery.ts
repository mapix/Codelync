import { z } from 'zod';
import type { Metadata, Session } from '@/sync/storageTypes';
import { isCodeLightSessionSource } from './codeLightSourceScope';

export const NativeQuerySchema = z.object({
    version: z.literal(1), app: z.literal('claude-desktop'), nativeConversationId: z.string().min(1).max(512),
    hostId: z.string().min(1).max(256), ownerGeneration: z.string().min(1).max(2048),
    queryToken: z.string().min(1).max(512).refine(value => !!value.trim()).nullable(), status: z.enum(['idle', 'running', 'waiting']),
    canSend: z.boolean(), activeSendMode: z.enum(['queue', 'unverified']), canCancel: z.boolean(),
}).refine(value => !value.canCancel || value.queryToken !== null && value.status !== 'idle');
export type NativeQuery = z.infer<typeof NativeQuerySchema>;

/** Query identity is separate from a native turn and belongs to one current owner. */
export function readNativeQuery(metadata: Metadata | null | undefined, value: unknown): NativeQuery | null {
    const source = metadata?.bridge?.source, bridge = metadata?.bridge;
    const parsed = NativeQuerySchema.safeParse(value);
    if (!parsed.success || metadata?.client?.id !== 'noninvasive-bridge' || metadata.nativeSession?.catalogueAvailable === false || source?.app !== 'claude-desktop'
        || bridge?.sourceStatus !== 'connected' || bridge.currentTurnId !== null || !isCodeLightSessionSource(source, bridge.controlMode)
        || parsed.data.nativeConversationId !== source.id || parsed.data.hostId !== source.hostId
        || parsed.data.ownerGeneration !== source.runtimeGeneration) return null;
    return parsed.data;
}

export function nativeQueryCanSend(metadata: Metadata | null | undefined, value: unknown): boolean {
    const query = readNativeQuery(metadata, value), mode = metadata?.bridge?.source.appMode;
    if (!query || metadata?.nativeSession?.isSubagent === true || metadata?.capabilities?.send !== true
        || !query.canSend || mode !== 'code' && mode !== 'chat') return false;
    return query.status === 'idle' || mode === 'code' && query.activeSendMode === 'queue';
}

export function nativeQueryCanCancel(metadata: Metadata | null | undefined, value: unknown): boolean {
    const query = readNativeQuery(metadata, value), mode = metadata?.bridge?.source.appMode;
    return !!query && metadata?.nativeSession?.isSubagent !== true && (mode === 'code' || mode === 'chat')
        && query.canCancel && query.queryToken !== null && query.status !== 'idle'
        && metadata?.capabilities?.abort === true && metadata.capabilities.rpcMethods?.includes('abort') === true;
}

export function prepareNativeQueryCancel(session: Pick<Session, 'metadata' | 'agentState'> | null | undefined, expected?: NativeQuery | null): { queryToken: string } | null {
    const current = readNativeQuery(session?.metadata, session?.agentState?.nativeQuery);
    if (!current || !nativeQueryCanCancel(session?.metadata, current) || current.queryToken === null) return null;
    if (expected && (expected.app !== current.app || expected.nativeConversationId !== current.nativeConversationId
        || expected.hostId !== current.hostId || expected.ownerGeneration !== current.ownerGeneration || expected.queryToken !== current.queryToken)) return null;
    return { queryToken: current.queryToken };
}
