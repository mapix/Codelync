import { describe, expect, it } from 'vitest';
import { MetadataSchema, type Metadata } from '@/sync/storageTypes';
import { rigMetadataFixture } from '@/sync/__testdata__/rigMetadata';
import { nativeComposerInputReadOnly } from './nativeComposerInputReadOnly';

function parent(readOnly: boolean | undefined = true) {
    return { draft: 'PRESERVED_LOCAL_DRAFT', metadata: MetadataSchema.parse({
        ...rigMetadataFixture,
        client: { id: 'noninvasive-bridge', name: 'CodeLight', version: '0.6.0' },
        bridge: { version: 1, controlMode: 'session', sourceStatus: 'connected', currentTurnId: null,
            source: { app: 'claude-desktop', id: 'native-parent', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
                kind: 'session', protocol: 'claude-desktop-native', appMode: 'code', nativeCollection: 'claude-code-sessions',
                runtimeGeneration: 'original-owner', windowGeneration: null } },
        nativeSession: { title: 'Parent', updatedAt: 1, parentId: null, agentName: '', preview: '', isPinned: false, isSubagent: false },
        capabilities: { ...rigMetadataFixture.capabilities, readOnly },
    }) };
}

describe('explicit original-owner readonly composer policy', () => {
    it('restricts an ordinary verified readonly parent without changing its draft', () => {
        const session = parent();
        expect(nativeComposerInputReadOnly(session)).toBe(true);
        expect(session.draft).toBe('PRESERVED_LOCAL_DRAFT');
        session.metadata.bridge!.sourceStatus = 'disconnected';
        session.metadata.bridge!.source.runtimeGeneration = null;
        expect(nativeComposerInputReadOnly(session)).toBe(true);
    });

    it('does not infer readonly policy from temporarily unavailable controls or model observation', () => {
        const session = parent();
        delete session.metadata.capabilities!.readOnly;
        session.metadata.capabilities!.send = false;
        session.metadata.capabilities!.abort = false;
        session.metadata.bridge!.sourceStatus = 'disconnected';
        session.metadata.bridge!.source.runtimeGeneration = null;
        session.metadata.nativeObservedModel = { readOnly: true } as Metadata['nativeObservedModel'];
        session.metadata.nativeQuery = { canSend: false, canCancel: false } as Metadata['nativeQuery'];
        expect(nativeComposerInputReadOnly(session)).toBe(false);
        session.metadata.capabilities!.readOnly = true;
        expect(nativeComposerInputReadOnly(session)).toBe(true);
        session.metadata.capabilities!.readOnly = false;
        expect(nativeComposerInputReadOnly(session)).toBe(false);
    });

    it.each([
        { client: 'other-client' }, { controlMode: 'window' }, { kind: 'window' },
        { protocol: 'unverified' }, { hostId: 'local' }, { nativeCollection: 'local-agent-mode-sessions' },
        { id: '' }, { appMode: 'unknown' },
    ])('requires exact original source identity for policy %j', patch => {
        const session = parent(), metadata = session.metadata;
        const { client, controlMode, ...source } = patch;
        if (client) metadata.client!.id = client;
        if (controlMode) Object.assign(metadata.bridge!, { controlMode });
        Object.assign(metadata.bridge!.source, source);
        expect(nativeComposerInputReadOnly(session)).toBe(false);
    });

    it('retains the independent native-child restriction under an explicit writable parent policy', () => {
        const session = parent(false);
        session.metadata.nativeSession!.isSubagent = true;
        expect(nativeComposerInputReadOnly(session)).toBe(true);
    });

    it('retains the independent saved-native-history restriction', () => {
        const session = parent(false), metadata = session.metadata;
        Object.assign(metadata.bridge!.source, { app: 'codex', hostId: 'local', runtimeGeneration: null });
        metadata.bridge!.sourceStatus = 'history-only';
        metadata.nativeSavedHistory = { app: 'codex', version: 1, available: true, readOnly: true,
            originator: 'Codex Desktop', nativeId: 'native-parent', hostId: 'local', namespaceHash: 'b'.repeat(64),
            sourceStamp: 'c'.repeat(64), byteBoundary: { start: 0, end: 10, total: 10 } };
        expect(nativeComposerInputReadOnly(session)).toBe(true);
    });
});

describe('mobile owner capabilities parsing', () => {
    it('retains explicit readonly policy and bounded version-1 task controls', () => {
        const metadata = parent().metadata;
        const controls = { version: 1, outputTaskTypes: Array.from({ length: 8 }, (_, i) => `type-${i}`), stopTaskTypes: ['shell'] };
        const parsed = MetadataSchema.parse({ ...metadata, capabilities: { ...metadata.capabilities, nativeTaskControls: controls } });
        expect(parsed.capabilities?.readOnly).toBe(true);
        expect(parsed.capabilities?.nativeTaskControls).toEqual(controls);
    });

    it.each([
        { version: 2, outputTaskTypes: [], stopTaskTypes: [] },
        { version: 1, outputTaskTypes: Array(9).fill('shell'), stopTaskTypes: [] },
        { version: 1, outputTaskTypes: [], stopTaskTypes: [''] },
    ])('drops unsupported task controls without dropping readable readonly metadata', controls => {
        const metadata = parent().metadata;
        const parsed = MetadataSchema.parse({ ...metadata, capabilities: { ...metadata.capabilities, nativeTaskControls: controls } });
        expect(parsed.capabilities?.nativeTaskControls).toBeUndefined();
        expect(nativeComposerInputReadOnly({ metadata: parsed })).toBe(true);
    });

    it('rejects a non-boolean readonly marker', () => {
        const metadata = parent().metadata;
        expect(MetadataSchema.safeParse({ ...metadata, capabilities: { ...metadata.capabilities, readOnly: 'true' } }).success).toBe(false);
    });
});
