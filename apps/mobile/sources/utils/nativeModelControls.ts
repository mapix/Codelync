import { NativeModelControlScopeSchema, type NativeModelControlScope, type Session, type Metadata } from '@/sync/storageTypes';
import { isCodelyncSessionSource } from './codelyncSourceScope';
import { readNativeQuery } from './nativeQuery';
import { currentNativeTaskSignal } from './codelyncNativeTasks';
import { nativeComposerInputReadOnly } from './nativeComposerInputReadOnly';

export function nativeModelControlScopesEqual(a: NativeModelControlScope, b: NativeModelControlScope): boolean {
    if (a === b) return true;
    return a.app === b.app
        && a.appMode === b.appMode
        && a.nativeCollection === b.nativeCollection
        && a.nativeConversationId === b.nativeConversationId
        && a.hostId === b.hostId
        && a.ownerGeneration === b.ownerGeneration
        && a.runtimeGeneration === b.runtimeGeneration
        && a.queryToken === b.queryToken
        && a.cliSessionId === b.cliSessionId
        && a.settingsToken === b.settingsToken;
}

/** Main-runtime identity is independent of the per-session owner epoch. */
export function readNativeModelControlScope(session: Session | null | undefined): NativeModelControlScope | null {
    const metadata = session?.metadata, bridge = metadata?.bridge, source = bridge?.source;
    const parsed = NativeModelControlScopeSchema.safeParse(metadata?.nativeControls?.scope);
    const query = readNativeQuery(metadata, session?.agentState?.nativeQuery);
    const main = metadata?.nativeDesktopRuntimeGeneration ?? session?.agentState?.nativeDesktopRuntimeGeneration ?? currentNativeTaskSignal(session)?.scope.runtimeGeneration;
    if (!parsed.success || metadata?.client?.id !== 'noninvasive-bridge' || !source || source.app !== 'claude-desktop'
        || bridge?.sourceStatus !== 'connected' || !isCodelyncSessionSource(source, bridge.controlMode) || !query || !main) return null;
    const scope = parsed.data;
    return scope.app === source.app && scope.appMode === source.appMode && scope.nativeCollection === source.nativeCollection
        && scope.nativeConversationId === source.id && scope.hostId === source.hostId && scope.ownerGeneration === source.runtimeGeneration
        && scope.ownerGeneration === query.ownerGeneration && scope.queryToken === query.queryToken && scope.runtimeGeneration === main ? scope : null;
}

export function canWriteNativeModelControls(session: Session | null | undefined): boolean {
    const controls = session?.metadata?.nativeControls, scope = readNativeModelControlScope(session);
    return !!scope && !!session && session.metadata?.capabilities?.readOnly === false && !nativeComposerInputReadOnly(session)
        && controls?.compatibility?.app === scope.app && controls.compatibility.protocol === 'claude-desktop-native'
        && controls.compatibility.supported === true && controls.model.available === true && controls.model.currentConfirmed === true && !!controls.model.current
        && session.metadata.capabilities.rpcMethods.includes('codex-controls-update');
}

type Model = NonNullable<Metadata['nativeControls']>['model']['models'][number];
export function modelAllowsUnsetEffort(app: unknown, model: Model): boolean {
    return model.canUnsetReasoningEffort ?? (app === 'codex' || app === 'antigravity');
}

/** No invented native effort: retain, use the native default, or decline the switch. */
export function clampNativeModelEffort(app: unknown, model: Model, current: string | null): { valid: boolean; effort: string | null } {
    if (current !== null && model.reasoningEfforts.includes(current)) return { valid: true, effort: current };
    if (current === null && modelAllowsUnsetEffort(app, model)) return { valid: true, effort: null };
    if (typeof model.defaultReasoningEffort === 'string' && model.reasoningEfforts.includes(model.defaultReasoningEffort)) return { valid: true, effort: model.defaultReasoningEffort };
    return { valid: modelAllowsUnsetEffort(app, model), effort: null };
}

/** Receipt completion alone is not confirmation of native setting readback. */
export function confirmedNativeModelSettings(scope: NativeModelControlScope, value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const result = value as Record<string, any>, evidence = result.nativeSettingsEvidence;
    const expected = NativeModelControlScopeSchema.safeParse(evidence?.expectedScope), confirmed = NativeModelControlScopeSchema.safeParse(evidence?.confirmedScope);
    const actual = NativeModelControlScopeSchema.safeParse(result.controls?.scope), current = result.controls?.model?.current;
    if (result.applied !== true || result.settingsReadbackConfirmed !== true || evidence?.version !== 1
        || evidence.modelAckConfirmed !== true || evidence.effortAckConfirmed !== true || !expected.success || !confirmed.success || !actual.success
        || !nativeModelControlScopesEqual(scope, expected.data) || !nativeModelControlScopesEqual(confirmed.data, actual.data)) return false;
    return nativeModelControlScopesEqual({ ...scope, settingsToken: confirmed.data.settingsToken }, confirmed.data)
        && typeof evidence.effectiveModel === 'string' && !!evidence.effectiveModel.trim()
        && (evidence.effectiveReasoningEffort === null || typeof evidence.effectiveReasoningEffort === 'string')
        && current?.model === evidence.effectiveModel && current?.reasoningEffort === evidence.effectiveReasoningEffort;
}

/** The durable target retains native identity without storing model/effort payloads. */
export function confirmedNativeModelRpcReceipt(target: string | undefined, value: unknown): boolean {
    if (!target) return true; // Legacy model journals have no native settings scope.
    let fields: unknown;
    try { fields = JSON.parse(target); } catch { return false; }
    if (!Array.isArray(fields)) return false;
    if (fields[0] !== 'codex-controls-update') return false;
    if (fields[1] !== 'settings') return true;
    if (fields.length !== 11) return false;
    const keys = ['appMode', 'nativeCollection', 'nativeConversationId', 'hostId', 'ownerGeneration', 'runtimeGeneration', 'queryToken', 'cliSessionId', 'settingsToken'];
    const parsed = NativeModelControlScopeSchema.safeParse({ app: 'claude-desktop', ...Object.fromEntries(keys.map((key, index) => [key, fields[index + 2]])) });
    return parsed.success && parsed.data.nativeCollection === (parsed.data.appMode === 'code' ? 'claude-code-sessions' : 'local-agent-mode-sessions')
        && confirmedNativeModelSettings(parsed.data, value);
}
