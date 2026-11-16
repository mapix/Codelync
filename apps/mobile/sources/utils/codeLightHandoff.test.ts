import { expect, it } from 'vitest';
import type { Session } from '../sync/storageTypes';
import type { AgentTextMessage } from '../sync/typesMessage';
import { createCodeLightHandoff, codeLightHandoffTargets, prepareCodeLightHandoffDraft } from './codeLightHandoff';

function session(id: string, app: 'codex' | 'antigravity', machineId = 'mac-a', nativeId = 'same-native'): Session {
    return { id, updatedAt: 10, draft: null, metadata: { machineId, path: '/repo/shared', client: { id: 'noninvasive-bridge' },
        nativeSession: { title: 'Shared task', catalogueAvailable: true },
        bridge: { controlMode: 'session', sourceStatus: 'connected', source: { app, id: nativeId, kind: 'session',
            hostId: app === 'codex' ? 'local' : 'local:antigravity:' + 'a'.repeat(64),
            protocol: app === 'antigravity' ? 'antigravity-connect' : undefined, runtimeGeneration: app + '-owner-1' } } } } as Session;
}
const message: AgentTextMessage = { kind: 'agent-text', id: 'encrypted-projection-id', localId: null, createdAt: 1, text: 'Verified artifact result',
    meta: { nativeRow: { id: 'original-item-id', offset: 20, revision: 2 } } };

it('keeps equal native IDs and paths isolated by exact application and Mac target', () => {
    const source = session('source-relay', 'codex'), target = session('agy-target-relay', 'antigravity'), sameApp = session('codex-target', 'codex'), otherMac = session('other-mac', 'antigravity', 'mac-b');
    const handoff = createCodeLightHandoff(source, message)!;
    expect(codeLightHandoffTargets(handoff, [source, target, sameApp, otherMac])).toEqual([target]);
    const reverse = createCodeLightHandoff(target, message)!;
    expect(codeLightHandoffTargets(reverse, [source, target])).toEqual([source]);
});

it('preserves the latest destination draft verbatim and original native provenance', () => {
    const source = session('source', 'codex'), target = session('target', 'antigravity');
    const handoff = createCodeLightHandoff(source, message)!;
    target.draft = 'My existing instruction  \n';
    const draft = prepareCodeLightHandoffDraft(handoff, source, target)!;
    expect(draft.startsWith(target.draft + '\n\n---\n\n')).toBe(true);
    expect(draft).toContain('"nativeConversationId": "same-native"');
    expect(draft).toContain('"id": "original-item-id"');
    expect(draft).toContain('"offset": 20');
    expect(draft).toContain('"revision": 2');
    expect(draft).not.toContain('encrypted-projection-id');
    expect(source.draft).toBeNull();
});

it('prepares an identical handoff once without changing source or dispatching work', () => {
    const source = session('source', 'codex'), target = session('target', 'antigravity'), handoff = createCodeLightHandoff(source, message)!;
    const first = prepareCodeLightHandoffDraft(handoff, source, target)!;
    expect(target.draft).toBeNull();
    target.draft = first;
    expect(prepareCodeLightHandoffDraft(handoff, source, target)).toBe(first);
    message.text = 'Changed after selection';
    expect(first).toContain('Verified artifact result');
    expect(first).not.toContain('Changed after selection');
    message.text = 'Verified artifact result';
});

it('rejects unavailable/unknown/window targets and stale source owner namespaces', () => {
    const source = session('source', 'codex'), target = session('target', 'antigravity'), handoff = createCodeLightHandoff(source, message)!;
    const invalid = structuredClone(target);
    invalid.metadata!.bridge!.source.protocol = 'unknown';
    expect(prepareCodeLightHandoffDraft(handoff, source, invalid)).toBeNull();
    invalid.metadata!.bridge!.source.protocol = 'antigravity-connect';
    invalid.metadata!.bridge!.source.kind = 'window';
    expect(prepareCodeLightHandoffDraft(handoff, source, invalid)).toBeNull();
    target.metadata!.bridge!.sourceStatus = 'owner-unavailable';
    expect(prepareCodeLightHandoffDraft(handoff, source, target)).not.toBeNull();
    target.metadata!.nativeSession!.archived = true;
    expect(prepareCodeLightHandoffDraft(handoff, source, target)).toBeNull();
    target.metadata!.nativeSession!.archived = false;
    target.metadata!.nativeSession!.catalogueAvailable = false;
    expect(prepareCodeLightHandoffDraft(handoff, source, target)).toBeNull();
    target.metadata!.nativeSession!.catalogueAvailable = true;
    target.metadata!.bridge!.sourceStatus = 'connected';
    source.metadata!.bridge!.source.runtimeGeneration = 'restarted';
    expect(prepareCodeLightHandoffDraft(handoff, source, target)).toBeNull();
    source.metadata!.bridge!.source.runtimeGeneration = 'codex-owner-1';
    source.metadata!.bridge!.source.hostId = 'different-native-host';
    expect(prepareCodeLightHandoffDraft(handoff, source, target)).toBeNull();
});

it('requires an original assistant row rather than display IDs, thinking or missing owners', () => {
    const source = session('source', 'codex');
    expect(createCodeLightHandoff(source, { ...message, meta: undefined })).toBeNull();
    expect(createCodeLightHandoff(source, { ...message, isThinking: true })).toBeNull();
    expect(createCodeLightHandoff(source, { ...message, text: '' })).toBeNull();
    source.metadata!.bridge!.source.runtimeGeneration = null;
    expect(createCodeLightHandoff(source, message)).toBeNull();
});

it('does not merge drafts between separate Antigravity namespaces with the same native ID', () => {
    const source = session('source', 'codex'), original = session('agy-original', 'antigravity'), probe = session('agy-probe', 'antigravity');
    probe.metadata!.bridge!.source.hostId = 'local:antigravity:' + 'b'.repeat(64);
    original.draft = 'Original task'; probe.draft = 'Probe task';
    const handoff = createCodeLightHandoff(source, message)!;
    expect(codeLightHandoffTargets(handoff, [original, probe]).map(s => s.id)).toEqual(['agy-original', 'agy-probe']);
    expect(prepareCodeLightHandoffDraft(handoff, source, probe)).toMatch(/^Probe task\n/);
    expect(original.draft).toBe('Original task');
});

it('offers ordinary target conversations and forks, excluding read-only native children', () => {
    const source = session('source', 'codex'), parent = session('parent', 'antigravity'), child = session('child', 'antigravity'), fork = session('fork', 'antigravity');
    child.metadata!.nativeSession!.isSubagent = true; child.draft = 'Retained child draft';
    fork.metadata!.nativeSession!.parentId = 'native-parent';
    const handoff = createCodeLightHandoff(source, message)!;
    expect(codeLightHandoffTargets(handoff, [child, parent, fork]).map(item => item.id)).toEqual(['parent', 'fork']);
    expect(prepareCodeLightHandoffDraft(handoff, source, child)).toBe(null);
    expect(child.draft).toBe('Retained child draft');
});
