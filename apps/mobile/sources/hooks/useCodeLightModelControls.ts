import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@/sync/storageTypes';
import type { EffortLevel, ModelMode } from '@/components/modelModeOptions';
import { isNoninvasiveBridge } from '@/sync/noninvasiveBridge';
import { recoverCodeLightModelRpc, recoverCodeLightNativeModelRpc, runCodeLightModelRpc, runNoninvasiveRpc } from '@/sync/noninvasiveRpc';
import { t } from '@/text';
import { codeLightSourceAppName } from '@/utils/codeLightSourceScope';
import { readNativeObservedModel } from '@/utils/nativeObservedModel';
import { storage, useSocketStatus } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { nativeWriteConnectionBlocked } from '@/utils/nativeWriteConnection';
import { nativeComposerInputReadOnly } from '@/utils/nativeComposerInputReadOnly';
import { nativeSubagentInputReadOnly } from '@/utils/nativeParentControl';
import { codeLightSavedHistory } from '@/utils/nativeSavedHistory';
import { canWriteNativeModelControls, clampNativeModelEffort, confirmedNativeModelSettings, modelAllowsUnsetEffort, nativeModelControlScopesEqual, readNativeModelControlScope } from '@/utils/nativeModelControls';

export function useCodeLightModelControls(session: Session | null) {
    const socketConnected = useSocketStatus().status === 'connected' && apiSocket.peerConnected();
    const native = isNoninvasiveBridge(session?.metadata), controls = session?.metadata?.nativeControls?.model;
    const id = session?.id, app = session?.metadata?.bridge?.source.app, claude = app === 'claude-desktop';
    const scope = readNativeModelControlScope(session), scopeKey = scope ? JSON.stringify(scope) : null;
    const observed = readNativeObservedModel(session);
    const modelReadSuppressed = nativeSubagentInputReadOnly(session) || !!codeLightSavedHistory(session);
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
                const recovered = await recoverCodeLightNativeModelRpc(id, operation.params);
                if (recovered.confirmed && recovered.pending && confirmedNativeModelSettings(operation.params.expectedScope as NonNullable<typeof scope>, recovered.result)) {
                    if (pending.current === operation) pending.current = null;
                    setSessionStatus(id, 'idle');
                }
            } else if (await recoverCodeLightModelRpc(id, operation.params)) {
                if (pending.current === operation) pending.current = null;
                setSessionStatus(id, 'idle');
            }
        }
        if (readError) throw readError;
    }, [id, canRead, socketConnected, scopeKey, setSessionStatus]);
    useEffect(() => {
        if (native && canRead && (!controls || claude && controls.catalogAvailable === false)) void refresh().catch(() => {});
    }, [native, canRead, controls, refresh]);
    const compatibility = session?.metadata?.nativeControls?.compatibility;
    const catalogReadable = !modelReadSuppressed && (!claude || !!scope && controls?.catalogAvailable === true);
    const models: ModelMode[] = useMemo(() => (catalogReadable ? controls?.models ?? [] : []).map(model => ({ key: model.id, modelId: model.id, name: model.label,
        ...(compatibility ? { providerId: compatibility.app, providerName: [codeLightSourceAppName(compatibility.app), compatibility.appVersion].filter(Boolean).join(' ') } : {}),
        thinkingLevels: model.reasoningEfforts, defaultThinkingLevel: model.defaultReasoningEffort })), [catalogReadable, controls, compatibility]);
    const current = modelReadSuppressed || claude && (!scope || controls?.currentConfirmed !== true) ? null : controls?.current;
    const currentEntry = catalogReadable ? controls?.models.find(model => model.id === current?.model)
        ?? controls?.models.find(model => model.nativeResolvedModel === current?.model) : undefined;
    const selectedModel = current ? currentEntry ? models.find(model => model.key === currentEntry.id) ?? { key: current.model, name: current.model } : { key: current.model, name: current.model }
        : observed?.model ? { key: observed.model, name: observed.model } : null;
    const currentModel = selectedModel && current && controls?.selectionMode === 'next-message' && controls.selectionState === 'staged' ? { ...selectedModel, name: `${selectedModel.name} · ${t('codeLightModels.nextMessage')}` } : selectedModel;
    const efforts: EffortLevel[] = useMemo(() => currentEntry ? [...(modelAllowsUnsetEffort(app, currentEntry) ? [{ key: '__default__', name: t('codeLightModels.default') }] : []),
        ...currentEntry.reasoningEfforts.map(key => ({ key, name: key.charAt(0).toUpperCase() + key.slice(1) }))] : [], [app, currentEntry]);
    const enabled = native && !nativeWriteConnectionBlocked(session?.metadata, socketConnected) && !!current && status !== 'saving' && status !== 'unknown' && !nativeComposerInputReadOnly(session)
        && (claude ? canWriteNativeModelControls(session) : controls?.available === true && session?.metadata?.capabilities?.rpcMethods?.includes('codex-controls-update') === true);
    const change = useCallback(async (model: string, reasoningEffort: string | null) => {
        if (!id || !current || !enabled || pending.current?.id === id) return;
        if (nativeWriteConnectionBlocked(session?.metadata, apiSocket.peerConnected())) return;
        const capturedScope = scope ? { ...scope } : null;
        if (claude) {
            const live = storage.getState().sessions[id], currentScope = readNativeModelControlScope(live);
            if (!capturedScope || !currentScope || !canWriteNativeModelControls(live) || !nativeModelControlScopesEqual(capturedScope, currentScope)) return;
        }
        const params = { model, reasoningEffort, expectedModel: current.model, expectedReasoningEffort: current.reasoningEffort,
            ...(capturedScope ? { expectedScope: capturedScope } : {}) };
        const operation = { id, params, status: 'saving' as const };
        pending.current = operation;
        setSessionStatus(id, 'saving');
        try {
            // 期望值来自用户看到的原 owner 设置；桌面并发修改时拒绝覆盖，不能仅更新手机本地模式。
            const result = await runCodeLightModelRpc(id, params);
            if (capturedScope && !confirmedNativeModelSettings(capturedScope, result)) throw Error('Native settings readback not confirmed');
            if (pending.current === operation) pending.current = null;
            setSessionStatus(id, 'idle');
        } catch (error) {
            const unknown = error instanceof Error && /unconfirmed|did not respond|not confirmed/i.test(error.message);
            if (unknown && pending.current === operation) pending.current = { ...operation, status: 'unknown' };
            setSessionStatus(id, unknown ? 'unknown' : 'error');
            if (!unknown) { if (pending.current === operation) pending.current = null; void refresh().catch(() => {}); }
        }
    }, [id, current, enabled, claude, native, session?.metadata, scopeKey, refresh, setSessionStatus]);
    const selectModel = useCallback((model: ModelMode) => {
        if (!current || !enabled) return;
        const entry = controls?.models.find(candidate => candidate.id === model.key);
        if (!entry) return;
        const effort = clampNativeModelEffort(app, entry, current.reasoningEffort);
        if (effort.valid) void change(entry.id, effort.effort);
    }, [app, controls, current, enabled, change]);
    const selectEffort = useCallback((effort: EffortLevel) => { if (current && efforts.some(e => e.key === effort.key)) void change(current.model, effort.key === '__default__' ? null : effort.key); }, [current, efforts, change]);
    const currentEffort = current ? efforts.find(e => e.key === (current.reasoningEffort ?? '__default__')) ?? (current.reasoningEffort ? { key: current.reasoningEffort, name: current.reasoningEffort } : null)
        : observed?.effort ? { key: observed.effort, name: observed.effort } : null;
    return { native, enabled, models, currentModel, efforts, scope, catalogReadable, catalogComplete: controls?.catalogComplete ?? controls?.complete ?? false, observedCurrent: !current && !!observed,
        showReadOnlyEffort: native && !enabled && !!currentEffort,
        currentEffort,
        selectModel, selectEffort, refresh, canRefresh: canRead || !!id && socketConnected && pending.current?.id === id, status, message: status === 'saving' ? t('codeLightModels.saving') : status === 'unknown' ? t('codeLightModels.unconfirmed') : status === 'error' ? t('codeLightModels.failed') : status === 'read-error' && !modelReadSuppressed ? t('codeLightModels.readFailed') : null };
}
