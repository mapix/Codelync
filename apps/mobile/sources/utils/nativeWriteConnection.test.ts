import { expect, it } from 'vitest';
import { nativeWriteConnectionBlocked } from './nativeWriteConnection';
import type { Metadata } from '@/sync/storageTypes';
it.each(['codex', 'antigravity', 'claude-desktop'])('native %s writes require a connected socket independently of fresh metadata', app => {
    const metadata = { client: { id: 'noninvasive-bridge' }, bridge: { sourceStatus: 'connected', source: { app } } } as Metadata;
    expect(nativeWriteConnectionBlocked(metadata, false)).toBe(true);
    expect(nativeWriteConnectionBlocked(metadata, true)).toBe(false);
});
it('ordinary legacy source behavior stays independent of this native connection gate', () => {
    expect(nativeWriteConnectionBlocked({ flavor: 'codex' } as Metadata, false)).toBe(false);
    expect(nativeWriteConnectionBlocked(null, false)).toBe(false);
});
