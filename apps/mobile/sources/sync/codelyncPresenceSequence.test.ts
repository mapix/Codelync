import { expect, it } from 'vitest';
import { CodelyncPresenceSequence } from './codelyncPresenceSequence';

function memory() {
    const values = new Map<string, string>();
    return { values, store: { getItem: async (key: string) => values.get(key) ?? null, setItem: async (key: string, value: string) => { values.set(key, value); } } };
}
it('serializes concurrent viewer sequences and persists monotonic ordering across app reloads', async () => {
    const f = memory(), sequences = new CodelyncPresenceSequence(f.store);
    expect(await Promise.all([sequences.next('peer:mac-a'), sequences.next('peer:mac-a')])).toEqual([1, 2]);
    expect(await new CodelyncPresenceSequence(f.store).next('peer:mac-a')).toBe(3);
    expect(await sequences.next('peer:mac-b')).toBe(1);
    expect([...f.values.keys()]).toEqual(['codelync-presence-sequence-v1:peer:mac-a', 'codelync-presence-sequence-v1:peer:mac-b']);
});
it('a failed durable sequence cannot silently reset or send an unordered viewer', async () => {
    const f = memory();
    f.values.set('codelync-presence-sequence-v1:peer:mac-a', 'invalid');
    await expect(new CodelyncPresenceSequence(f.store).next('peer:mac-a')).rejects.toThrow('Invalid foreground sequence');
    expect(f.values.get('codelync-presence-sequence-v1:peer:mac-a')).toBe('invalid');
});
