export type CodeLightSourceApp = 'codex' | 'antigravity' | 'claude-desktop';

type Source = { app?: unknown; id?: unknown; hostId?: unknown; kind?: unknown; protocol?: unknown; runtimeGeneration?: unknown; appMode?: unknown; nativeCollection?: unknown } | null | undefined;

/** Product evidence only. Dispatch still rechecks the live owner and generation. */
export function isCodeLightSessionIdentity(source: Source, controlMode: unknown): boolean {
    if (!source || source.kind !== undefined && source.kind !== 'session') return false;
    if (source.app === 'codex') return controlMode === undefined || controlMode === 'session';
    if (source.app === 'claude-desktop') {
        const collection = source.appMode === 'code' ? 'claude-code-sessions'
            : source.appMode === 'chat' || source.appMode === 'cowork' ? 'local-agent-mode-sessions' : null;
        return source.kind === 'session' && source.protocol === 'claude-desktop-native' && collection !== null
            && source.nativeCollection === collection && typeof source.id === 'string' && !!source.id.trim()
            && typeof source.hostId === 'string' && /^local:claude-desktop:[a-f0-9]{64}$/.test(source.hostId)
            && controlMode === 'session';
    }
    return source.app === 'antigravity' && source.kind === 'session' && source.protocol === 'antigravity-connect'
        && typeof source.id === 'string' && source.id.trim().length > 0
        && typeof source.hostId === 'string' && /^local:antigravity:[a-f0-9]{64}$/.test(source.hostId)
        && controlMode === 'session';
}

/** Current control owner proof is separate from catalog identity. */
export function isCodeLightSessionSource(source: Source, controlMode: unknown): boolean {
    return isCodeLightSessionIdentity(source, controlMode) && (source?.app === 'codex'
        || typeof source?.runtimeGeneration === 'string' && !!source.runtimeGeneration.trim());
}

export function codeLightSourceAppName(app: unknown): string {
    return app === 'antigravity' ? 'Antigravity' : app === 'codex' ? 'Codex' : app === 'claude-desktop' ? 'Claude Desktop' : '';
}

export function codeLightSourceLabel(source: Source): string {
    const app = codeLightSourceAppName(source?.app);
    const mode = source?.appMode === 'code' ? 'Code' : source?.appMode === 'chat' ? 'Chat' : source?.appMode === 'cowork' ? 'Cowork' : '';
    return source?.app === 'claude-desktop' && mode ? `${app} · ${mode}` : app;
}
