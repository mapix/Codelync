import { expect, it } from 'vitest';
import { readNativeObservedModel } from './nativeObservedModel';

function fixture() {
    const hostId = 'local:claude-desktop:' + 'b'.repeat(64);
    return { metadata: { client: { id: 'noninvasive-bridge' }, bridge: { controlMode: 'session', sourceStatus: 'connected', currentTurnId: null,
        source: { app: 'claude-desktop', id: 'original', hostId, runtimeGeneration: 'owner', kind: 'session', protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions' } },
        nativeObservedModel: { version: 1, app: 'claude-desktop', nativeConversationId: 'original', hostId, ownerGeneration: 'owner', readOnly: true,
            model: 'native-model', effort: 'high' } } } as any;
}
it('returns exact readonly original model/effort and preserves unknown values without defaults', () => {
    const session = fixture(); expect(readNativeObservedModel(session)).toMatchObject({ model: 'native-model', effort: 'high', readOnly: true });
    session.metadata.nativeObservedModel.model = null; session.metadata.nativeObservedModel.effort = null;
    expect(readNativeObservedModel(session)).toMatchObject({ model: null, effort: null });
});
it('rejects a different native source, owner or unsupported observation without affecting controls', () => {
    for (const change of [{ nativeConversationId: 'foreign' }, { hostId: 'foreign' }, { ownerGeneration: 'old-owner' }, { readOnly: false }, { model: ' ' }, { effort: 'x'.repeat(129) }]) {
        const session = fixture(); Object.assign(session.metadata.nativeObservedModel, change);
        expect(readNativeObservedModel(session)).toBeNull();
    }
    const session = fixture(); session.metadata.bridge.sourceStatus = 'disconnected';
    expect(readNativeObservedModel(session)).toBeNull();
});
