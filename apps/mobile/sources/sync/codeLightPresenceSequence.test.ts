import { expect, it } from 'vitest';
import { CodeLightPresenceSequence } from './codeLightPresenceSequence';

function memory() {
    const values = new Map<string, string>();
    return { values, store: { getItem: async (key: string) => values.get(key) ?? null, setItem: async (key: string, value: string) => { values.set(key, value); } } };
}
it('serializes concurrent viewer sequences and persists monotonic ordering across app reloads', async () => {
    const f = memory(), sequences = new CodeLightPresenceSequence(f.store);
    expect(await Promise.all([sequences.next('peer:mac-a'), sequences.next('peer:mac-a')])).toEqual([1, 2]);
    expect(await new CodeLightPresenceSequence(f.store).next('peer:mac-a')).toBe(3);
    expect(await sequences.next('peer:mac-b')).toBe(1);
    expect([...f.values.keys()]).toEqual(['codelight-presence-sequence-v1:peer:mac-a', 'codelight-presence-sequence-v1:peer:mac-b']);
});
it('a failed durable sequence cannot silently reset or send an unordered viewer', async () => {
    const f = memory();
    f.values.set('codelight-presence-sequence-v1:peer:mac-a', 'invalid');
    await expect(new CodeLightPresenceSequence(f.store).next('peer:mac-a')).rejects.toThrow('Invalid foreground sequence');
    expect(f.values.get('codelight-presence-sequence-v1:peer:mac-a')).toBe('invalid');
});
