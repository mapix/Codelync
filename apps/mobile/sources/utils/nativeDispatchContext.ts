import { z } from 'zod';
import type { Session } from '../sync/storageTypes';
import { isCodeLightSessionSource } from './codeLightSourceScope';

export const NativeDispatchContextSchema = z.object({
    version: z.literal(1), app: z.enum(['codex', 'antigravity', 'claude-desktop']), nativeConversationId: z.string().min(1).max(512),
    hostId: z.string().min(1).max(256), machineId: z.string().min(1).max(256), ownerGeneration: z.string().min(1).max(2048),
    protocol: z.string().optional(), nativeCollection: z.enum(['claude-code-sessions', 'local-agent-mode-sessions']).optional(),
});
export type NativeDispatchContext = z.infer<typeof NativeDispatchContextSchema>;

/** Immutable identity only; no prompt, answer, credentials or model arguments. */
export function captureNativeDispatchContext(session: Pick<Session, 'metadata'> | null | undefined): NativeDispatchContext | null {
    const metadata = session?.metadata, bridge = metadata?.bridge, source = bridge?.source;
    if (metadata?.client?.id !== 'noninvasive-bridge' || bridge?.controlMode !== 'session' || bridge.sourceStatus !== 'connected'
        || !isCodeLightSessionSource(source, bridge.controlMode)) return null;
    const parsed = NativeDispatchContextSchema.safeParse({ version: 1, app: source?.app, nativeConversationId: source?.id,
        hostId: source?.hostId, machineId: metadata.machineId, ownerGeneration: source?.runtimeGeneration,
        ...(source?.app === 'claude-desktop' ? { protocol: source.protocol, nativeCollection: source.nativeCollection } : {}) });
    return parsed.success ? parsed.data : null;
}
export function matchesNativeDispatchContext(session: Pick<Session, 'metadata'> | null | undefined, context: NativeDispatchContext): boolean {
    const current = captureNativeDispatchContext(session);
    return !!current && current.app === context.app && current.nativeConversationId === context.nativeConversationId
        && current.hostId === context.hostId && current.machineId === context.machineId && current.ownerGeneration === context.ownerGeneration
        && current.protocol === context.protocol && current.nativeCollection === context.nativeCollection;
}
