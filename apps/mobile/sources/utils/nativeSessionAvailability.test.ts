import { expect, it } from 'vitest';
import { nativeSessionAvailability } from './nativeSessionAvailability';
import type { Session } from '@/sync/storageTypes';
const input = { nativeProduct: true, ready: true, pending: false, directoryPhase: 'complete', session: null };
it('does not claim permanent deletion from a missing or retired native directory entry', () => {
    expect(nativeSessionAvailability(input)).toBe('unavailable');
    const retired = { metadata: { client: { id: 'noninvasive-bridge' }, nativeSession: { catalogueAvailable: false } } } as Session;
    expect(nativeSessionAvailability({ ...input, session: retired })).toBe('unavailable');
});
it('keeps loading and pending creation distinct from unavailable and legacy deletion', () => {
    expect(nativeSessionAvailability({ ...input, directoryPhase: 'loading' })).toBe('loading');
    expect(nativeSessionAvailability({ ...input, pending: true })).toBe('available');
    expect(nativeSessionAvailability({ ...input, nativeProduct: false })).toBe('legacy-missing');
    expect(nativeSessionAvailability({ ...input, ready: false })).toBe('loading');
});
it('retains ordinary available native and legacy sessions', () => {
    expect(nativeSessionAvailability({ ...input, session: { metadata: null } as Session })).toBe('available');
});
