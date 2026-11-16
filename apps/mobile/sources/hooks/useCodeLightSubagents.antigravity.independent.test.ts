import * as React from 'react';
// @ts-expect-error The native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { AgentStateSchema } from '@/sync/storageTypes';
import { NativeSubagentSchema } from '@/sync/nativeSubagents';
import { captureCurrentNativeTaskScope } from '@/utils/codeLightNativeTasks';
import { currentNativeAggregate } from '@/utils/nativeAggregateActivity';
import { nativeComposerInputReadOnly } from '@/utils/nativeComposerInputReadOnly';
import { filterCodeLightSubagents, projectCodeLightSubagents } from '@/utils/codeLightSubagents';

const services = vi.hoisted(() => ({ read: vi.fn(), retain: vi.fn(), release: vi.fn() }));
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { onStatusChange: () => () => {} }, getCurrentAppState: () => 'active' }));
vi.mock('@/sync/nativeTaskStore', () => ({
    nativeTaskPeerIdentity: () => 'peer:synthetic',
    nativeTaskCacheContext: () => null,
    nativeTaskCache: { get: services.read, retain: services.retain, release: services.release },
}));
import { useCodeLightSubagents } from './useCodeLightSubagents';

const hostId = 'local:antigravity:' + 'a'.repeat(64);
function session(): Session {
    const subagents = Array.from({ length: 128 }, (_, index) => ({
        id: `child-${index}`, name: `Native worker ${index}`, app: 'antigravity',
        nativeConversationId: `child-${index}`, parentConversationId: 'ancestor',
        nativeParentConversationId: index ? 'undisplayed-immediate-parent' : 'ancestor', depth: index ? 5 : 1,
        hostId, ownerGeneration: 'current-owner', relationship: 'native-subagent',
        status: index === 0 ? 'running' : index === 1 ? 'waiting' : index % 2 ? 'idle' : 'stopped',
    }));
    return { id: 'relay-parent', draft: 'parent draft', thinking: false,
        metadata: { machineId: 'synthetic-mac', client: { id: 'noninvasive-bridge' },
            bridge: { version: 1, controlMode: 'session', sourceStatus: 'connected', currentTurnId: null,
                source: { app: 'antigravity', id: 'ancestor', hostId, kind: 'session', protocol: 'antigravity-connect',
                    runtimeGeneration: 'current-owner', windowGeneration: null } },
            capabilities: { steering: true } },
        agentState: AgentStateSchema.parse({ subagents, subagentsAvailable: true, subagentsComplete: false,
            subagentsTruncated: true, subagentsTotal: 137, aggregateActivity: { version: 1, app: 'antigravity',
                parentConversationId: 'ancestor', hostId, ownerGeneration: 'current-owner', ownStatus: 'idle', ownKnown: true,
                status: 'waiting', known: true, active: true, waiting: true, rosterAvailable: true, rosterComplete: true,
                childCount: 137, unknownChildren: 0, digest: 'a'.repeat(64) } }),
    } as unknown as Session;
}
const mounted: ReturnType<typeof create>[] = [];
afterEach(() => { act(() => mounted.splice(0).forEach(screen => screen.unmount())); vi.clearAllMocks(); });

it('the real parent hook keeps a mixed bounded descendant roster without reading Claude tasks or child history', () => {
    let data = session(), view: ReturnType<typeof useCodeLightSubagents> | null = null;
    const Probe = ({ value, expanded }: { value: Session; expanded: boolean }) => {
        view = useCodeLightSubagents(value, undefined, expanded, true); return null;
    };
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(Probe, { value: data, expanded: false })); }); mounted.push(screen);
    expect(captureCurrentNativeTaskScope(data)).toBeNull();
    expect(view).toMatchObject({ present: true, available: true, count: 137, countComplete: true,
        complete: false, truncated: true, loading: false, failed: false });
    expect(view!.rows).toHaveLength(128);
    expect(filterCodeLightSubagents(view!.rows, 'all')).toHaveLength(128);
    expect(filterCodeLightSubagents(view!.rows, 'in-progress').map(row => row.id)).toContain('child-0');
    expect(view!.rows[1]).toMatchObject({ status: 'waiting', nativeParentConversationId: 'undisplayed-immediate-parent', depth: 5 });
    expect(currentNativeAggregate(data)).toMatchObject({ ownStatus: 'idle', active: true, waiting: true, childCount: 137 });
    expect(nativeComposerInputReadOnly(data)).toBe(false);
    act(() => screen.update(React.createElement(Probe, { value: data, expanded: true })));
    expect(services.read).not.toHaveBeenCalled(); expect(services.retain).not.toHaveBeenCalled();
    data = { ...data, agentState: { ...data.agentState!, subagents: data.agentState!.subagents!.map(row => row.id === 'child-0' ? { ...row, status: 'stopped' as const } : row) } };
    act(() => screen.update(React.createElement(Probe, { value: data, expanded: true })));
    expect(view!.rows).toHaveLength(128); expect(view!.rows[0].status).toBe('stopped');
});

it('an unregistered retained native child remains observable and read only under its exact catalog identity', () => {
    const parent = session(), row = parent.agentState!.subagents![0];
    const child = { ...parent, id: 'relay-child', draft: 'retained child draft', metadata: { ...parent.metadata!,
        nativeSession: { isSubagent: true, parentId: row.nativeParentConversationId, catalogueAvailable: true },
        bridge: { ...parent.metadata!.bridge!, sourceStatus: 'disconnected', source: { ...parent.metadata!.bridge!.source,
            id: row.nativeConversationId, runtimeGeneration: null } } } } as unknown as Session;
    expect(projectCodeLightSubagents(parent, [child]).rows[0].targetSessionId).toBe(child.id);
    expect(nativeComposerInputReadOnly(child)).toBe(true); expect(child.draft).toBe('retained child draft');
    child.metadata!.nativeSession!.catalogueAvailable = false;
    expect(projectCodeLightSubagents(parent, [child]).rows[0].targetSessionId).toBeNull();
});

it('a single malformed native row is distinguishable from a verified empty roster at the actual parser boundary', () => {
    const parent = session(), raw = [...parent.agentState!.subagents!, { ...parent.agentState!.subagents![0], id: 'malformed', depth: 129 }];
    expect(raw.slice(0, 128).every(row => NativeSubagentSchema.safeParse(row).success)).toBe(true);
    const direct = projectCodeLightSubagents(parent, [], raw);
    expect(direct).toMatchObject({ present: true, available: false, count: null, complete: false });
    expect(direct.rows).toHaveLength(128);
    const parsed = AgentStateSchema.parse({ ...parent.agentState!, subagents: raw });
    expect(parsed.subagents).toBeUndefined();
    expect(projectCodeLightSubagents({ ...parent, agentState: parsed })).toMatchObject({
        present: true, available: false, complete: false, rows: [], count: null,
    });
});
