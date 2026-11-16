import { z } from 'zod';
import type { Metadata } from './storageTypes';
import { isCodeLightSessionSource } from '@/utils/codeLightSourceScope';
import { nativeQueryCanSend } from '@/utils/nativeQuery';

export const NONINVASIVE_BRIDGE_CLIENT_ID = 'noninvasive-bridge';

export const NoninvasiveBridgeSchema = z.object({
    version: z.literal(1),
    source: z.object({
        app: z.enum(['codex', 'zcode', 'claude-desktop', 'cursor', 'antigravity', 'windsurf', 'vscode', 'zed', 'trae', 'terminal', 'iterm', 'warp']),
        id: z.string().min(1),
        hostId: z.string().min(1),
        runtimeGeneration: z.string().nullable(),
        windowGeneration: z.string().nullable(),
        kind: z.enum(['session', 'window']).optional(),
        protocol: z.string().optional(),
        appMode: z.enum(['code', 'chat', 'cowork']).optional(),
        nativeCollection: z.enum(['claude-code-sessions', 'local-agent-mode-sessions']).optional(),
    }).passthrough(),
    currentTurnId: z.string().nullable(),
    controlMode: z.enum(['session', 'window']),
    sourceStatus: z.enum(['connected', 'history-only', 'owner-unavailable', 'locked', 'permission-required', 'disconnected']),
}).passthrough();

export function isNoninvasiveBridge(metadata: Metadata | null | undefined): boolean {
    return metadata?.client?.id === NONINVASIVE_BRIDGE_CLIENT_ID;
}

export function canReadFromNoninvasiveSource(metadata: Metadata | null | undefined): boolean {
    if (!isNoninvasiveBridge(metadata)) return true;
    const bridge = metadata?.bridge;
    if (metadata?.nativeSession?.catalogueAvailable === false) return false;
    return isCodeLightSessionSource(bridge?.source, bridge?.controlMode) && bridge?.controlMode === 'session' && bridge.sourceStatus === 'connected'
        && typeof bridge.source.runtimeGeneration === 'string' && !!bridge.source.runtimeGeneration.trim();
}

export function canSendToNoninvasiveSource(metadata: Metadata | null | undefined, agentState?: { nativeQuery?: unknown } | null): boolean {
    if (!isNoninvasiveBridge(metadata)) return true;
    if (metadata?.nativeSession?.isSubagent === true || metadata?.nativeSession?.catalogueAvailable === false) return false;
    const bridge = metadata?.bridge;
    if (bridge?.source.app === 'claude-desktop') return nativeQueryCanSend(metadata, agentState?.nativeQuery);
    return isCodeLightSessionSource(bridge?.source, bridge?.controlMode) && bridge?.controlMode === 'session' && bridge.sourceStatus === 'connected'
        && typeof bridge.source.runtimeGeneration === 'string' && bridge.source.runtimeGeneration.trim().length > 0
        && metadata?.capabilities?.steering === true;
}

export function getNoninvasiveTurnId(metadata: Metadata | null | undefined): string | null {
    if (metadata?.bridge?.source.app === 'claude-desktop') return null;
    if (!isNoninvasiveBridge(metadata) || metadata?.bridge?.sourceStatus !== 'connected'
        || !isCodeLightSessionSource(metadata.bridge.source, metadata.bridge.controlMode)) return null;
    const turnId = metadata.bridge.currentTurnId;
    return typeof turnId === 'string' && turnId.trim() ? turnId : null;
}
