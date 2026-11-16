import type { Session } from '../sync/storageTypes';
import type { AgentTextMessage } from '../sync/typesMessage';
import { codeLightSourceAppName, isCodeLightSessionSource } from './codeLightSourceScope';
import { NONINVASIVE_BRIDGE_CLIENT_ID } from '../sync/noninvasiveBridge';
import { isCodeLightConversation } from './codeLightSessionBrowser';

export type CodeLightHandoff = {
    sourceSessionId: string;
    sourceApp: 'codex' | 'antigravity' | 'claude-desktop';
    machineId: string;
    hostId: string;
    nativeConversationId: string;
    ownerGeneration: string;
    nativeRow: { id: string; offset: number; revision: number };
    title: string;
    text: string;
};
type HandoffSession = Pick<Session, 'id' | 'metadata' | 'draft' | 'updatedAt'>;

const MAX_HANDOFF_TEXT = 128 * 1024;

/** A connected original source, not a CLI/window or remembered catalog record. */
function connectedSource(session: HandoffSession): boolean {
    const metadata = session.metadata, bridge = metadata?.bridge, source = bridge?.source;
    return metadata?.client?.id === NONINVASIVE_BRIDGE_CLIENT_ID && metadata.nativeSession?.catalogueAvailable !== false
        && isCodeLightSessionSource(source, bridge?.controlMode) && bridge?.controlMode === 'session'
        && bridge.sourceStatus === 'connected' && typeof metadata?.machineId === 'string' && !!metadata.machineId
        && typeof source?.id === 'string' && !!source.id && typeof source.hostId === 'string' && !!source.hostId
        && typeof source.runtimeGeneration === 'string' && !!source.runtimeGeneration.trim();
}

/** Snapshot only the original assistant fragment the user explicitly selected. */
export function createCodeLightHandoff(session: HandoffSession, message: AgentTextMessage): CodeLightHandoff | null {
    const source = session.metadata?.bridge?.source, row = message.meta?.nativeRow;
    if (!connectedSource(session) || !source || message.isThinking || !message.text.trim() || message.text.length > MAX_HANDOFF_TEXT
        || !row?.id || !Number.isSafeInteger(row.offset) || row.offset < 0 || !Number.isSafeInteger(row.revision) || row.revision < 0) return null;
    if (source.app !== 'codex' && source.app !== 'antigravity' && source.app !== 'claude-desktop') return null;
    return { sourceSessionId: session.id, sourceApp: source.app, machineId: session.metadata!.machineId!,
        hostId: source.hostId, nativeConversationId: source.id, ownerGeneration: source.runtimeGeneration!,
        nativeRow: { ...row }, title: session.metadata?.nativeSession?.title || session.metadata?.summary?.text || codeLightSourceAppName(source.app), text: message.text };
}

/** Field-only target list; no history loads or model requests. */
export function codeLightHandoffTargets(handoff: CodeLightHandoff, sessions: Session[]): Session[] {
    return sessions.filter(session => {
        const source = session.metadata?.bridge?.source;
        return session.id !== handoff.sourceSessionId && session.metadata?.client?.id === NONINVASIVE_BRIDGE_CLIENT_ID && isCodeLightConversation(session)
            && session.metadata?.machineId === handoff.machineId && source?.app !== handoff.sourceApp;
    }).sort((a, b) => b.updatedAt - a.updatedAt);
}

function sourceStillMatches(handoff: CodeLightHandoff, sourceSession: Session): boolean {
    const source = sourceSession.metadata?.bridge?.source;
    return connectedSource(sourceSession) && sourceSession.id === handoff.sourceSessionId
        && sourceSession.metadata?.machineId === handoff.machineId && source?.app === handoff.sourceApp
        && source.id === handoff.nativeConversationId && source.hostId === handoff.hostId && source.runtimeGeneration === handoff.ownerGeneration;
}

/** Append to the latest target draft. This function never dispatches anything. */
export function prepareCodeLightHandoffDraft(handoff: CodeLightHandoff, sourceSession: Session, targetSession: Session): string | null {
    if (!sourceStillMatches(handoff, sourceSession) || !codeLightHandoffTargets(handoff, [targetSession]).length) return null;
    const quoted = JSON.stringify({ sourceApplication: codeLightSourceAppName(handoff.sourceApp), sourceConversation: handoff.title,
        machineId: handoff.machineId, nativeHostId: handoff.hostId, nativeConversationId: handoff.nativeConversationId,
        originalMessage: handoff.nativeRow, text: handoff.text }, null, 2);
    const block = `Context from ${codeLightSourceAppName(handoff.sourceApp)}. Use this quoted response as context for my next instruction.\n\n\`\`\`json\n${quoted}\n\`\`\``;
    const draft = targetSession.draft ?? '';
    if (draft.includes(block)) return draft;
    return draft ? `${draft}\n\n---\n\n${block}` : block;
}
