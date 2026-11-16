import { expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { nativeSessionReadNotice } from './nativeSessionReadNotice';
const session = (status = 'connected', cached = false) => ({ id: 'fixture', metadata: { client: { id: 'noninvasive-bridge' },
    bridge: { controlMode: 'session', sourceStatus: status, source: { app: 'codex', kind: 'session', hostId: 'local', id: 'native-id', runtimeGeneration: 'owner' } },
    ...(cached ? { nativeReadFreshness: { version: 1, mode: 'cached', currentControlAuthority: false, ownerGeneration: 'owner' } } : {}) } } as unknown as Session);
it('keeps read progress independent of connection state and preserves explicit source failures', () => {
    expect(nativeSessionReadNotice(session('locked'), { generation: 0, found: 0, pages: 0, phase: 'loading' })).toBe('checking');
    expect(nativeSessionReadNotice(session(), { generation: 0, found: 0, pages: 0, phase: 'error' })).toBe('read-failed');
    expect(nativeSessionReadNotice(session('locked'), { generation: 0, found: 0, pages: 0, phase: 'complete' })).toBe('source-unavailable');
    expect(nativeSessionReadNotice(session(), { generation: 0, found: 0, pages: 0, phase: 'complete' }, 'failed')).toBeNull();
    expect(nativeSessionReadNotice(session(), { generation: 0, found: 0, pages: 0, phase: 'idle' }, 'failed')).toBe('read-failed');
});
it('cached confirmation does not become a genuine unavailable-source result', () => {
    expect(nativeSessionReadNotice(session('owner-unavailable', true), { generation: 0, found: 0, pages: 0, phase: 'complete' })).toBeNull();
    expect(nativeSessionReadNotice(session('owner-unavailable', true), { generation: 0, found: 0, pages: 0, phase: 'complete', revalidating: true })).toBe('checking');
    expect(nativeSessionReadNotice(session('owner-unavailable', true), { generation: 0, found: 0, pages: 0, phase: 'complete', revalidationFailed: true })).toBe('read-failed');
});
it('missing source proof does not fabricate an unavailable-source error', () => {
    expect(nativeSessionReadNotice(null, { generation: 0, found: 0, pages: 0, phase: 'complete' })).toBeNull();
    expect(nativeSessionReadNotice(session('unconfirmed'), { generation: 0, found: 0, pages: 0, phase: 'complete' })).toBeNull();
});
