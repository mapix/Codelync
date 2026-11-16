import { expect, it } from 'vitest';
import { CodeLightActivationGate } from './codeLightActivationGate';

it('deduplicates only concurrent entries and reattaches an observer retired under the same native owner', async () => {
    const gate = new CodeLightActivationGate(); let calls = 0;
    const start = async () => { calls++; return 'connected'; };
    await Promise.all([gate.run('account:owner1', start), gate.run('account:owner1', start)]);
    await gate.run('account:owner1', start); expect(calls).toBe(2);
    await gate.run('account:owner2', start); expect(calls).toBe(3);
});
it('does not remember rejected activation as successful', async () => {
    const gate = new CodeLightActivationGate();
    await expect(gate.run('owner', async () => { throw Error('offline'); })).rejects.toThrow('offline');
    await expect(gate.run('owner', async () => 'connected')).resolves.toBe('connected');
});
