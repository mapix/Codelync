import { expect, it } from 'vitest';
import type { Session } from '../sync/storageTypes';
import type { NativeSubagent } from '../sync/nativeSubagents';
import { codeLightSubagentParent, filterCodeLightSubagents, projectCodeLightSubagents } from './codeLightSubagents';

const namespace = 'local:antigravity:' + 'a'.repeat(64);
const parent = (app: 'codex' | 'antigravity' = 'codex') => ({ id: 'relay-parent', metadata: { machineId: 'mac', client: { id: 'noninvasive-bridge' },
    bridge: { controlMode: 'session', sourceStatus: 'connected', source: { app, id: 'native-parent', hostId: app === 'codex' ? 'local' : namespace,
        kind: 'session', protocol: app === 'antigravity' ? 'antigravity-connect' : undefined, runtimeGeneration: 'parent-owner' } } },
    agentState: { subagentsAvailable: true, subagents: [] } }) as unknown as Session;
const agent = (app: 'codex' | 'antigravity' = 'codex'): NativeSubagent => ({ id: 'native-child', name: 'worker', app,
    nativeConversationId: 'native-child', parentConversationId: 'native-parent', hostId: app === 'codex' ? 'local' : namespace,
    ownerGeneration: 'parent-owner', relationship: 'native-subagent', status: 'running' });
const child = (app: 'codex' | 'antigravity' = 'codex') => ({ ...parent(app), id: 'relay-child', metadata: { ...parent(app).metadata,
    bridge: { ...parent(app).metadata!.bridge, source: { ...parent(app).metadata!.bridge!.source, id: 'native-child', runtimeGeneration: 'child-owner' } } } }) as Session;

it('keeps explicit original execution states and does not use tool completion or recency', () => {
    for (const status of ['running', 'waiting', 'idle', 'stopped', 'completed', 'failed', 'unknown'] as const) {
        const row = { ...agent(), status, completedAtMs: 123, toolStatus: 'completed' };
        const data = parent();
        Object.defineProperty(data, 'updatedAt', { get: () => { throw Error('recency is not execution state'); } });
        const view = projectCodeLightSubagents(data, [], [row]);
        expect(view.available).toBe(true); expect(view.rows[0].status).toBe(status);
    }
});

it('only lists native-subagent proof under the exact parent application and instance', () => {
    const data = parent('antigravity'), valid = agent('antigravity');
    const rows = [valid, { ...valid, id: 'fork', relationship: 'fork' }, { ...valid, id: 'foreign-parent', parentConversationId: 'different-parent' },
        { ...valid, id: 'other-app', app: 'codex' }, { ...valid, id: 'other-instance', hostId: 'local:antigravity:' + 'b'.repeat(64) }];
    const view = projectCodeLightSubagents(data, [], rows);
    expect(view.rows.map(row => row.id)).toEqual(['native-child']);
    expect(view.available).toBe(false); expect(view.rows[0].status).toBe('unknown');
    const ordinary = parent('antigravity'); ordinary.metadata!.bridge!.source.kind = 'window';
    expect(projectCodeLightSubagents(ordinary, [], [valid]).present).toBe(false);
});

it('keeps proven identity but marks execution unknown after generation changes or disconnection', () => {
    for (const change of [
        (p: Session) => { p.metadata!.bridge!.sourceStatus = 'disconnected'; },
        (p: Session) => { p.metadata!.bridge!.source.runtimeGeneration = 'new-parent-owner'; },
        (p: Session) => { p.agentState!.subagentsAvailable = false; },
    ]) {
        const data = parent(); change(data);
        const view = projectCodeLightSubagents(data, [], [agent()]);
        expect(view.available).toBe(false); expect(view.rows[0]).toMatchObject({ id: 'native-child', name: 'worker', status: 'unknown' });
    }
});

it('does not turn missing, malformed or truncated source data into an empty confirmed count', () => {
    expect(projectCodeLightSubagents(parent())).toMatchObject({ present: true, available: true, rows: [] });
    const data = parent(); delete data.agentState!.subagents;
    expect(projectCodeLightSubagents(data)).toMatchObject({ present: true, available: false, rows: [] });
    expect(projectCodeLightSubagents(parent(), [], [{ ...agent(), status: 'made-up' }])).toMatchObject({ available: false, rows: [] });
    const partial = parent(); partial.agentState!.subagentsTruncated = true;
    expect(projectCodeLightSubagents(partial, [], [agent()])).toMatchObject({ available: true, truncated: true });
});

it('navigates only an exact verified native child catalog identity and rejects ambiguity', () => {
    const data = parent('antigravity'), valid = child('antigravity');
    const foreignMachine = child('antigravity'); foreignMachine.id = 'foreign'; foreignMachine.metadata!.machineId = 'another-mac';
    const foreignHost = child('antigravity'); foreignHost.id = 'other-instance'; foreignHost.metadata!.bridge!.source.hostId = 'local:antigravity:' + 'b'.repeat(64);
    const foreignApp = child(); foreignApp.id = 'codex';
    const view = projectCodeLightSubagents(data, [foreignMachine, foreignHost, foreignApp, valid], [agent('antigravity')]);
    expect(view.rows[0].targetSessionId).toBe('relay-child');
    expect(projectCodeLightSubagents(data, [foreignMachine, foreignHost, foreignApp], [agent('antigravity')]).rows[0].targetSessionId).toBe(null);
    const ambiguous = { ...valid, id: 'second-relay' };
    expect(projectCodeLightSubagents(data, [valid, ambiguous], [agent('antigravity')]).rows[0].targetSessionId).toBe(null);
    valid.metadata!.bridge!.controlMode = 'window';
    expect(projectCodeLightSubagents(data, [valid], [agent('antigravity')]).rows[0].targetSessionId).toBe(null);
});

it('duplicate original identities are uncertain and cannot establish a child link', () => {
    const view = projectCodeLightSubagents(parent(), [child()], [agent(), { ...agent(), status: 'completed' }]);
    expect(view.available).toBe(false); expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ status: 'unknown', targetSessionId: null });
});

it('returns only a uniquely evidenced native parent, excluding forks and foreign instances', () => {
    const root = parent('antigravity'), worker = child('antigravity');
    root.agentState!.subagents = [agent('antigravity')];
    worker.metadata!.nativeSession = { parentId: 'native-parent' } as any;
    expect(codeLightSubagentParent(worker, [root, worker])?.id).toBe(root.id);
    const ordinary = parent('antigravity');
    expect(codeLightSubagentParent(worker, [ordinary, worker])).toBe(null);
    expect(codeLightSubagentParent(worker, [root, { ...root, id: 'ambiguous-parent' }, worker])).toBe(null);
    const foreign = parent('antigravity'); foreign.agentState!.subagents = [agent('antigravity')]; foreign.metadata!.machineId = 'other-mac';
    expect(codeLightSubagentParent(worker, [foreign])).toBe(null);
    worker.metadata!.bridge!.source.hostId = 'local:antigravity:' + 'b'.repeat(64);
    expect(codeLightSubagentParent(worker, [root])).toBe(null);
});

it('finds a current catalogued native parent before parent history or roster is loaded', () => {
    for (const app of ['codex', 'antigravity'] as const) {
        const root = parent(app), worker = child(app);
        worker.metadata!.nativeSession = { isSubagent: true, parentId: 'native-parent', catalogueAvailable: true } as any;
        root.agentState = null;
        root.metadata!.bridge!.sourceStatus = 'disconnected';
        expect(codeLightSubagentParent(worker, [root, worker])?.id).toBe(root.id);
        expect(codeLightSubagentParent(worker, [root, { ...root, id: 'duplicate' }])).toBe(null);
        for (const unavailable of ['archived', 'catalogueAvailable'] as const) {
            root.metadata!.nativeSession = { [unavailable]: unavailable === 'archived' } as any;
            expect(codeLightSubagentParent(worker, [root])).toBe(null);
        }
    }
});

it('fences native-index parent lookup by machine, application and host', () => {
    const worker = child('antigravity');
    worker.metadata!.nativeSession = { isSubagent: true, parentId: 'native-parent' } as any;
    for (const change of [
        (p: Session) => { p.metadata!.machineId = 'another-mac'; },
        (p: Session) => { p.metadata!.bridge!.source.app = 'codex'; },
        (p: Session) => { p.metadata!.bridge!.source.hostId = 'local:antigravity:' + 'b'.repeat(64); },
    ]) {
        const root = parent('antigravity'); root.agentState = null; change(root);
        expect(codeLightSubagentParent(worker, [root])).toBe(null);
    }
    delete worker.metadata!.machineId;
    const root = parent('antigravity'); delete root.metadata!.machineId;
    expect(codeLightSubagentParent(worker, [root])).toBe(null);
});

it('does not treat an ordinary fork parent ID as native-index subagent evidence', () => {
    const root = parent(), fork = child(); root.agentState = null;
    for (const isSubagent of [undefined, false]) {
        fork.metadata!.nativeSession = { parentId: 'native-parent', isSubagent } as any;
        expect(codeLightSubagentParent(fork, [root])).toBe(null);
    }
    root.agentState = { subagents: [agent()] } as any;
    expect(codeLightSubagentParent(fork, [root])?.id).toBe(root.id);
});

it('filters lifecycle states without inferring unknown, idle or stopped as completion', () => {
    const view = projectCodeLightSubagents(parent(), [], (['running', 'waiting', 'idle', 'stopped', 'completed', 'failed', 'unknown'] as const).map(status => ({ ...agent(), id: status, status })));
    expect(filterCodeLightSubagents(view.rows, 'all')).toHaveLength(7);
    expect(filterCodeLightSubagents(view.rows, 'in-progress').map(row => row.status)).toEqual(['running', 'waiting', 'idle']);
    expect(filterCodeLightSubagents(view.rows, 'finished').map(row => row.status)).toEqual(['stopped', 'completed', 'failed']);
    expect(filterCodeLightSubagents(view.rows, 'unknown').map(row => row.status)).toEqual(['unknown']);
});

it('claims roster completeness only for a matching native aggregate and full identity count', () => {
    const root = parent(), aggregate = { version: 1, rosterAvailable: true, rosterComplete: true, childCount: 1,
        app: 'codex', hostId: 'local', ownerGeneration: 'parent-owner', parentConversationId: 'native-parent' };
    Object.assign(root.agentState!, { subagents: [agent()], subagentsComplete: true, aggregateActivity: aggregate });
    expect(projectCodeLightSubagents(root).complete).toBe(true);
    Object.assign(root.agentState!, { aggregateActivity: { ...aggregate, ownerGeneration: 'old-owner' } });
    expect(projectCodeLightSubagents(root).complete).toBe(false);
    Object.assign(root.agentState!, { aggregateActivity: { ...aggregate, childCount: 2 } });
    expect(projectCodeLightSubagents(root).complete).toBe(false);
});

const antigAggregate = (count = 137) => ({ version: 1 as const, app: 'antigravity' as const, parentConversationId: 'native-parent',
    hostId: namespace, ownerGeneration: 'parent-owner', ownStatus: 'idle', ownKnown: true, status: 'running' as const,
    known: true, active: true, waiting: false, rosterAvailable: true, rosterComplete: true, childCount: count, unknownChildren: 0, digest: 'a'.repeat(64) });

it('keeps full native descendant counts independent from the active-first bounded display', () => {
    const root = parent('antigravity');
    const descendant = { ...agent('antigravity'), nativeParentConversationId: 'undisplayed-parent', depth: 5 };
    Object.assign(root.agentState!, { subagents: [descendant], subagentsTotal: 137, subagentsTruncated: true, subagentsComplete: false, aggregateActivity: antigAggregate() });
    const view = projectCodeLightSubagents(root, [child('antigravity')]);
    expect(view).toMatchObject({ available: true, count: 137, countComplete: true, complete: false, truncated: true });
    expect(view.rows[0]).toMatchObject({ nativeParentConversationId: 'undisplayed-parent', depth: 5, status: 'running', targetSessionId: 'relay-child' });
    expect(root.metadata?.nativeSession?.parentId).toBeUndefined();
    const bounded = Array.from({ length: 128 }, (_, index) => ({ ...descendant, id: 'descendant-' + index, nativeConversationId: 'descendant-' + index }));
    root.agentState!.subagents = bounded;
    expect(projectCodeLightSubagents(root)).toMatchObject({ count: 137, countComplete: true, complete: false, truncated: true });
    expect(projectCodeLightSubagents(root).rows).toHaveLength(128);
});

it('does not replace unknown or unscoped native totals with a display count or zero', () => {
    for (const total of [undefined, null, -1, 0, 1.5, '137', 20001]) {
        const root = parent('antigravity');
        Object.assign(root.agentState!, { subagents: [agent('antigravity')], subagentsTotal: total, subagentsComplete: true, aggregateActivity: antigAggregate() });
        expect(projectCodeLightSubagents(root)).toMatchObject({ count: null, countComplete: false, complete: false });
    }
    const empty = parent('antigravity'); empty.agentState!.subagentsComplete = true;
    expect(projectCodeLightSubagents(empty)).toMatchObject({ count: null, countComplete: false, complete: false });
    Object.assign(empty.agentState!, { subagentsTotal: 0, aggregateActivity: { ...antigAggregate(0), status: 'idle', active: false } });
    expect(projectCodeLightSubagents(empty)).toMatchObject({ count: 0, countComplete: true, complete: true });
    for (const change of [
        (p: Session) => { p.metadata!.bridge!.sourceStatus = 'disconnected'; },
        (p: Session) => { p.metadata!.bridge!.source.runtimeGeneration = 'new-owner'; },
        (p: Session) => { p.agentState!.subagentsAvailable = false; },
        (p: Session) => { delete p.agentState!.subagentsAvailable; },
    ]) {
        const root = parent('antigravity'); Object.assign(root.agentState!, { subagents: [agent('antigravity')], subagentsTotal: 137, aggregateActivity: antigAggregate() });
        change(root); expect(projectCodeLightSubagents(root)).toMatchObject({ count: null, countComplete: false });
    }
});

it('requires matching full aggregate source scope and total to confirm a descendant counter', () => {
    for (const change of [{ childCount: 136 }, { rosterAvailable: false }, { rosterComplete: false }, { app: 'codex' },
        { hostId: 'foreign-host' }, { ownerGeneration: 'old-owner' }, { parentConversationId: 'foreign-parent' }, { digest: 'invalid' }]) {
        const root = parent('antigravity');
        Object.assign(root.agentState!, { subagents: [agent('antigravity')], subagentsTotal: 137, subagentsTruncated: true, aggregateActivity: { ...antigAggregate(), ...change } });
        expect(projectCodeLightSubagents(root)).toMatchObject({ count: 137, countComplete: false, complete: false });
    }
});

it('keeps malformed or cross-owner descendant rows unconfirmed even with a valid full total', () => {
    for (const change of [{ nativeParentConversationId: 'native-child', depth: 2 }, { nativeParentConversationId: 'native-parent', depth: 2 },
        { nativeParentConversationId: 'intermediate', depth: 1 }, { ownerGeneration: 'old-owner' }]) {
        const root = parent('antigravity');
        Object.assign(root.agentState!, { subagents: [{ ...agent('antigravity'), ...change }], subagentsTotal: 137, aggregateActivity: antigAggregate() });
        expect(projectCodeLightSubagents(root)).toMatchObject({ available: false, count: null, countComplete: false });
    }
});
