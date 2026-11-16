import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { rpcTarget } from '@slopus/happy-wire/codelight';
import { ScopedNoninvasiveRpc } from './scopedNoninvasiveRpc';
import type { BridgeRpcReply } from './noninvasiveRpcJournal';
import { confirmedNativeModelRpcReceipt } from '@/utils/nativeModelControls';

const scope = { app: 'claude-desktop', appMode: 'code', nativeCollection: 'claude-code-sessions', nativeConversationId: 'original-native',
    hostId: 'local:claude-desktop:' + 'a'.repeat(64), ownerGeneration: 'owner', runtimeGeneration: 'main', queryToken: 'query', cliSessionId: 'cli', settingsToken: 'a'.repeat(64) };
const params = { model: 'native-alias', reasoningEffort: 'high', expectedModel: 'old-native', expectedReasoningEffort: 'low', expectedScope: scope };
function confirmed() {
    const after = { ...scope, settingsToken: 'b'.repeat(64) };
    return { applied: true, settingsReadbackConfirmed: true, controls: { scope: after, model: { current: { model: 'native-effective', reasoningEffort: 'high' } } },
        nativeSettingsEvidence: { version: 1, expectedScope: scope, confirmedScope: after, modelAckConfirmed: true, effortAckConfirmed: true,
            effectiveModel: 'native-effective', effectiveReasoningEffort: 'high' } };
}
function fixture() {
    const values = new Map<string, string>();
    const id = vi.fn(() => 'original-native-command');
    const rpc = vi.fn(async (_id: string, _method: string, _params: unknown, _origin: string): Promise<BridgeRpcReply> => ({ receipt: null }));
    const makeClient = () => new ScopedNoninvasiveRpc({ storage: { getItem: async key => values.get(key) ?? null,
        setItem: async (key, value) => { values.set(key, value); }, removeItem: async key => { values.delete(key); }, getAllKeys: async () => [...values.keys()] },
        keyPrefix: 'model:', serverUrl: () => 'https://fixture.invalid', identity: () => 'peer:fixture', id, rpc,
        digest: async value => createHash('sha256').update(value).digest('hex'),
        validateComplete: (pending, result) => confirmedNativeModelRpcReceipt(pending.target, result) });
    return { values, id, rpc, makeClient, pending: () => [...values].filter(([key]) => !key.endsWith(':diagnostics')).map(([, value]) => value) };
}

it.each(['missing', 'partial-ack', 'foreign-query', 'wrong-readback'])('retains %s native proof under the original ID across execution, remount and receipt-only recovery', async kind => {
    const f = fixture(), result = confirmed();
    if (kind === 'missing') delete (result as any).nativeSettingsEvidence;
    if (kind === 'partial-ack') result.nativeSettingsEvidence.effortAckConfirmed = false;
    if (kind === 'foreign-query') result.nativeSettingsEvidence.confirmedScope.queryToken = 'other-query';
    if (kind === 'wrong-readback') result.controls.model.current.model = 'other-native';
    f.rpc.mockResolvedValue({ receipt: { id: 'original-native-command', status: 'complete', result } });
    const original = f.makeClient();
    await expect(original.execute('relay', 'codex-controls-update', params)).rejects.toMatchObject({ name: 'BridgeRpcUnconfirmedError', commandId: 'original-native-command' });
    const saved = f.pending()[0]; expect(saved).toBeTruthy();
    const remounted = f.makeClient();
    await expect(remounted.recoverDetailed('relay', 'codex-controls-update', params)).rejects.toMatchObject({ commandId: 'original-native-command' });
    await expect(remounted.execute('relay', 'codex-controls-update', params)).rejects.toMatchObject({ commandId: 'original-native-command' });
    expect(f.pending()).toEqual([saved]); expect(f.id).toHaveBeenCalledOnce();
    expect(f.rpc.mock.calls.map(call => call[1])).toEqual(['codex-controls-update', 'bridge-receipt', 'bridge-receipt']);
    f.rpc.mockResolvedValue({ receipt: { id: 'original-native-command', status: 'complete', result: confirmed() } });
    const recovered = await remounted.recoverDetailed('relay', 'codex-controls-update', params);
    expect(recovered.confirmed).toBe(true); expect(recovered.pending?.commandId).toBe('original-native-command'); expect(f.pending()).toEqual([]);
    expect(f.id).toHaveBeenCalledOnce(); expect(f.rpc.mock.calls.filter(call => call[1] === 'codex-controls-update')).toHaveLength(1);
});

it('terminal native rejection clears its ID while legacy Codex/Antigravity complete receipts keep their existing confirmation', async () => {
    const f = fixture(), client = f.makeClient();
    f.rpc.mockResolvedValueOnce({ receipt: { id: 'original-native-command', status: 'failed', error: 'native-rejected' } });
    await expect(client.execute('relay', 'codex-controls-update', params)).rejects.toThrow('native-rejected'); expect(f.pending()).toEqual([]);
    f.rpc.mockResolvedValue({ receipt: { id: 'original-native-command', status: 'complete', result: { applied: true } } });
    await expect(client.execute('legacy-relay', 'codex-controls-update', { model: 'legacy', reasoningEffort: null })).resolves.toEqual({ applied: true });
    expect(f.pending()).toEqual([]);
});

it('a malformed native-settings target cannot be treated as a legacy receipt or recover without an exact captured scope', () => {
    const target = JSON.parse(rpcTarget('codex-controls-update', params)); target.pop();
    expect(confirmedNativeModelRpcReceipt(JSON.stringify(target), confirmed())).toBe(false);
    expect(confirmedNativeModelRpcReceipt('invalid-json', confirmed())).toBe(false);
    expect(confirmedNativeModelRpcReceipt(JSON.stringify(['communication', 'entity']), confirmed())).toBe(false);
});
