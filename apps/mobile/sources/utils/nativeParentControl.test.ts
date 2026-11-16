import { expect, it } from 'vitest';
import type { Session } from '../sync/storageTypes';
import { nativeParentControl, nativeSubagentInputReadOnly, prepareNativeParentContinuation } from './nativeParentControl';
const source = { app: 'codex', hostId: 'local', kind: 'session', runtimeGeneration: 'owner' };
function fixtures() {
    const parent = { id: 'parent', draft: 'PRESERVED_PARENT_DRAFT', metadata: { machineId: 'mac', client: { id: 'noninvasive-bridge' }, nativeSession: { catalogueAvailable: true }, bridge: { controlMode: 'session', sourceStatus: 'connected', source: { ...source, id: 'native-parent' } } }, agentState: { subagentsAvailable: true, subagents: [{ id: 'child', name: 'QA', app: 'codex', nativeConversationId: 'native-child', parentConversationId: 'native-parent', hostId: 'local', ownerGeneration: 'owner', relationship: 'native-subagent', status: 'stopped' }] } } as unknown as Session;
    const child = { id: 'child', draft: 'New reviewed continuation', metadata: { machineId: 'mac', client: { id: 'noninvasive-bridge' }, nativeSession: { parentId: 'native-parent', catalogueAvailable: true }, bridge: { controlMode: 'session', sourceStatus: 'connected', source: { ...source, id: 'native-child' } } }, agentState: { nativeInput: { available: false, reason: 'parent-owned-subagent', parentConversationId: 'native-parent', agentPath: '/root/phone_control_probe', app: 'codex', nativeConversationId: 'native-child', hostId: 'local', ownerGeneration: 'owner' } } } as unknown as Session;
    return { parent, child };
}
it('stages only the child identity in the exact parent and preserves both existing drafts', () => {
    const { parent, child } = fixtures(), draft = prepareNativeParentContinuation(child, parent)!;
    expect(draft.startsWith('PRESERVED_PARENT_DRAFT\n\n---')).toBe(true);
    expect(draft).toContain('native-child'); expect(draft).toContain('/root/phone_control_probe'); expect(draft).not.toContain('New reviewed continuation');
    expect(draft).not.toContain('"instruction"');
    expect(parent.draft).toBe('PRESERVED_PARENT_DRAFT'); expect(child.draft).toBe('New reviewed continuation');
    parent.draft = draft; expect(prepareNativeParentContinuation(child, parent)).toBe(draft);
});
it('does not route a stale owner or another parent', () => {
    const { parent, child } = fixtures();
    child.agentState!.nativeInput!.ownerGeneration = 'stale-owner'; expect(nativeParentControl(child)).toBe(null);
    expect(prepareNativeParentContinuation(child, parent)).toBe(null);
});
it('stages from current native child evidence without loading the parent roster', () => {
    const { parent, child } = fixtures();
    child.metadata!.nativeSession!.isSubagent = true;
    parent.agentState = null;
    Object.defineProperty(child, 'draft', { get: () => { throw Error('Child draft must not be read'); } });
    expect(prepareNativeParentContinuation(child, parent)).toContain('native-child');
    parent.metadata!.nativeSession!.catalogueAvailable = false;
    expect(prepareNativeParentContinuation(child, parent)).toBe(null);
});
it('makes only explicitly catalogued native subagent input read-only for both applications', () => {
    const { child, parent } = fixtures();
    expect(nativeSubagentInputReadOnly(parent)).toBe(false);
    expect(nativeSubagentInputReadOnly(child)).toBe(false);
    child.metadata!.nativeSession!.isSubagent = true;
    expect(nativeSubagentInputReadOnly(child)).toBe(true);
    child.metadata!.nativeSession!.catalogueAvailable = false;
    expect(nativeSubagentInputReadOnly(child)).toBe(true);
    const source = child.metadata!.bridge!.source;
    Object.assign(source, { app: 'antigravity', protocol: 'antigravity-connect', hostId: 'local:antigravity:' + 'a'.repeat(64) });
    expect(nativeSubagentInputReadOnly(child)).toBe(true);
    source.kind = 'window'; expect(nativeSubagentInputReadOnly(child)).toBe(false);
    source.kind = 'session'; child.metadata!.client!.id = 'other-client';
    expect(nativeSubagentInputReadOnly(child)).toBe(false);
});
