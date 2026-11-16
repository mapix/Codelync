import { expect, it } from 'vitest';
import { buildCodeLightBrowserRows, codeLightProjectKey, isCodeLightConversation, isCodeLightCodexSession, isCodeLightNativeSession } from './codeLightSessionBrowser';
import type { Session } from '../sync/storageTypes';
const session = (id: string, nativeId: string, parentId: string | null, title: string, updatedAt: number) => ({ id, updatedAt: 99999, metadata: { path: '/fixture/project', summary: { text: title }, bridge: { controlMode: 'session', source: { id: nativeId, hostId: 'local', app: 'codex' } }, nativeSession: { title, updatedAt, parentId, agentName: title, preview: title, isPinned: false } } }) as Session;

it('separates native Claude collection identities and mode labels without inferring Cowork from an URL', () => {
    const code = session('claude-code', 'same-native', null, 'Same title', 1), chat = session('claude-chat', 'same-native', null, 'Same title', 2);
    Object.assign(code.metadata!.bridge!.source, { app: 'claude-desktop', kind: 'session', protocol: 'claude-desktop-native', hostId: 'local:claude-desktop:' + 'a'.repeat(64),
        appMode: 'code', nativeCollection: 'claude-code-sessions', runtimeGeneration: 'owner' });
    Object.assign(chat.metadata!.bridge!.source, { app: 'claude-desktop', kind: 'session', protocol: 'claude-desktop-native', hostId: 'local:claude-desktop:' + 'b'.repeat(64),
        appMode: 'chat', nativeCollection: 'local-agent-mode-sessions', runtimeGeneration: 'owner' });
    chat.metadata!.path = '/cowork/original';
    expect(codeLightProjectKey(code)).not.toBe(codeLightProjectKey(chat));
    const projects = buildCodeLightBrowserRows([code, chat], '', new Set(), new Set());
    expect(projects).toEqual(expect.arrayContaining([expect.objectContaining({ sourceLabel: 'Claude Desktop · Code' }), expect.objectContaining({ sourceLabel: 'Claude Desktop · Chat' })]));
});

it('counts native subagents separately while retaining them beneath the original parent', () => {
    const root = session('root', 'native-root', null, 'Root', 1), child = session('child', 'native-child', 'native-root', 'Worker', 2);
    child.metadata!.nativeSession!.isSubagent = true;
    expect([root, child].filter(isCodeLightConversation)).toEqual([root]);
    const groups = buildCodeLightBrowserRows([root, child], '', new Set(), new Set());
    expect(groups[0]).toMatchObject({ kind: 'project', count: 1 });
    const rows = buildCodeLightBrowserRows([root, child], '', new Set(groups.map(row => row.key)), new Set(['root']));
    expect(rows.find(row => row.key === 'child')).toMatchObject({ child: true });
    expect(rows.find(row => row.key === 'root')).toMatchObject({ children: 1 });
});

it('an explicit cross-worktree child follows its proven parent project without rewriting native project facts', () => {
    const parent = session('parent', 'native-parent', null, 'Main', 1), child = session('child', 'native-child', 'native-parent', 'Worker', 20);
    Object.assign(parent.metadata!.nativeSession!, { projectKey: 'repo', projectPath: '/repo/app', projectLabel: 'app' });
    Object.assign(child.metadata!.nativeSession!, { isSubagent: true, projectKey: 'worktree', projectPath: '/worktrees/worker', projectLabel: 'worker' });
    const data = [child, parent], before = JSON.stringify(data), key = codeLightProjectKey(parent);
    const folded = buildCodeLightBrowserRows(data, '', new Set(), new Set());
    expect(folded).toEqual([expect.objectContaining({ kind: 'project', key, path: '/repo/app', label: 'app', count: 1 })]);
    const rows = buildCodeLightBrowserRows(data, '', new Set([key]), new Set(['parent']));
    expect(rows.find(row => row.key === 'parent')).toMatchObject({ children: 1, at: 1 });
    expect(rows.find(row => row.key === 'child')).toMatchObject({ child: true, projectId: key, session: child });
    expect(JSON.stringify(data)).toBe(before); expect(codeLightProjectKey(child)).not.toBe(key);
    const search = buildCodeLightBrowserRows(data, 'worker', new Set(), new Set());
    expect(search.filter(row => row.kind === 'project')).toHaveLength(0);
    expect(search.find(row => row.key === 'child')).toMatchObject({ projectId: key });
});

it('proven nested explicit children follow the ordinary ancestor across separate native worktrees', () => {
    const parent = session('parent', 'native-parent', null, 'Main', 1), child = session('child', 'native-child', 'native-parent', 'Worker', 2), grandchild = session('grandchild', 'native-grandchild', 'native-child', 'Worker 2', 3);
    for (const [index, row] of [parent, child, grandchild].entries()) {
        row.metadata!.nativeSession!.projectKey = `project-${index}`;
        if (index) row.metadata!.nativeSession!.isSubagent = true;
    }
    const key = codeLightProjectKey(parent), rows = buildCodeLightBrowserRows([grandchild, child, parent], '', new Set([key]), new Set(['parent', 'child']));
    expect(rows.filter(row => row.kind === 'project')).toEqual([expect.objectContaining({ key, count: 1 })]);
    expect(rows.filter(row => row.kind === 'session').map(row => row.key)).toEqual(['parent', 'child', 'grandchild']);
    expect(rows.find(row => row.key === 'grandchild')).toMatchObject({ child: true, projectId: key });
});

it('ordinary cross-project forks remain independent and explicit orphan buckets have no zero-count header', () => {
    const parent = session('parent', 'native-parent', null, 'Main', 1), fork = session('fork', 'native-fork', 'native-parent', 'Fork', 2);
    fork.metadata!.nativeSession!.projectKey = 'fork-project';
    expect(buildCodeLightBrowserRows([parent, fork], '', new Set(), new Set()).filter(row => row.kind === 'project')).toHaveLength(2);
    fork.metadata!.nativeSession!.isSubagent = true; fork.metadata!.nativeSession!.parentId = 'absent';
    const rows = buildCodeLightBrowserRows([parent, fork], '', new Set(), new Set());
    expect(rows).toEqual([expect.objectContaining({ kind: 'project', count: 1 })]);
    expect(buildCodeLightBrowserRows([parent, fork], 'fork', new Set(), new Set())).toEqual([expect.objectContaining({ kind: 'session', key: 'fork', child: false })]);
});

it.each(['machine', 'host', 'app', 'protocol', 'collection'])('cross-project explicit child cannot follow a foreign %s parent', field => {
    const parent = session('parent', 'native-parent', null, 'Main', 1), child = session('child', 'native-child', 'native-parent', 'Worker', 2);
    child.metadata!.nativeSession!.isSubagent = true; child.metadata!.nativeSession!.projectKey = 'worktree';
    if (field === 'machine') parent.metadata!.machineId = 'foreign';
    if (field === 'host') parent.metadata!.bridge!.source.hostId = 'foreign';
    if (field === 'app') Object.assign(parent.metadata!.bridge!.source, { app: 'antigravity', hostId: 'local:antigravity:' + 'a'.repeat(64), kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: 'owner' });
    if (field === 'protocol') parent.metadata!.bridge!.source.protocol = 'other-protocol';
    if (field === 'collection') parent.metadata!.bridge!.source.nativeCollection = 'claude-code-sessions';
    const rows = buildCodeLightBrowserRows([parent, child], 'worker', new Set(), new Set());
    expect(rows).toEqual([expect.objectContaining({ kind: 'session', key: 'child', child: false, projectId: codeLightProjectKey(child) })]);
});

it('ambiguous same-source parent aliases cannot adopt an explicit child project', () => {
    const parent = session('parent', 'shared', null, 'Main', 1), alias = session('alias', 'shared', null, 'Other', 2), child = session('child', 'child-native', 'shared', 'Worker', 3);
    parent.metadata!.nativeSession!.projectKey = 'main'; alias.metadata!.nativeSession!.projectKey = 'alias';
    Object.assign(child.metadata!.nativeSession!, { isSubagent: true, projectKey: 'child' });
    const search = buildCodeLightBrowserRows([child, parent, alias], 'worker', new Set(), new Set());
    expect(search).toEqual([expect.objectContaining({ kind: 'session', key: 'child', child: false, projectId: codeLightProjectKey(child) })]);
});

it('shows both verified desktop apps and keeps equal native IDs and paths in separate families', () => {
    const codex = session('codex-parent', 'same-native', null, 'Shared parent', 1);
    const antigravity = session('antigravity-parent', 'same-native', null, 'Shared parent', 2);
    const child = session('antigravity-child', 'agy-child', 'same-native', 'Shared child', 3);
    for (const row of [antigravity, child]) Object.assign(row.metadata!.bridge!.source, {
        app: 'antigravity', hostId: 'local:antigravity:' + 'a'.repeat(64), kind: 'session', protocol: 'antigravity-connect', runtimeGeneration: 'verified-agy-owner',
    });
    const unsupported = session('old-agy-window', 'old-window', null, 'Old window', 4);
    Object.assign(unsupported.metadata!.bridge!.source, { app: 'antigravity' });
    expect([codex, antigravity, child, unsupported].filter(isCodeLightNativeSession)).toEqual([codex, antigravity, child]);
    expect([codex, antigravity].filter(isCodeLightCodexSession)).toEqual([codex]);
    const projects = buildCodeLightBrowserRows([codex, antigravity, child, unsupported], '', new Set(), new Set());
    expect(projects).toHaveLength(2);
    expect(projects).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceLabel: 'Codex', count: 1 }),
        expect.objectContaining({ sourceLabel: 'Antigravity', count: 2 }),
    ]));
    const rows = buildCodeLightBrowserRows([codex, antigravity, child], '', new Set(projects.map(row => row.key)), new Set(['antigravity-parent']));
    expect(rows.find(row => row.key === 'antigravity-child')).toMatchObject({ child: true });
    expect(rows.find(row => row.key === 'codex-parent')).toMatchObject({ children: 0 });
    expect(buildCodeLightBrowserRows([codex, antigravity, child], 'antigravity', new Set(), new Set()).filter(row => row.kind === 'session').map(row => row.key))
        .toEqual(['antigravity-parent', 'antigravity-child']);
});
it('groups native parent identities independently from relay ids and sorts by original recency', () => {
    const data = [session('relay-old', 'native-old', null, 'Old', 1), session('relay-new', 'native-new', null, 'New', 20), session('relay-child', 'native-child', 'native-new', 'Worker', 21)];
    const projects = buildCodeLightBrowserRows(data, '', new Set(), new Set()).map(row => row.key);
    const rows = buildCodeLightBrowserRows(data, '', new Set(projects), new Set(['relay-new']));
    expect(rows.filter(row => row.kind === 'session').map(row => row.key)).toEqual(['relay-new', 'relay-child', 'relay-old']);
    expect(rows.find(row => row.key === 'relay-child')).toMatchObject({ child: true });
});
it('ranks recent families before older pins, breaks recency ties by pin, and keeps actual parent time', () => {
    const data = [session('pinned-old', 'native-old', null, 'Old pin', 1), session('family-parent', 'native-parent', null, 'Old parent', 2),
        session('recent-child', 'native-child', 'native-parent', 'Recent worker', 100), session('fresh', 'native-fresh', null, 'Fresh', 50),
        session('fresh-pin', 'native-fresh-pin', null, 'Fresh pin', 50)];
    data[0].metadata!.nativeSession!.isPinned = true; data[4].metadata!.nativeSession!.isPinned = true;
    const group = buildCodeLightBrowserRows(data, '', new Set(), new Set())[0].key;
    const rows = buildCodeLightBrowserRows(data, '', new Set([group]), new Set(['family-parent']));
    expect(rows.filter(row => row.kind === 'session').map(row => row.key)).toEqual(['family-parent', 'recent-child', 'fresh-pin', 'fresh', 'pinned-old']);
    expect(rows.find(row => row.key === 'family-parent')).toMatchObject({ at: 2 });
    expect(data[2].metadata!.nativeSession!.parentId).toBe('native-parent'); expect(data[0].metadata!.nativeSession!.isPinned).toBe(true);
});
it('folds one project across main, worktrees and nested directories, including cross-worktree children', () => {
    const data = [session('main', 'native-main', null, 'Main', 1), session('tree', 'native-tree', null, 'Worktree', 2), session('child', 'native-child', 'native-main', 'Worker', 3)];
    data.forEach((s, i) => { s.metadata!.path = ['/repo/app', '/worktrees/a/app', '/repo/app/src'][i]; Object.assign(s.metadata!.nativeSession!, { projectKey: 'canonical-project', projectPath: '/repo/app', projectLabel: 'app' }); });
    const folded = buildCodeLightBrowserRows(data, '', new Set(), new Set()); expect(folded).toHaveLength(1); expect(folded[0]).toMatchObject({ kind: 'project', count: 3 });
    const open = buildCodeLightBrowserRows(data, '', new Set([folded[0].key]), new Set(['main'])); expect(open.filter(r => r.kind === 'project')).toHaveLength(1);
    expect(open.find(r => r.key === 'child')).toMatchObject({ child: true });
    expect(new Set(open.map(r => r.key)).size).toBe(open.length);
});
it('does not merge same-name independent projects or sources on different Macs', () => {
    const data = [session('a', 'native-a', null, 'A', 1), session('b', 'native-b', null, 'B', 2)];
    data.forEach((s, i) => Object.assign(s.metadata!.nativeSession!, { projectKey: `project-${i}`, projectPath: `/repo-${i}/app`, projectLabel: 'app' }));
    expect(buildCodeLightBrowserRows(data, '', new Set(), new Set())).toHaveLength(2);
    data[1].metadata!.nativeSession!.projectKey = 'project-0'; data[1].metadata!.machineId = 'other-Mac';
    expect(buildCodeLightBrowserRows(data, '', new Set(), new Set())).toHaveLength(2);
});
it('search finds child sessions even while their project and parent are collapsed', () => {
    const rows = buildCodeLightBrowserRows([session('relay', 'native', 'parent', 'Feynman worker', 1)], 'feynman', new Set(), new Set());
    expect(rows.some(row => row.key === 'relay')).toBe(true);
});

it('exports the existing project row identity for lightweight status consumers', () => {
    const row = session('relay', 'native', null, 'Worker', 1);
    Object.assign(row.metadata!.bridge!.source, { hostId: 'local', app: 'codex' });
    row.metadata!.machineId = 'machine';
    row.metadata!.nativeSession!.projectKey = 'canonical';
    const key = codeLightProjectKey(row);
    expect(key).toBe('project:["machine","local","codex"]:canonical');
    expect(buildCodeLightBrowserRows([row], '', new Set(), new Set())[0].key).toBe(key);
});

it('reads native recency once per matched session while ordering a multi-project catalog', () => {
    let recencyReads = 0;
    const data = Array.from({ length: 800 }, (_, index) => {
        const row = session(`relay-${index}`, `native-${index}`, null, `Worker ${index}`, index);
        row.metadata!.nativeSession!.projectKey = `project-${Math.floor(index / 40)}`;
        Object.defineProperty(row.metadata!.nativeSession!, 'updatedAt', { get: () => { recencyReads++; return index; } });
        return row;
    });
    const rows = buildCodeLightBrowserRows(data, '', new Set(), new Set());
    expect(rows).toHaveLength(20);
    expect(rows[0].key.endsWith(':project-19')).toBe(true);
    expect(recencyReads).toBe(data.length);
});

it('folds a minimal large catalog without spreading a project into function arguments', () => {
    // Minimal records exercise the argument-count limit without allocating full
    // conversation metadata or rendering 150,000 rows on the host.
    const size = 150_000;
    const bridge = { source: { app: 'codex' } };
    const data = Array.from({ length: size }, (_, index) => ({ id: `large-${index}`, updatedAt: index, metadata: { path: '/fixture/large', bridge } }) as Session);
    data.push({ id: 'small', updatedAt: -1, metadata: { path: '/fixture/small', bridge } } as Session);
    const rows = buildCodeLightBrowserRows(data, '', new Set(), new Set());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'project', count: size, label: 'large' });
});

it('search renders a deep valid parent chain without recursive stack growth', () => {
    const size = 12_000;
    const data = Array.from({ length: size }, (_, index) => session(`relay-${index}`, `native-${index}`, index ? `native-${index - 1}` : null, `Worker ${index}`, index));
    const rows = buildCodeLightBrowserRows(data, 'worker', new Set(), new Set());
    expect(rows.filter(row => row.kind === 'session')).toHaveLength(size);
    expect(rows[1]).toMatchObject({ key: 'relay-0', child: false });
    expect(rows.at(-1)).toMatchObject({ key: `relay-${size - 1}`, child: true });
});

it('a parent cycle keeps a stable visible root and renders each matching session once', () => {
    const data = [session('a', 'native-a', 'native-b', 'Worker A', 1), session('b', 'native-b', 'native-a', 'Worker B', 2), session('c', 'native-c', 'native-b', 'Worker C', 3)];
    const folded = buildCodeLightBrowserRows(data, '', new Set(), new Set());
    const open = buildCodeLightBrowserRows(data, '', new Set([folded[0].key]), new Set());
    expect(open.filter(row => row.kind === 'session')).toEqual([expect.objectContaining({ key: 'a', child: false, children: 1 })]);
    const searched = buildCodeLightBrowserRows(data, 'worker', new Set(), new Set());
    expect(searched.filter(row => row.kind === 'session').map(row => row.key)).toEqual(['a', 'b', 'c']);
    expect(new Set(searched.map(row => row.key)).size).toBe(searched.length);
    expect(data[0].metadata!.nativeSession!.parentId).toBe('native-b');
});

it('self-parent facts remain visible as a root with no phantom child', () => {
    const rows = buildCodeLightBrowserRows([session('self', 'native-self', 'native-self', 'Worker', 1)], 'worker', new Set(), new Set());
    expect(rows.filter(row => row.kind === 'session')).toEqual([expect.objectContaining({ key: 'self', child: false, children: 0 })]);
});

it('a repeated native ID in another project cannot take over a parent link', () => {
    const data = [session('parent-a', 'shared-native', null, 'Parent A', 1), session('child-a', 'native-child', 'shared-native', 'Child A', 2), session('parent-b', 'shared-native', null, 'Parent B', 3)];
    data.forEach((row, index) => { row.metadata!.nativeSession!.projectKey = index === 2 ? 'project-b' : 'project-a'; });
    const groups = buildCodeLightBrowserRows(data, '', new Set(), new Set());
    const rows = buildCodeLightBrowserRows(data, '', new Set(groups.map(row => row.key)), new Set(['parent-a']));
    expect(rows.find(row => row.key === 'child-a')).toMatchObject({ child: true });
    expect(rows.filter(row => row.kind === 'session').map(row => row.key)).toEqual(['parent-b', 'parent-a', 'child-a']);
});

it('missing or ambiguous native identities do not invent parent links', () => {
    const missing = session('missing', 'missing-native', null, 'Missing', 1);
    (missing.metadata!.bridge!.source as any).id = undefined;
    const missingRows = buildCodeLightBrowserRows([missing, session('child', 'native-child', 'undefined', 'Child', 2)], 'i', new Set(), new Set());
    expect(missingRows.find(row => row.key === 'child')).toMatchObject({ child: false });

    const ambiguous = [session('alias-a', 'shared', null, 'Alias A', 1), session('alias-b', 'shared', null, 'Alias B', 2), session('child', 'native-child', 'shared', 'Child', 3)];
    const rows = buildCodeLightBrowserRows(ambiguous, 'i', new Set(), new Set());
    expect(rows.find(row => row.key === 'child')).toMatchObject({ child: false });
});

it('native parent IDs remain isolated by host and foreign source app records are excluded', () => {
    const parent = session('parent', 'shared-native', null, 'Parent', 1);
    const child = session('child', 'child-native', 'shared-native', 'Child', 2);
    Object.assign(parent.metadata!.bridge!.source, { hostId: 'local', app: 'codex' });
    Object.assign(child.metadata!.bridge!.source, { hostId: 'remote', app: 'codex' });
    let rows = buildCodeLightBrowserRows([parent, child], 'a', new Set(), new Set());
    expect(rows.filter(row => row.kind === 'project')).toHaveLength(2);
    expect(rows.find(row => row.key === 'child')).toMatchObject({ child: false });
    Object.assign(child.metadata!.bridge!.source, { hostId: 'local', app: 'zcode' });
    rows = buildCodeLightBrowserRows([parent, child], 'a', new Set(), new Set());
    expect(rows.filter(row => row.kind === 'project')).toHaveLength(1);
    expect(rows.find(row => row.key === 'child')).toBeUndefined();
});

it('the viewer excludes foreign and window caches without deleting or changing them', () => {
    const codex = session('codex', 'native-codex', null, 'ZCode project work', 1);
    const foreign = session('foreign', 'native-foreign', null, 'Other harness', 2);
    foreign.metadata!.bridge!.source.app = 'claude-desktop';
    const window = session('window', 'native-window', null, 'Codex window', 3);
    window.metadata!.bridge!.controlMode = 'window';
    const absent = { id: 'absent', updatedAt: 4, metadata: { path: '/fixture/project', flavor: 'codex' } } as Session;
    const missingSource = { id: 'missing-source', updatedAt: 5, metadata: { path: '/fixture/project', bridge: {} } } as Session;
    const data = [codex, foreign, window, absent, missingSource];
    const before = JSON.stringify(data);
    expect(data.filter(isCodeLightCodexSession)).toEqual([codex]);
    const rows = buildCodeLightBrowserRows(data, 'window', new Set(), new Set());
    expect(rows).toHaveLength(0);
    expect(buildCodeLightBrowserRows(data, 'other harness', new Set(), new Set())).toHaveLength(0);
    const groups = buildCodeLightBrowserRows(data, '', new Set(), new Set());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 1 });
    expect(JSON.stringify(data)).toBe(before);
});

it('legacy Codex records without controlMode remain compatible but unknown modes are not native sessions', () => {
    const legacy = session('legacy', 'native-legacy', null, 'Legacy Codex', 1);
    delete (legacy.metadata!.bridge as any).controlMode;
    const unknown = session('unknown', 'native-unknown', null, 'Unknown mode', 2);
    (unknown.metadata!.bridge as any).controlMode = 'unverified-mode';
    expect(isCodeLightCodexSession(legacy)).toBe(true);
    expect(isCodeLightCodexSession(unknown)).toBe(false);
    const rows = buildCodeLightBrowserRows([legacy, unknown], 'codex', new Set(), new Set());
    expect(rows.filter(row => row.kind === 'session').map(row => row.key)).toEqual(['legacy']);
});
