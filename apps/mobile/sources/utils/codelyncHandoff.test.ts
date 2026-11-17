import { expect, it } from 'vitest';
import type { Session } from '../sync/storageTypes';
import type { AgentTextMessage } from '../sync/typesMessage';
import { createCodelyncHandoff, codelyncHandoffTargets, prepareCodelyncHandoffDraft } from './codelyncHandoff';

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
    const handoff = createCodelyncHandoff(source, message)!;
    expect(codelyncHandoffTargets(handoff, [source, target, sameApp, otherMac])).toEqual([target]);
    const reverse = createCodelyncHandoff(target, message)!;
    expect(codelyncHandoffTargets(reverse, [source, target])).toEqual([source]);
});

it('preserves the latest destination draft verbatim and original native provenance', () => {
    const source = session('source', 'codex'), target = session('target', 'antigravity');
    const handoff = createCodelyncHandoff(source, message)!;
    target.draft = 'My existing instruction  \n';
    const draft = prepareCodelyncHandoffDraft(handoff, source, target)!;
    expect(draft.startsWith(target.draft + '\n\n---\n\n')).toBe(true);
    expect(draft).toContain('"nativeConversationId": "same-native"');
    expect(draft).toContain('"id": "original-item-id"');
    expect(draft).toContain('"offset": 20');
    expect(draft).toContain('"revision": 2');
    expect(draft).not.toContain('encrypted-projection-id');
    expect(source.draft).toBeNull();
});

it('prepares an identical handoff once without changing source or dispatching work', () => {
    const source = session('source', 'codex'), target = session('target', 'antigravity'), handoff = createCodelyncHandoff(source, message)!;
    const first = prepareCodelyncHandoffDraft(handoff, source, target)!;
    expect(target.draft).toBeNull();
    target.draft = first;
    expect(prepareCodelyncHandoffDraft(handoff, source, target)).toBe(first);
    message.text = 'Changed after selection';
    expect(first).toContain('Verified artifact result');
    expect(first).not.toContain('Changed after selection');
    message.text = 'Verified artifact result';
});

it('rejects unavailable/unknown/window targets and stale source owner namespaces', () => {
    const source = session('source', 'codex'), target = session('target', 'antigravity'), handoff = createCodelyncHandoff(source, message)!;
    const invalid = structuredClone(target);
    invalid.metadata!.bridge!.source.protocol = 'unknown';
    expect(prepareCodelyncHandoffDraft(handoff, source, invalid)).toBeNull();
    invalid.metadata!.bridge!.source.protocol = 'antigravity-connect';
    invalid.metadata!.bridge!.source.kind = 'window';
    expect(prepareCodelyncHandoffDraft(handoff, source, invalid)).toBeNull();
    target.metadata!.bridge!.sourceStatus = 'owner-unavailable';
    expect(prepareCodelyncHandoffDraft(handoff, source, target)).not.toBeNull();
    target.metadata!.nativeSession!.archived = true;
    expect(prepareCodelyncHandoffDraft(handoff, source, target)).toBeNull();
    target.metadata!.nativeSession!.archived = false;
    target.metadata!.nativeSession!.catalogueAvailable = false;
    expect(prepareCodelyncHandoffDraft(handoff, source, target)).toBeNull();
    target.metadata!.nativeSession!.catalogueAvailable = true;
    target.metadata!.bridge!.sourceStatus = 'connected';
    source.metadata!.bridge!.source.runtimeGeneration = 'restarted';
    expect(prepareCodelyncHandoffDraft(handoff, source, target)).toBeNull();
    source.metadata!.bridge!.source.runtimeGeneration = 'codex-owner-1';
    source.metadata!.bridge!.source.hostId = 'different-native-host';
    expect(prepareCodelyncHandoffDraft(handoff, source, target)).toBeNull();
});

it('requires an original assistant row rather than display IDs, thinking or missing owners', () => {
    const source = session('source', 'codex');
    expect(createCodelyncHandoff(source, { ...message, meta: undefined })).toBeNull();
    expect(createCodelyncHandoff(source, { ...message, isThinking: true })).toBeNull();
    expect(createCodelyncHandoff(source, { ...message, text: '' })).toBeNull();
    source.metadata!.bridge!.source.runtimeGeneration = null;
    expect(createCodelyncHandoff(source, message)).toBeNull();
});

it('does not merge drafts between separate Antigravity namespaces with the same native ID', () => {
    const source = session('source', 'codex'), original = session('agy-original', 'antigravity'), probe = session('agy-probe', 'antigravity');
    probe.metadata!.bridge!.source.hostId = 'local:antigravity:' + 'b'.repeat(64);
    original.draft = 'Original task'; probe.draft = 'Probe task';
    const handoff = createCodelyncHandoff(source, message)!;
    expect(codelyncHandoffTargets(handoff, [original, probe]).map(s => s.id)).toEqual(['agy-original', 'agy-probe']);
    expect(prepareCodelyncHandoffDraft(handoff, source, probe)).toMatch(/^Probe task\n/);
    expect(original.draft).toBe('Original task');
});

it('offers ordinary target conversations and forks, excluding read-only native children', () => {
    const source = session('source', 'codex'), parent = session('parent', 'antigravity'), child = session('child', 'antigravity'), fork = session('fork', 'antigravity');
    child.metadata!.nativeSession!.isSubagent = true; child.draft = 'Retained child draft';
    fork.metadata!.nativeSession!.parentId = 'native-parent';
    const handoff = createCodelyncHandoff(source, message)!;
    expect(codelyncHandoffTargets(handoff, [child, parent, fork]).map(item => item.id)).toEqual(['parent', 'fork']);
    expect(prepareCodelyncHandoffDraft(handoff, source, child)).toBe(null);
    expect(child.draft).toBe('Retained child draft');
});
