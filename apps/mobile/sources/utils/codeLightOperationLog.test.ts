import { expect, it } from 'vitest';
import { projectCodeLightOperationLog, readCodeLightOperationTrace, type CodeLightOperationSource, type CodeLightOperationTrace } from './codeLightOperationLog';
const source: CodeLightOperationSource = { sessionId: 'child', app: 'codex', nativeConversationId: 'native-child', hostId: 'local', ownerGeneration: 'owner' };
const event = (stage: CodeLightOperationTrace['stage'], at: number, status?: string): CodeLightOperationTrace => ({ source, authority: 'peer:one', entityId: 'child', method: 'abort', commandId: 'original-command', stage, at, ...(status ? { status } : {}) });

it('distinguishes pre-dispatch failure, unknown delivery and original confirmed outcomes', () => {
    expect(projectCodeLightOperationLog([event('dispatch', 1), event('not-sent', 2)], source)[0].status).toBe('not-sent');
    expect(projectCodeLightOperationLog([event('dispatch', 1), event('transport-error', 2), event('receipt-query', 3)], source)[0].status).toBe('unknown');
    expect(projectCodeLightOperationLog([event('unconfirmed', 1), event('confirmed', 2, 'complete')], source)[0]).toMatchObject({ commandId: 'original-command', status: 'confirmed' });
    expect(projectCodeLightOperationLog([event('confirmed', 2, 'failed')], source)[0].status).toBe('failed');
    expect(projectCodeLightOperationLog([event('confirmed', 2)], source)[0].status).toBe('unknown');
});
it('does not attribute foreign connection/child logs or expose parameters', () => {
    const raw = { ...event('confirmed', 1, 'complete'), params: { text: 'private prompt', apiKey: 'secret' } };
    const value = readCodeLightOperationTrace(raw, 'peer:one', 'child');
    expect(value).not.toHaveProperty('params'); expect(JSON.stringify(value)).not.toContain('private prompt');
    expect(readCodeLightOperationTrace(raw, 'peer:other', 'child')).toBe(null);
    expect(readCodeLightOperationTrace(raw, 'peer:one', 'other-child')).toBe(null);
    expect(projectCodeLightOperationLog([event('confirmed', 1, 'complete')], { ...source, hostId: 'foreign-host' })).toEqual([]);
    expect(projectCodeLightOperationLog([event('confirmed', 1, 'complete')], { ...source, ownerGeneration: 'new-owner' })[0].historicalOwner).toBe(true);
});
