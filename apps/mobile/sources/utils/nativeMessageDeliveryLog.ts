import type { Message } from '../sync/typesMessage';
import type { Session } from '../sync/storageTypes';
import { NativeDispatchContextSchema, type NativeDispatchContext } from './nativeDispatchContext';
import type { CodeLightOperationStatus } from './codeLightOperationLog';

export type NativeMessageDeliveryRow = { id: string; at: number; status: CodeLightOperationStatus; context: NativeDispatchContext | null };
/** Existing receipt state only. Message text and the current owner are never copied into a historical dispatch. */
export function nativeMessageDeliveryLog(messages: Message[], session: Session): NativeMessageDeliveryRow[] {
    const source = session.metadata?.bridge?.source;
    if (!source) return [];
    return messages.flatMap(message => {
        if (message.kind !== 'user-text' || !message.localId || message.pending === undefined && !message.sendError && !message.deliveryUnconfirmed) return [];
        const raw = message.meta?.nativeDispatchContext, parsed = NativeDispatchContextSchema.safeParse(raw);
        if (raw && (!parsed.success || parsed.data.app !== source.app || parsed.data.nativeConversationId !== source.id
            || parsed.data.hostId !== source.hostId || parsed.data.machineId !== session.metadata?.machineId)) return [];
        const context = parsed.success ? parsed.data : null;
        const status: CodeLightOperationStatus = message.deliveryUnconfirmed ? 'unknown' : message.sendError ? 'not-sent'
            : message.pending === false && session.metadata?.capabilities?.messageReceipts === true ? 'confirmed' : 'pending';
        return [{ id: `local-message:${message.localId}`, at: message.createdAt, status, context }];
    }).sort((a, b) => b.at - a.at).slice(0, 16);
}
