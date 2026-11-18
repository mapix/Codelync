import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata, NativeModelControlScope, Session } from '@/sync/storageTypes';

const mocks = vi.hoisted(() => ({
    peerId: 'peer:one' as string | null,
    listeners: new Set<() => void>(),
    connected: true,
    sessions: {} as Record<string, Session>,
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    recover: vi.fn(async () => false),
    nativeRecover: vi.fn(async () => ({ confirmed: false })),
}));

vi.hoisted(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

vi.mock('@/sync/apiSocket', () => ({
    apiSocket: {
        peerIdentity: () => mocks.peerId,
        peerConnected: () => mocks.connected,
        onStatusChange: (listener: () => void) => {
            mocks.listeners.add(listener);
            return () => mocks.listeners.delete(listener);
        },
        sessionRPC: mocks.read,
    },
}));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://fixture.invalid' }));
vi.mock('@/sync/noninvasiveRpc', () => ({
    runNoninvasiveRpc: mocks.read,
    runCodelyncModelRpc: mocks.write,
    recoverCodelyncModelRpc: mocks.recover,
    recoverCodelyncNativeModelRpc: mocks.nativeRecover,
}));
vi.mock('@/sync/storage', () => ({
    useSocketStatus: () => ({ status: mocks.connected ? 'connected' : 'error' }),
    storage: { getState: () => ({ sessions: mocks.sessions }) },
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { useNativeReadingWindow } from '@/hooks/useNativeReadingWindow';
import { useCodelyncModelControls } from '@/hooks/useCodelyncModelControls';
import { nativeModelControlScopesEqual } from '@/utils/nativeModelControls';

function readingMetadata(owner: string | null = 'owner-a', extra: Record<string, unknown> = {}): Metadata {
    return {
        client: { id: 'noninvasive-bridge' },
        machineId: 'machine-1',
        capabilities: { steering: true },
        bridge: {
            source: {
                app: 'claude-desktop',
                kind: 'session',
                id: 'native-one',
                hostId: 'local:claude-desktop:' + 'a'.repeat(64),
                protocol: 'claude-desktop-native',
                appMode: 'code',
                nativeCollection: 'claude-code-sessions',
                runtimeGeneration: owner,
                windowGeneration: null,
            },
            controlMode: 'session',
            sourceStatus: owner ? 'connected' : 'owner-unavailable',
            currentTurnId: null,
        },
        ...extra,
    } as Metadata;
}

function claudeModelSession(overrides: {
    settingsToken?: string;
    currentModel?: string;
    currentEffort?: string | null;
    title?: string;
    canUnset?: boolean;
} = {}): Session {
    const host = 'local:claude-desktop:' + 'a'.repeat(64);
    const token = overrides.settingsToken ?? 'a'.repeat(64);
    const scope: NativeModelControlScope = {
        app: 'claude-desktop',
        appMode: 'code',
        nativeCollection: 'claude-code-sessions',
        nativeConversationId: 'native-1',
        hostId: host,
        ownerGeneration: 'owner-1',
        runtimeGeneration: 'main-1',
        queryToken: 'query-1',
        cliSessionId: 'cli-1',
        settingsToken: token,
    };
    return {
        id: 'relay-1',
        metadata: {
            client: { id: 'noninvasive-bridge' },
            nativeDesktopRuntimeGeneration: 'main-1',
            nativeSession: { title: overrides.title ?? 'Title', updatedAt: 1000, parentId: null, agentName: '', preview: '', isPinned: false },
            capabilities: { readOnly: false, rpcMethods: ['codex-controls-read', 'codex-controls-update'] },
            bridge: {
                controlMode: 'session',
                sourceStatus: 'connected',
                currentTurnId: null,
                source: {
                    app: 'claude-desktop',
                    appMode: 'code',
                    nativeCollection: 'claude-code-sessions',
                    protocol: 'claude-desktop-native',
                    kind: 'session',
                    id: 'native-1',
                    hostId: host,
                    runtimeGeneration: 'owner-1',
                },
            },
            nativeControls: {
                scope,
                compatibility: {
                    app: 'claude-desktop',
                    appVersion: '1.2.3',
                    protocol: 'claude-desktop-native',
                    protocolVersion: 1,
                    supported: true,
                },
                model: {
                    available: true,
                    currentConfirmed: true,
                    catalogAvailable: true,
                    complete: true,
                    current: {
                        model: overrides.currentModel ?? 'model-a',
                        reasoningEffort: overrides.currentEffort === undefined ? 'high' : overrides.currentEffort,
                    },
                    models: [
                        {
                            id: 'model-a',
                            label: 'Model A',
                            reasoningEfforts: ['low', 'high'],
                            defaultReasoningEffort: 'high',
                            canUnsetReasoningEffort: overrides.canUnset ?? false,
                        },
                        {
                            id: 'model-b',
                            label: 'Model B',
                            reasoningEfforts: ['medium', 'high'],
                            defaultReasoningEffort: 'medium',
                            canUnsetReasoningEffort: false,
                        },
                    ],
                },
            },
        },
        agentState: {
            nativeQuery: {
                version: 1,
                app: 'claude-desktop',
                nativeConversationId: 'native-1',
                hostId: host,
                ownerGeneration: 'owner-1',
                queryToken: 'query-1',
                status: 'idle',
                canSend: false,
                canCancel: false,
                activeSendMode: 'unverified',
            },
        },
    } as unknown as Session;
}

describe('Track C Batch 6 — R053 useNativeReadingWindow & R058 useCodelyncModelControls', () => {
    const roots: ReturnType<typeof create>[] = [];

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.peerId = 'peer:one';
        mocks.listeners.clear();
        mocks.connected = true;
        mocks.sessions = {};
    });

    afterEach(() => {
        for (const root of roots.splice(0)) {
            act(() => root.unmount());
        }
        vi.restoreAllMocks();
    });

    it('R053: skips JSON.stringify on re-renders when reading inputs are unchanged or owner clears to null', () => {
        let currentKey = '';
        function Probe({ value }: { value: Metadata }) {
            currentKey = useNativeReadingWindow('relay-1', value);
            return null;
        }

        const stringifySpy = vi.spyOn(JSON, 'stringify');
        let root!: ReturnType<typeof create>;
        act(() => {
            root = create(React.createElement(Probe, { value: readingMetadata('owner-a', { nativeSession: { title: 'One' } }) }));
        });
        roots.push(root);

        const initialKey = currentKey;
        expect(JSON.parse(initialKey)).toMatchObject({ owner: 'owner-a' });
        stringifySpy.mockClear();

        // Re-render with fresh metadata object whose unrelated fields changed -> 0 JSON.stringify calls.
        act(() => {
            root.update(React.createElement(Probe, { value: readingMetadata('owner-a', { nativeSession: { title: 'Two' }, capabilities: { steering: false } }) }));
        });
        expect(currentKey).toBe(initialKey);
        expect(stringifySpy).not.toHaveBeenCalled();

        // Owner loss to null retains state identity without re-serializing `{ identity, owner }`.
        act(() => {
            root.update(React.createElement(Probe, { value: readingMetadata(null) }));
        });
        expect(currentKey).toBe(initialKey);
        expect(JSON.parse(currentKey).owner).toBe('owner-a');
        expect(stringifySpy).toHaveBeenCalledTimes(1); // Only nativeReadingIdentity ran; JSON.stringify(next) was skipped.

        // Next render with owner still null hits scalar cache cleanly (0 JSON.stringify calls).
        stringifySpy.mockClear();
        act(() => {
            root.update(React.createElement(Probe, { value: readingMetadata(null, { nativeSession: { title: 'Three' } }) }));
        });
        expect(currentKey).toBe(initialKey);
        expect(stringifySpy).not.toHaveBeenCalled();

        // Positive owner replacement updates the key as required.
        act(() => {
            root.update(React.createElement(Probe, { value: readingMetadata('owner-b') }));
        });
        expect(currentKey).not.toBe(initialKey);
        expect(JSON.parse(currentKey).owner).toBe('owner-b');
    });

    it('R058: nativeModelControlScopesEqual compares all scope fields without JSON.stringify or Object.keys().sort()', () => {
        const stringifySpy = vi.spyOn(JSON, 'stringify');
        const a: NativeModelControlScope = claudeModelSession().metadata!.nativeControls!.scope!;
        const b: NativeModelControlScope = {
            settingsToken: a.settingsToken,
            cliSessionId: a.cliSessionId,
            queryToken: a.queryToken,
            runtimeGeneration: a.runtimeGeneration,
            ownerGeneration: a.ownerGeneration,
            hostId: a.hostId,
            nativeConversationId: a.nativeConversationId,
            nativeCollection: a.nativeCollection,
            appMode: a.appMode,
            app: a.app,
        };

        expect(nativeModelControlScopesEqual(a, b)).toBe(true);
        expect(nativeModelControlScopesEqual(a, { ...b, settingsToken: 'f'.repeat(64) })).toBe(false);
        expect(stringifySpy).not.toHaveBeenCalled();
    });

    it('R058: stabilizes scope, models, efforts, and refresh across cloned metadata updates without per-render JSON.stringify', () => {
        let controls!: ReturnType<typeof useCodelyncModelControls>;
        function Harness({ session }: { session: Session }) {
            mocks.sessions[session.id] = session;
            controls = useCodelyncModelControls(session);
            return null;
        }

        const stringifySpy = vi.spyOn(JSON, 'stringify');
        const stringifyObjectCalls = () => stringifySpy.mock.calls.filter((call) => typeof call[0] === 'object' && call[0] !== null);
        const firstSession = claudeModelSession({ title: 'First' });
        let root!: ReturnType<typeof create>;
        act(() => {
            root = create(React.createElement(Harness, { session: firstSession }));
        });
        roots.push(root);

        const initialScope = controls.scope;
        const initialModels = controls.models;
        const initialEfforts = controls.efforts;
        const initialRefresh = controls.refresh;
        expect(stringifyObjectCalls()).toHaveLength(0);

        // Cloned session with new object references for metadata, compatibility, scope, models, and efforts, plus changed title.
        const secondSession = claudeModelSession({ title: 'Second' });
        act(() => {
            root.update(React.createElement(Harness, { session: secondSession }));
        });
        expect(controls.scope).toBe(initialScope);
        expect(controls.models).toBe(initialModels);
        expect(controls.efforts).toBe(initialEfforts);
        expect(controls.refresh).toBe(initialRefresh);
        expect(stringifyObjectCalls()).toHaveLength(0);

        // When settingsToken changes in scope, `scope` and `refresh` update while unchanged `models` and `efforts` keep their references.
        const rotatedScopeSession = claudeModelSession({ settingsToken: 'b'.repeat(64) });
        act(() => {
            root.update(React.createElement(Harness, { session: rotatedScopeSession }));
        });
        expect(controls.scope).not.toBe(initialScope);
        expect(controls.refresh).not.toBe(initialRefresh);
        expect(controls.models).toBe(initialModels);
        expect(controls.efforts).toBe(initialEfforts);
        expect(stringifyObjectCalls()).toHaveLength(0);

        // Changing canUnsetReasoningEffort updates `efforts` while leaving `models` and `scope` untouched.
        const prevScopeAfterRotation = controls.scope;
        const unsetSession = claudeModelSession({ settingsToken: 'b'.repeat(64), canUnset: true });
        act(() => {
            root.update(React.createElement(Harness, { session: unsetSession }));
        });
        expect(controls.scope).toBe(prevScopeAfterRotation);
        expect(controls.models).toBe(initialModels);
        expect(controls.efforts).not.toBe(initialEfforts);
        expect(controls.efforts[0]).toEqual({ key: '__default__', name: 'codelyncModels.default' });
        expect(stringifyObjectCalls()).toHaveLength(0);
    });
});
