import { z } from 'zod';
import type { Session } from '@/sync/storageTypes';
import { isCodeLightSessionSource } from './codeLightSourceScope';

export const NativeObservedModelSchema = z.object({
    version: z.literal(1), app: z.literal('claude-desktop'), nativeConversationId: z.string().min(1).max(512),
    hostId: z.string().min(1).max(256), ownerGeneration: z.string().min(1).max(2048), readOnly: z.literal(true),
    model: z.string().min(1).max(512).refine(value => !!value.trim()).nullable(),
    effort: z.string().min(1).max(128).refine(value => !!value.trim()).nullable(),
});

export function readNativeObservedModel(session: Pick<Session, 'metadata'> | null | undefined) {
    const metadata = session?.metadata, bridge = metadata?.bridge, source = bridge?.source;
    const parsed = NativeObservedModelSchema.safeParse(metadata?.nativeObservedModel);
    if (!parsed.success || metadata?.client?.id !== 'noninvasive-bridge' || source?.app !== 'claude-desktop'
        || bridge?.sourceStatus !== 'connected' || bridge.currentTurnId !== null || !isCodeLightSessionSource(source, bridge.controlMode)
        || parsed.data.nativeConversationId !== source.id || parsed.data.hostId !== source.hostId || parsed.data.ownerGeneration !== source.runtimeGeneration) return null;
    return parsed.data;
}
