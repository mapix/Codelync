import * as React from 'react';
// @ts-expect-error The native renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Session, NativeModelControlScope } from '@/sync/storageTypes';
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Button', ScrollView: 'Scroll', Modal: (p: any) => p.visible ? React.createElement('Modal', p, p.children) : null,
    AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({}) }, useUnistyles: () => ({ theme: { colors: {} } }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/sync/apiSocket', () => ({ getCurrentAppState: () => 'active' }));
vi.mock('@/text', () => ({ t: (key: string) => key, getCurrentLanguage: () => 'en' }));
import { NativeReadonlyModelCatalog } from './NativeReadonlyModelCatalog';

function fixture() {
    const scope: NativeModelControlScope = { app: 'claude-desktop', appMode: 'code', nativeCollection: 'claude-code-sessions', nativeConversationId: 'native',
        hostId: 'local:claude-desktop:' + 'a'.repeat(64), ownerGeneration: 'owner', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli', settingsToken: 'b'.repeat(64) };
    const session = { id: 'relay', metadata: { client: { id: 'noninvasive-bridge' }, nativeDesktopRuntimeGeneration: 'main', capabilities: { readOnly: true },
        bridge: { currentTurnId: null, controlMode: 'session', sourceStatus: 'connected', source: { app: scope.app, appMode: scope.appMode, nativeCollection: scope.nativeCollection,
            id: scope.nativeConversationId, hostId: scope.hostId, kind: 'session', protocol: 'claude-desktop-native', runtimeGeneration: scope.ownerGeneration } },
        nativeControls: { scope, model: { available: false, catalogAvailable: true, currentConfirmed: true, current: { model: 'native-effective', reasoningEffort: 'max' },
            models: [{ id: 'default', label: 'Original default', nativeResolvedModel: 'native-effective', reasoningEfforts: ['max'], canUnsetReasoningEffort: false }] } } },
        agentState: { nativeQuery: { version: 1, app: scope.app, nativeConversationId: scope.nativeConversationId, hostId: scope.hostId, ownerGeneration: scope.ownerGeneration,
            queryToken: scope.queryToken, status: 'idle', canSend: false, canCancel: false, activeSendMode: 'unverified' } } } as unknown as Session;
    return { scope, session };
}
it('shows native labels without a setter and renders every catalog option disabled', () => {
    const { scope, session } = fixture(), close = vi.fn(); let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(NativeReadonlyModelCatalog, { session, captured: scope, active: true, onClose: close })); });
    const row = screen.root.findByProps({ testID: 'codelight-native-model-catalog:default' });
    expect(row.props.disabled).toBe(true); expect(row.props.onPress).toBeUndefined(); expect(row.props.accessibilityLabel).toBe('Original default');
    act(() => screen.unmount());
});
it('closes on native settings token change or inactive navigation without any setting RPC', () => {
    const { scope, session } = fixture(), close = vi.fn(); let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(NativeReadonlyModelCatalog, { session, captured: { ...scope }, active: true, onClose: close })); });
    session.metadata!.nativeControls!.scope!.settingsToken = 'c'.repeat(64);
    act(() => screen.update(React.createElement(NativeReadonlyModelCatalog, { session, captured: { ...scope, settingsToken: 'b'.repeat(64) }, active: true, onClose: close })));
    expect(close).toHaveBeenCalled(); expect(screen.root.findAllByProps({ testID: 'codelight-native-model-catalog' })).toHaveLength(0);
    act(() => screen.unmount());
});
