import { expect, it } from 'vitest';
import type { Message } from '../sync/typesMessage';
import type { Session } from '../sync/storageTypes';
import { nativeMessageDeliveryLog } from './nativeMessageDeliveryLog';
const session = { id: 'child', metadata: { machineId: 'mac', capabilities: { messageReceipts: true }, bridge: { source: { app: 'codex', id: 'native-child', hostId: 'local', runtimeGeneration: 'new-owner' } } } } as Session;
const base = { kind: 'user-text', id: 'message', localId: 'local-id', createdAt: 3, text: 'PRIVATE_BODY', deliveryUnconfirmed: true, pending: true } as Message;
it('shows unknown delivery without fabricating an old dispatch owner or copying the body', () => {
    const rows = nativeMessageDeliveryLog([base], session);
    expect(rows[0]).toMatchObject({ id: 'local-message:local-id', status: 'unknown', context: null });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_BODY'); expect(JSON.stringify(rows)).not.toContain('new-owner');
});
it('retains an immutable original context and excludes another native child', () => {
    const context = { version: 1, app: 'codex', nativeConversationId: 'native-child', hostId: 'local', machineId: 'mac', ownerGeneration: 'old-owner' };
    const message = { ...base, meta: { nativeDispatchContext: context } } as Message;
    expect(nativeMessageDeliveryLog([message], session)[0].context?.ownerGeneration).toBe('old-owner');
    expect(nativeMessageDeliveryLog([{ ...message, meta: { nativeDispatchContext: { ...context, nativeConversationId: 'other-child' } } } as Message], session)).toEqual([]);
});
