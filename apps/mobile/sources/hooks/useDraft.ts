import { useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { storage } from '@/sync/storage';
import { isRigMetadataV1 } from '@/sync/rig';
import { rigComposerClear, rigComposerSetText } from '@/sync/rigComposer';
import { useIsFocused } from '@react-navigation/native';
import { isNoninvasiveBridge } from '@/sync/noninvasiveBridge';

interface UseDraftOptions {
    autoSaveInterval?: number; // in milliseconds, default 2000
}

const nativeDraftFlushers = new Map<string, { owner: symbol; flush: () => boolean }>();

/** Explicit local staging only; never dispatches a native operation. */
export function flushNativeDraft(sessionId: string): boolean {
    return nativeDraftFlushers.get(sessionId)?.flush() ?? false;
}

export function useDraft(
    sessionId: string | null | undefined,
    value: string,
    onChange: (value: string) => void,
    options: UseDraftOptions = {}
) {
    const { autoSaveInterval = 2000 } = options;
    const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingDraft = useRef<string | null>(null);
    // Seed with the initial value so a pre-hydrated draft (e.g. ChatComposer
    // reads storage synchronously on mount) doesn't trip the autosave into
    // re-writing what we just loaded.
    const lastSavedValue = useRef<string>(value);
    const loadedSessionId = useRef(sessionId);
    const adoptedDraft = useRef<string | null>(null);
    const isFocused = useIsFocused();
    // Happy Agent sessions sync the draft through metadata: every edit goes to
    // the mirror at once (the writer debounces the network), and remote edits
    // come back through the store.
    const isNative = !!sessionId && isNoninvasiveBridge(storage.getState().sessions[sessionId]?.metadata);
    const isSynced = !!sessionId && !isNative && isRigMetadataV1(storage.getState().sessions[sessionId]?.metadata);

    // Save draft to storage
    const saveDraft = useCallback((draft: string) => {
        if (!sessionId) return;
        // An external handoff/parent stage owns a newer baseline than an old debounce.
        const current = storage.getState().sessions[sessionId];
        if (isNoninvasiveBridge(current?.metadata) && (current?.draft ?? '') !== lastSavedValue.current && (current?.draft ?? '') !== draft) return;

        // Record first: the store notifies its subscribers synchronously.
        lastSavedValue.current = draft;
        pendingDraft.current = null;
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
        // Read the session at call time so a composer that mounted before metadata
        // arrived does not write an unstamped local-only draft.
        if (!isNoninvasiveBridge(current?.metadata) && isRigMetadataV1(current?.metadata)) {
            rigComposerSetText(sessionId, draft);
        } else {
            storage.getState().updateSessionDraft(sessionId, draft);
        }
    }, [sessionId]);

    // Load draft on mount and when focused
    useEffect(() => {
        if (!sessionId || !isFocused) return;

        const session = storage.getState().sessions[sessionId];
        if (isNative && (loadedSessionId.current !== sessionId || typeof session?.draft === 'string' && session.draft !== lastSavedValue.current)) {
            loadedSessionId.current = sessionId;
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null; pendingDraft.current = null;
            const stored = session?.draft ?? '';
            lastSavedValue.current = stored; adoptedDraft.current = stored;
            if (value !== stored) onChange(stored);
            return;
        }
        if (session?.draft && !value) {
            adoptedDraft.current = session.draft;
            onChange(session.draft);
            lastSavedValue.current = session.draft;
        } else if (!session?.draft) {
            // Ensure lastSavedValue is empty if there's no draft
            lastSavedValue.current = '';
        }
    }, [sessionId, isFocused, isNative, onChange]);

    // The store reconciles remote writes. Applying one is not a local edit.
    useEffect(() => {
        if (!sessionId || !isSynced && !isNative) return;
        return storage.subscribe((state, previous) => {
            const draft = state.sessions[sessionId]?.draft ?? '';
            if (draft === (previous.sessions[sessionId]?.draft ?? '') || draft === lastSavedValue.current) return;
            if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = null;
            pendingDraft.current = null;
            lastSavedValue.current = draft;
            adoptedDraft.current = draft;
            onChange(draft);
        });
    }, [sessionId, isSynced, isNative, onChange]);

    // Auto-save with smart debouncing
    useEffect(() => {
        if (!sessionId) return;
        // onChange adoption is asynchronous; this render may still contain the old source text.
        if (adoptedDraft.current !== null) {
            if (value !== adoptedDraft.current) return;
            adoptedDraft.current = null;
        }

        // Clear any existing timeout
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }
        pendingDraft.current = null;

        // Only save if value has changed
        if (value !== lastSavedValue.current) {
            const wasEmpty = !lastSavedValue.current.trim();
            const isEmpty = !value.trim();

            if (isSynced || wasEmpty !== isEmpty) {
                // State transition: empty <-> non-empty
                // Save immediately for instant feedback
                saveDraft(value);
            } else if (!isEmpty) {
                // Text is being modified (non-empty to non-empty)
                // Debounce to avoid excessive saves
                pendingDraft.current = value;
                saveTimeoutRef.current = setTimeout(() => {
                    saveDraft(value);
                }, autoSaveInterval);
            }
            // If both are empty, no need to save
        }

        return () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        };
    }, [value, sessionId, autoSaveInterval, saveDraft, isSynced]);

    // Staging needs the latest focused composer render, not a debounced stored value.
    useEffect(() => {
        if (!sessionId || !isNative || !isFocused) return;
        const owner = Symbol(sessionId);
        const flush = () => {
            const current = storage.getState().sessions[sessionId];
            if (!isNoninvasiveBridge(current?.metadata) || loadedSessionId.current !== sessionId
                || adoptedDraft.current !== null && value !== adoptedDraft.current
                || (current?.draft ?? '') !== lastSavedValue.current && (current?.draft ?? '') !== value) return false;
            if (value !== lastSavedValue.current) saveDraft(value);
            return (storage.getState().sessions[sessionId]?.draft ?? '') === value;
        };
        nativeDraftFlushers.set(sessionId, { owner, flush });
        return () => {
            if (nativeDraftFlushers.get(sessionId)?.owner === owner) nativeDraftFlushers.delete(sessionId);
        };
    }, [sessionId, isNative, isFocused, value, saveDraft]);

    // Save on app state change (background/inactive)
    useEffect(() => {
        if (!sessionId) return;

        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'background' || nextAppState === 'inactive') {
                if (pendingDraft.current !== null) {
                    saveDraft(pendingDraft.current);
                }
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            subscription.remove();
        };
    }, [sessionId, saveDraft]);

    // Flush only an actual pending edit, never the value from an older render.
    useEffect(() => {
        return () => {
            if (sessionId && pendingDraft.current !== null) {
                saveDraft(pendingDraft.current);
            }
        };
    }, [sessionId, saveDraft]);

    // Clear draft (used after message is sent)
    const clearDraft = useCallback(() => {
        if (!sessionId) return;

        lastSavedValue.current = '';
        adoptedDraft.current = null;
        pendingDraft.current = null;
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
        const metadata = storage.getState().sessions[sessionId]?.metadata;
        if (!isNoninvasiveBridge(metadata) && isRigMetadataV1(metadata)) {
            rigComposerClear(sessionId);
        } else {
            storage.getState().updateSessionDraft(sessionId, null);
        }
    }, [sessionId]);

    return {
        clearDraft
    };
}
