import { z } from 'zod';
import type { Session } from '../sync/storageTypes';
import { codelyncOperationSource } from './codelyncOperationLog';
import { codelyncSubagentParent } from './codelyncSubagents';
import { isCodelyncSessionIdentity } from './codelyncSourceScope';

export const NativeInputSchema = z.object({ available: z.boolean(), reason: z.string().min(1).max(128), parentConversationId: z.string().min(1).max(512).nullable(),
    agentPath: z.string().min(1).max(512), app: z.enum(['codex', 'antigravity']), nativeConversationId: z.string().min(1).max(512),
    hostId: z.string().min(1).max(256), ownerGeneration: z.string().min(1).max(2048) });
/** Phone-only input restriction; native server capabilities remain unchanged. */
export function nativeSubagentInputReadOnly(session: Pick<Session, 'metadata'> | null | undefined): boolean {
    const metadata = session?.metadata, bridge = metadata?.bridge;
    return metadata?.client?.id === 'noninvasive-bridge' && metadata?.nativeSession?.isSubagent === true
        && isCodelyncSessionIdentity(bridge?.source, bridge?.controlMode);
}
export function nativeParentControl(session: Session) {
    const parsed = NativeInputSchema.safeParse(session.agentState?.nativeInput), source = codelyncOperationSource(session);
    return parsed.success && source && parsed.data.available === false && parsed.data.reason === 'parent-owned-subagent'
        && parsed.data.app === source.app && parsed.data.nativeConversationId === source.nativeConversationId && parsed.data.hostId === source.hostId
        && parsed.data.ownerGeneration === source.ownerGeneration ? parsed.data : null;
}
export function prepareNativeParentContinuation(child: Session, parent: Session): string | null {
    const input = nativeParentControl(child), source = codelyncOperationSource(child);
    if (!input || !source || child.metadata?.machineId !== parent.metadata?.machineId || parent.metadata?.bridge?.source.id !== input.parentConversationId
        || codelyncSubagentParent(child, [parent])?.id !== parent.id) return null;
    const binding = JSON.stringify({ childApplication: source.app, childNativeConversationId: source.nativeConversationId, parentNativeConversationId: input.parentConversationId,
        agentPath: input.agentPath, observedOwnerGeneration: source.ownerGeneration, hostId: source.hostId, machineId: child.metadata?.machineId }, null, 2);
    const block = `Continue this exact native subagent through its original parent-owned followup_task capability. Review the bound identity below and use only a new instruction I write in this parent draft. If none is supplied, ask for it. Do not resend any earlier unconfirmed child message.\n\n\`\`\`json\n${binding}\n\`\`\``;
    const draft = parent.draft ?? '';
    return draft.includes(block) ? draft : draft ? `${draft}\n\n---\n\n${block}` : block;
}
