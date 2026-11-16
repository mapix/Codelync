import { expect, it } from 'vitest';
import type { Session, NativeModelControlScope } from '@/sync/storageTypes';
import { NativeModelControlScopeSchema } from '@/sync/storageTypes';
import { readNativeModelControlScope, canWriteNativeModelControls, clampNativeModelEffort, confirmedNativeModelSettings, modelAllowsUnsetEffort, nativeModelControlScopesEqual } from './nativeModelControls';

function fixture() {
    const scope: NativeModelControlScope = { app: 'claude-desktop', appMode: 'code', nativeCollection: 'claude-code-sessions', nativeConversationId: 'native-code',
        hostId: 'local:claude-desktop:' + 'b'.repeat(64), ownerGeneration: 'session-owner', runtimeGeneration: 'native-main',
        queryToken: 'query', cliSessionId: 'cli', settingsToken: 'a'.repeat(64) };
    const session = { id: 'relay', metadata: { client: { id: 'noninvasive-bridge' }, capabilities: { readOnly: false, rpcMethods: ['codex-controls-read', 'codex-controls-update'] },
        bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null, source: { app: scope.app, appMode: scope.appMode, nativeCollection: scope.nativeCollection,
            kind: 'session', protocol: 'claude-desktop-native', id: scope.nativeConversationId, hostId: scope.hostId, runtimeGeneration: scope.ownerGeneration } },
        nativeControls: { scope, compatibility: { app: scope.app, protocol: 'claude-desktop-native', supported: true }, model: { available: true, currentConfirmed: true, catalogAvailable: true,
            complete: true, current: { model: 'native-model', reasoningEffort: 'native-effort' }, models: [] } } },
        agentState: { nativeDesktopRuntimeGeneration: scope.runtimeGeneration, nativeQuery: { version: 1, app: scope.app, nativeConversationId: scope.nativeConversationId,
            hostId: scope.hostId, ownerGeneration: scope.ownerGeneration, queryToken: scope.queryToken, status: 'running', canSend: false, activeSendMode: 'unverified', canCancel: false } } } as unknown as Session;
    return { scope, session };
}
it('binds native settings to separate main runtime and session-owner identities', () => {
    const { scope, session } = fixture(); expect(readNativeModelControlScope(session)).toEqual(scope); expect(canWriteNativeModelControls(session)).toBe(true);
    session.agentState!.nativeDesktopRuntimeGeneration = scope.ownerGeneration;
    expect(readNativeModelControlScope(session)).toBeNull();
});
it('uses the published metadata main marker without confusing it with owner epoch', () => {
    const { scope, session } = fixture(); delete session.agentState!.nativeDesktopRuntimeGeneration;
    session.metadata!.nativeDesktopRuntimeGeneration = scope.runtimeGeneration;
    expect(readNativeModelControlScope(session)).toEqual(scope);
    session.metadata!.nativeDesktopRuntimeGeneration = scope.ownerGeneration;
    expect(readNativeModelControlScope(session)).toBeNull();
});
it('does not admit absent queries, Cowork contexts or fabricated settings tokens', () => {
    const { scope } = fixture();
    expect(NativeModelControlScopeSchema.safeParse({ ...scope, queryToken: null }).success).toBe(false);
    expect(NativeModelControlScopeSchema.safeParse({ ...scope, cliSessionId: null }).success).toBe(false);
    expect(NativeModelControlScopeSchema.safeParse({ ...scope, appMode: 'cowork' }).success).toBe(false);
    expect(NativeModelControlScopeSchema.safeParse({ ...scope, settingsToken: 'pseudo-native-sequence' }).success).toBe(false);
});
it.each(['owner', 'main', 'query', 'host', 'collection', 'mode', 'missing-main'])('rejects a %s mismatch without model defaults', change => {
    const { session } = fixture();
    if (change === 'owner') session.metadata!.bridge!.source.runtimeGeneration = 'other';
    if (change === 'main') session.agentState!.nativeDesktopRuntimeGeneration = 'other';
    if (change === 'query') session.agentState!.nativeQuery!.queryToken = 'other';
    if (change === 'host') session.metadata!.bridge!.source.hostId = 'local';
    if (change === 'collection') session.metadata!.bridge!.source.nativeCollection = 'local-agent-mode-sessions';
    if (change === 'mode') session.metadata!.bridge!.source.appMode = 'chat';
    if (change === 'missing-main') delete session.agentState!.nativeDesktopRuntimeGeneration;
    expect(readNativeModelControlScope(session)).toBeNull(); expect(canWriteNativeModelControls(session)).toBe(false);
});
it('keeps readonly catalog scope readable while write capability is refused', () => {
    const { scope, session } = fixture(); session.metadata!.capabilities!.readOnly = true;
    expect(readNativeModelControlScope(session)).toEqual(scope); expect(canWriteNativeModelControls(session)).toBe(false);
    session.metadata!.capabilities!.readOnly = false; session.metadata!.nativeControls!.model.available = false;
    expect(readNativeModelControlScope(session)).toEqual(scope); expect(canWriteNativeModelControls(session)).toBe(false);
});
it('does not invent Claude unset effort, and clamps only to native supported/default choices', () => {
    const model = { id: 'native', label: 'Native', reasoningEfforts: ['minimal', 'normal'], defaultReasoningEffort: 'normal' };
    expect(modelAllowsUnsetEffort('codex', model)).toBe(true); expect(modelAllowsUnsetEffort('antigravity', model)).toBe(true);
    expect(modelAllowsUnsetEffort('claude-desktop', model)).toBe(false);
    expect(clampNativeModelEffort('claude-desktop', model, 'minimal')).toEqual({ valid: true, effort: 'minimal' });
    expect(clampNativeModelEffort('claude-desktop', model, null)).toEqual({ valid: true, effort: 'normal' });
    expect(clampNativeModelEffort('claude-desktop', { ...model, defaultReasoningEffort: 'invented' }, 'unsupported')).toEqual({ valid: false, effort: null });
    expect(clampNativeModelEffort('claude-desktop', { ...model, canUnsetReasoningEffort: true }, null)).toEqual({ valid: true, effort: null });
});
it('scope equality is independent of object-key order but includes settings token and query', () => {
    const { scope } = fixture(); expect(nativeModelControlScopesEqual(scope, { ...scope })).toBe(true);
    expect(nativeModelControlScopesEqual(scope, { ...scope, settingsToken: 'b'.repeat(64) })).toBe(false);
    expect(nativeModelControlScopesEqual(scope, { ...scope, queryToken: 'other' })).toBe(false);
});
it('requires both native acknowledgements, exact pre-scope and confirmed effective settings', () => {
    const { scope } = fixture(), confirmed = { ...scope, settingsToken: 'c'.repeat(64) };
    const reply = { applied: true, settingsReadbackConfirmed: true, controls: { scope: confirmed, model: { current: { model: 'effective-native', reasoningEffort: 'native-effort' } } },
        nativeSettingsEvidence: { version: 1, expectedScope: scope, confirmedScope: confirmed, modelAckConfirmed: true, effortAckConfirmed: true,
            effectiveModel: 'effective-native', effectiveReasoningEffort: 'native-effort' } };
    expect(confirmedNativeModelSettings(scope, reply)).toBe(true);
    expect(confirmedNativeModelSettings(scope, { applied: true })).toBe(false);
    expect(confirmedNativeModelSettings(scope, { ...reply, nativeSettingsEvidence: { ...reply.nativeSettingsEvidence, effortAckConfirmed: false } })).toBe(false);
    expect(confirmedNativeModelSettings(scope, { ...reply, nativeSettingsEvidence: { ...reply.nativeSettingsEvidence, confirmedScope: { ...confirmed, queryToken: 'foreign' } } })).toBe(false);
    expect(confirmedNativeModelSettings(scope, { ...reply, controls: { ...reply.controls, model: { current: { model: 'wrong', reasoningEffort: 'native-effort' } } } })).toBe(false);
});
