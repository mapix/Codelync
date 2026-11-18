import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@/sync/storageTypes';
import type { EffortLevel, ModelMode } from '@/components/modelModeOptions';
import { isNoninvasiveBridge } from '@/sync/noninvasiveBridge';
import { recoverCodelyncModelRpc, recoverCodelyncNativeModelRpc, runCodelyncModelRpc, runNoninvasiveRpc } from '@/sync/noninvasiveRpc';
import { t } from '@/text';
import { codelyncSourceAppName } from '@/utils/codelyncSourceScope';
import { readNativeObservedModel } from '@/utils/nativeObservedModel';
import { storage, useSocketStatus } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { nativeWriteConnectionBlocked } from '@/utils/nativeWriteConnection';
import { nativeComposerInputReadOnly } from '@/utils/nativeComposerInputReadOnly';
import { nativeSubagentInputReadOnly } from '@/utils/nativeParentControl';
import { codelyncSavedHistory } from '@/utils/nativeSavedHistory';
import { nativeReadingIdentity } from '@/utils/nativeReadingWindow';
import { canWriteNativeModelControls, clampNativeModelEffort, confirmedNativeModelSettings, modelAllowsUnsetEffort, nativeModelControlScopesEqual, readNativeModelControlScope } from '@/utils/nativeModelControls';

const EMPTY_MODELS: ModelMode[] = [];
const EMPTY_EFFORTS: EffortLevel[] = [];

function sameStringList(a?: readonly string[], b?: readonly string[]): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function sameModelModes(a: readonly ModelMode[], b: readonly ModelMode[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const left = a[i], right = b[i];
        if (left === right) continue;
        if (left.key !== right.key
            || left.modelId !== right.modelId
            || left.name !== right.name
            || left.providerId !== right.providerId
            || left.providerName !== right.providerName
            || left.defaultThinkingLevel !== right.defaultThinkingLevel
            || !sameStringList(left.thinkingLevels, right.thinkingLevels)) return false;
    }
    return true;
}

function sameEffortLevels(a: readonly EffortLevel[], b: readonly EffortLevel[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].key !== b[i].key || a[i].name !== b[i].name) return false;
    }
    return true;
}

export function useCodelyncModelControls(session: Session | null) {
    const socketConnected = useSocketStatus().status === 'connected' && apiSocket.peerConnected();
    const native = isNoninvasiveBridge(session?.metadata), controls = session?.metadata?.nativeControls?.model;
    const id = session?.id, app = session?.metadata?.bridge?.source.app, claude = app === 'claude-desktop';
    const rawScope = readNativeModelControlScope(session);
    const scopeRef = useRef<typeof rawScope>(null);
    const scope = useMemo(() => {
        if (!rawScope) {
            scopeRef.current = null;
            return null;
        }
        if (scopeRef.current && nativeModelControlScopesEqual(scopeRef.current, rawScope)) {
            return scopeRef.current;
        }
        scopeRef.current = rawScope;
        return rawScope;
    }, [rawScope]);
    const observed = readNativeObservedModel(session);
    const modelReadSuppressed = nativeSubagentInputReadOnly(session) || !!codelyncSavedHistory(session);
    const canRead = native && socketConnected && !modelReadSuppressed && session?.metadata?.capabilities?.rpcMethods?.includes('codex-controls-read') === true && (!claude || !!scope);
    type Status = 'idle' | 'saving' | 'error' | 'unknown' | 'read-error';
    const [status, setStatus] = useState<Status>('idle');
    const selectedId = useRef(id); selectedId.current = id;
    const pending = useRef<{ id: string; params: Record<string, unknown>; status: 'saving' | 'unknown' } | null>(null);
    const setSessionStatus = useCallback((target: string | undefined, next: Status) => { if (selectedId.current === target) setStatus(next); }, []);
    useEffect(() => { const operation = pending.current; setStatus(operation && operation.id === id ? operation.status : 'idle'); }, [id]);
    const refresh = useCallback(async () => {
        if (!id) return;
        let readError: unknown;
        if (canRead) {
            try {
                await runNoninvasiveRpc(id, 'codex-controls-read', {});
                if (pending.current?.id !== id && selectedId.current === id) setStatus(currentStatus => currentStatus === 'read-error' ? 'idle' : currentStatus);
            } catch (error) {
                readError = error;
                if (pending.current?.id !== id && selectedId.current === id) setStatus(currentStatus => ['unknown', 'saving', 'error'].includes(currentStatus) ? currentStatus : 'read-error');
            }
        }
        // Recovery queries the original durable receipt; it never repeats an
        // update or requires an unsupported child settings-controller read.
        const operation = pending.current;
        if (operation?.id === id && socketConnected) {
            if (operation.params.expectedScope) {
                const recovered = await recoverCodelyncNativeModelRpc(id, operation.params);
                if (recovered.confirmed && recovered.pending && confirmedNativeModelSettings(operation.params.expectedScope as NonNullable<typeof scope>, recovered.result)) {
                    if (pending.current === operation) pending.current = null;
                    setSessionStatus(id, 'idle');
                }
            } else if (await recoverCodelyncModelRpc(id, operation.params)) {
                if (pending.current === operation) pending.current = null;
                setSessionStatus(id, 'idle');
            }
        }
        if (readError) throw readError;
    }, [id, canRead, socketConnected, scope, setSessionStatus]);
    useEffect(() => {
        if (native && canRead && (!controls || claude && controls.catalogAvailable === false)) void refresh().catch(() => {});
    }, [native, canRead, controls, refresh]);
    const compatibility = session?.metadata?.nativeControls?.compatibility;
    const hasCompatibility = !!compatibility, compatApp = compatibility?.app, compatVersion = compatibility?.appVersion;
    const rawModels = controls?.models;
    const catalogReadable = !modelReadSuppressed && (!claude || !!scope && controls?.catalogAvailable === true);
    const modelsRef = useRef<ModelMode[]>(EMPTY_MODELS);
    const models: ModelMode[] = useMemo(() => {
        if (!catalogReadable || !rawModels?.length) {
            modelsRef.current = EMPTY_MODELS;
            return EMPTY_MODELS;
        }
        const providerMeta = hasCompatibility ? { providerId: compatApp, providerName: [codelyncSourceAppName(compatApp), compatVersion].filter(Boolean).join(' ') } : undefined;
        const next: ModelMode[] = rawModels.map(model => ({ key: model.id, modelId: model.id, name: model.label,
            ...providerMeta,
            thinkingLevels: model.reasoningEfforts, defaultThinkingLevel: model.defaultReasoningEffort }));
        if (sameModelModes(modelsRef.current, next)) return modelsRef.current;
        modelsRef.current = next;
        return next;
    }, [catalogReadable, rawModels, hasCompatibility, compatApp, compatVersion]);
    const current = modelReadSuppressed || claude && (!scope || controls?.currentConfirmed !== true) ? null : controls?.current;
    const currentEntry = catalogReadable ? controls?.models.find(model => model.id === current?.model)
        ?? controls?.models.find(model => model.nativeResolvedModel === current?.model) : undefined;
    const selectedModel = current ? currentEntry ? models.find(model => model.key === currentEntry.id) ?? { key: current.model, name: current.model } : { key: current.model, name: current.model }
        : observed?.model ? { key: observed.model, name: observed.model } : null;
    const currentModel = selectedModel && current && controls?.selectionMode === 'next-message' && controls.selectionState === 'staged' ? { ...selectedModel, name: `${selectedModel.name} · ${t('codelyncModels.nextMessage')}` } : selectedModel;
    const defaultEffortLabel = currentEntry && modelAllowsUnsetEffort(app, currentEntry) ? t('codelyncModels.default') : null;
    const currentReasoningEfforts = currentEntry?.reasoningEfforts;
    const effortsRef = useRef<EffortLevel[]>(EMPTY_EFFORTS);
    const efforts: EffortLevel[] = useMemo(() => {
        if (!currentEntry || !currentReasoningEfforts) {
            effortsRef.current = EMPTY_EFFORTS;
            return EMPTY_EFFORTS;
        }
        const next: EffortLevel[] = [
            ...(defaultEffortLabel !== null ? [{ key: '__default__', name: defaultEffortLabel }] : []),
            ...currentReasoningEfforts.map(key => ({ key, name: key.charAt(0).toUpperCase() + key.slice(1) })),
        ];
        if (sameEffortLevels(effortsRef.current, next)) return effortsRef.current;
        effortsRef.current = next;
        return next;
    }, [currentEntry, currentReasoningEfforts, defaultEffortLabel]);
    const enabled = native && !nativeWriteConnectionBlocked(session?.metadata, socketConnected) && !!current && status !== 'saving' && status !== 'unknown' && !nativeComposerInputReadOnly(session)
        && (claude ? canWriteNativeModelControls(session) : controls?.available === true && session?.metadata?.capabilities?.rpcMethods?.includes('codex-controls-update') === true);
    const change = useCallback(async (model: string, reasoningEffort: string | null) => {
        if (!id || !current || !enabled || pending.current?.id === id) return;
        const live = storage.getState().sessions[id];
        if (!live || nativeWriteConnectionBlocked(live.metadata, apiSocket.peerConnected()) || nativeComposerInputReadOnly(live)
            || live.metadata?.capabilities?.rpcMethods?.includes('codex-controls-update') !== true
            || nativeReadingIdentity(id, live.metadata, 'native-model') !== nativeReadingIdentity(id, session?.metadata ?? null, 'native-model')
            || live.metadata?.bridge?.source.runtimeGeneration !== session?.metadata?.bridge?.source.runtimeGeneration) return;
        const capturedScope = scope ? { ...scope } : null;
        if (claude) {
            const currentScope = readNativeModelControlScope(live);
            if (!capturedScope || !currentScope || !canWriteNativeModelControls(live) || !nativeModelControlScopesEqual(capturedScope, currentScope)) return;
        }
        const params = { model, reasoningEffort, expectedModel: current.model, expectedReasoningEffort: current.reasoningEffort,
            ...(capturedScope ? { expectedScope: capturedScope } : {}) };
        const operation = { id, params, status: 'saving' as const };
        pending.current = operation;
        setSessionStatus(id, 'saving');
        try {
            // 期望值来自用户看到的原 owner 设置；桌面并发修改时拒绝覆盖，不能仅更新手机本地模式。
            const result = await runCodelyncModelRpc(id, params);
            if (capturedScope && !confirmedNativeModelSettings(capturedScope, result)) throw Error('Native settings readback not confirmed');
            if (pending.current === operation) pending.current = null;
            setSessionStatus(id, 'idle');
        } catch (error) {
            const unknown = error instanceof Error && /unconfirmed|did not respond|not confirmed/i.test(error.message);
            if (unknown && pending.current === operation) pending.current = { ...operation, status: 'unknown' };
            setSessionStatus(id, unknown ? 'unknown' : 'error');
            if (!unknown) { if (pending.current === operation) pending.current = null; void refresh().catch(() => {}); }
        }
    }, [id, current, enabled, claude, native, session?.metadata, scope, refresh, setSessionStatus]);
    const selectModel = useCallback((model: ModelMode) => {
        if (!current || !enabled) return;
        const entry = rawModels?.find(candidate => candidate.id === model.key);
        if (!entry) return;
        const effort = clampNativeModelEffort(app, entry, current.reasoningEffort);
        if (effort.valid) void change(entry.id, effort.effort);
    }, [app, rawModels, current, enabled, change]);
    const selectEffort = useCallback((effort: EffortLevel) => { if (current && efforts.some(e => e.key === effort.key)) void change(current.model, effort.key === '__default__' ? null : effort.key); }, [current, efforts, change]);
    const currentEffort = current ? efforts.find(e => e.key === (current.reasoningEffort ?? '__default__')) ?? (current.reasoningEffort ? { key: current.reasoningEffort, name: current.reasoningEffort } : null)
        : observed?.effort ? { key: observed.effort, name: observed.effort } : null;
    return { native, enabled, models, currentModel, efforts, scope, catalogReadable, catalogComplete: controls?.catalogComplete ?? controls?.complete ?? false, observedCurrent: !current && !!observed,
        showReadOnlyEffort: native && !enabled && !!currentEffort,
        currentEffort,
        selectModel, selectEffort, refresh, canRefresh: canRead || !!id && socketConnected && pending.current?.id === id, status, message: status === 'saving' ? t('codelyncModels.saving') : status === 'unknown' ? t('codelyncModels.unconfirmed') : status === 'error' ? t('codelyncModels.failed') : status === 'read-error' && !modelReadSuppressed ? t('codelyncModels.readFailed') : null };
}
