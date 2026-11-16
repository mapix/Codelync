import * as React from 'react';
// @ts-expect-error Existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
vi.mock('react-native', () => ({ View: 'View', Text: 'Text' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { textSecondary: 'gray', groupped: { background: 'white' } } } }) }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en' }));
import { NativeSavedHistoryBanner } from './NativeSavedHistoryBanner';
const session = { metadata: { client: { id: 'noninvasive-bridge' }, bridge: { controlMode: 'session', sourceStatus: 'history-only', currentTurnId: null,
    source: { app: 'codex', id: 'native', hostId: 'local', runtimeGeneration: null } }, nativeSavedHistory: {
    app: 'codex', version: 1, available: true, readOnly: true, originator: 'Codex Desktop', nativeId: 'native', hostId: 'local',
    namespaceHash: 'a'.repeat(64), sourceStamp: 'b'.repeat(64), byteBoundary: { start: 0, end: 4, total: 4 } } } } as unknown as Session;
it('labels verified saved data without fabricating current-owner controls or failure', () => {
    let view!: ReturnType<typeof create>;
    act(() => { view = create(React.createElement(NativeSavedHistoryBanner, { session })); });
    expect(view.root.findByType('Text').props.children).toBe('Saved messages · Read only');
    expect(view.root.findAllByType('Button')).toHaveLength(0);
    const changed = structuredClone(session); changed.metadata!.bridge!.source.runtimeGeneration = 'live-owner';
    act(() => view.update(React.createElement(NativeSavedHistoryBanner, { session: changed })));
    expect(view.root.findAllByType('Text')).toHaveLength(0); act(() => view.unmount());
});
