import { z } from 'zod';
import type { Session } from '@/sync/storageTypes';

export const NativeSavedHistorySchema = z.object({
    app: z.literal('codex'), version: z.literal(1), available: z.literal(true), readOnly: z.literal(true),
    originator: z.literal('Codex Desktop'), nativeId: z.string().min(1).max(512), hostId: z.literal('local'),
    namespaceHash: z.string().regex(/^[a-f0-9]{64}$/), sourceStamp: z.string().regex(/^[a-f0-9]{64}$/),
    parentNativeId: z.string().min(1).max(512).optional(), bytesRead: z.number().int().nonnegative().optional(),
    byteBoundary: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
        .refine(value => value.start <= value.end && value.end <= value.total),
}).passthrough();
export type NativeSavedHistory = z.infer<typeof NativeSavedHistorySchema>;

/** Saved data availability never implies a native controller or current turn. */
export function codelyncSavedHistory(session: Pick<Session, 'metadata'> | null | undefined): NativeSavedHistory | null {
    const metadata = session?.metadata, bridge = metadata?.bridge;
    const parsed = NativeSavedHistorySchema.safeParse(metadata?.nativeSavedHistory);
    if (!parsed.success || metadata?.client?.id !== 'noninvasive-bridge' || bridge?.sourceStatus !== 'history-only'
        || bridge.controlMode !== 'session' || bridge.source.app !== parsed.data.app || bridge.source.id !== parsed.data.nativeId
        || bridge.source.hostId !== parsed.data.hostId || bridge.source.runtimeGeneration !== null || bridge.currentTurnId !== null) return null;
    return parsed.data;
}
