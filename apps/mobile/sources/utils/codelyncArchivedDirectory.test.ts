import { describe, expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { MetadataSchema } from '@/sync/storageTypes';
import { buildCodelyncBrowserRows, isCodelyncNativeSession } from './codelyncSessionBrowser';

function session(id: string, archived: boolean): Session {
    return { id, createdAt: 1, updatedAt: 2, metadata: { path: '/fixture/project', machineId: 'fixture-mac',
        bridge: { controlMode: 'session', source: { app: 'antigravity', id, hostId: 'local:antigravity:' + 'a'.repeat(64),
            kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: 'fixture-owner' } },
        nativeSession: { title: id, updatedAt: 2, parentId: null, agentName: '', preview: '', isPinned: false,
            projectKey: 'fixture-project', projectPath: '/fixture/project', projectLabel: 'project', archived, catalogueAvailable: true } } } as Session;
}

describe('archived native directory visibility', () => {
    it('excludes confirmed archived sessions from project counts and every search result without deleting their data', () => {
        const active = session('active', false), archived = session('archived', true);
        expect([active, archived].filter(isCodelyncNativeSession)).toEqual([active]);
        expect(buildCodelyncBrowserRows([active, archived], '', new Set(), new Set())).toEqual([
            expect.objectContaining({ kind: 'project', count: 1, label: 'project' }),
        ]);
        expect(buildCodelyncBrowserRows([active, archived], 'archived', new Set(), new Set())).toEqual([]);
        expect(archived.metadata?.nativeSession?.archived).toBe(true);
    });
    it('retains the archive signal through the real metadata schema while legacy records remain compatible', () => {
        const parsed = MetadataSchema.pick({ nativeSession: true }).parse(session('archived', true).metadata);
        expect(parsed.nativeSession?.archived).toBe(true);
        const legacy = session('legacy', false); delete legacy.metadata!.nativeSession!.archived;
        expect(isCodelyncNativeSession(legacy)).toBe(true);
    });
});
