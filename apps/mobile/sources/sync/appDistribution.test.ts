import { describe, expect, it } from 'vitest';
import { resolveNativeSourceMode } from './appDistribution';

describe('native Codelync distribution boundary', () => {
    it('does not fall back to the historical flat list/full history path when the manifest is missing or stale', () => {
        expect(resolveNativeSourceMode('com.learnings.codelync', undefined)).toBe(true);
        expect(resolveNativeSourceMode('com.learnings.codelync', false)).toBe(true);
        expect(resolveNativeSourceMode('com.learnings.codelync', true)).toBe(true);
    });
    it('retains explicit development/web/other product configuration without pretending it is the native Codelync identity', () => {
        expect(resolveNativeSourceMode('com.slopus.happydev', false)).toBe(false);
        expect(resolveNativeSourceMode(null, undefined)).toBeUndefined();
        expect(resolveNativeSourceMode(null, true)).toBe(true);
    });
});
