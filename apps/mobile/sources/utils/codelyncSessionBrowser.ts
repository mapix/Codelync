import type { Session } from '../sync/storageTypes';
import { codelyncSourceLabel, isCodelyncSessionIdentity } from './codelyncSourceScope';

export type CodelyncBrowserRow = { kind: 'project'; key: string; path: string; label: string; sourceLabel: string; count: number } | { kind: 'session'; key: string; projectId: string; session: Session; title: string; child: boolean; children: number; at: number };

/** A field-only boundary shared by the browser and its catalog total. */
export function isCodelyncCodexSession(session: Session): boolean {
    const bridge = session.metadata?.bridge;
    return bridge?.source?.app === 'codex' && isCodelyncNativeSession(session);
}

/** The browser and its total use the same proven native source boundary. */
export function isCodelyncNativeSession(session: Session): boolean {
    const bridge = session.metadata?.bridge;
    return session.metadata?.nativeSession?.archived !== true && session.metadata?.nativeSession?.catalogueAvailable !== false && isCodelyncSessionIdentity(bridge?.source, bridge?.controlMode);
}

export function isCodelyncConversation(session: Session): boolean {
    return isCodelyncNativeSession(session) && session.metadata?.nativeSession?.isSubagent !== true;
}

/** The catalog and lightweight project status use the same scoped identity. */
export function codelyncProjectKey(session: Session): string {
    const data = session.metadata;
    const scope = JSON.stringify([data?.machineId, data?.bridge?.source?.hostId, data?.bridge?.source?.app]);
    return `project:${scope}:${data?.nativeSession?.projectKey || data?.path || '/'}`;
}

type Entry = {
    session: Session;
    order: number;
    at: number;
    pinned: boolean;
    nativeId: string | undefined;
    parentId?: string | undefined;
    title: string | undefined;
};
type NativeRow = {
    session: Session;
    order: number;
    nativeId: string | undefined;
    isSubagent: boolean;
};
type Group = { key: string; project: Session; entries: Entry[]; count: number; latestAt: number; order: number };

function parentKey(session: Session, nativeId: string | null | undefined): string | undefined {
    if (!nativeId) return undefined;
    const data = session.metadata, source = data?.bridge?.source;
    return JSON.stringify([data?.machineId ?? null, source?.app, source?.hostId, source?.kind ?? 'session',
        source?.protocol ?? null, source?.appMode ?? null, source?.nativeCollection ?? null, nativeId]);
}

/** Only explicit membership may follow a uniquely proven parent across projects. */
function displayProjects(subagents: NativeRow[], index: Map<string, Session>): Map<string, Session> {
    const resolved = new Map<string, Session>();
    if (!subagents.length) return resolved;
    const parent = new Map<string, Session>();
    for (const row of subagents) {
        const key = parentKey(row.session, row.session.metadata?.nativeSession?.parentId);
        const found = key ? index.get(key) : undefined;
        if (found && found.id !== row.session.id) parent.set(row.session.id, found);
    }
    if (!parent.size) return resolved;
    for (const row of subagents) {
        const session = row.session;
        if (resolved.has(session.id) || !parent.has(session.id)) continue;
        const path: Session[] = [], seen = new Map<string, number>();
        let current = session, project: Session;
        while (true) {
            const known = resolved.get(current.id);
            if (known) { project = known; break; }
            const cycle = seen.get(current.id);
            if (cycle !== undefined) {
                project = path.slice(cycle).reduce((anchor, item) => item.id < anchor.id ? item : anchor);
                break;
            }
            seen.set(current.id, path.length); path.push(current);
            const next = parent.get(current.id);
            if (!next) { project = current; break; }
            current = next;
        }
        for (const item of path) resolved.set(item.id, project);
    }
    return resolved;
}

function sessionTitle(session: Session): string {
    return session.metadata?.nativeSession?.title || session.metadata?.summary?.text || session.metadata?.name || session.id.slice(0, 8);
}

function matchesSearch(session: Session, title: string, needle: string): boolean {
    if (title.toLocaleLowerCase().includes(needle)) return true;
    const data = session.metadata;
    for (const value of [data?.path, data?.nativeSession?.projectLabel, data?.nativeSession?.projectPath, data?.nativeSession?.agentName, data?.nativeSession?.preview, data?.bridge?.source.id, codelyncSourceLabel(data?.bridge?.source)]) {
        if (value?.toLocaleLowerCase().includes(needle)) return true;
    }
    return false;
}

const byRecency = (a: Entry, b: Entry) => b.at - a.at || a.order - b.order;

/** Build a display forest without changing the original parent's evidence. */
function hierarchy(entries: Entry[]): { roots: Entry[]; children: Map<string, Entry[]> } {
    const nativeIndex = new Map<string, Entry>();
    const ambiguous = new Set<string>();
    for (const entry of entries) {
        if (!entry.nativeId || ambiguous.has(entry.nativeId)) continue;
        if (nativeIndex.has(entry.nativeId)) {
            nativeIndex.delete(entry.nativeId);
            ambiguous.add(entry.nativeId);
        } else nativeIndex.set(entry.nativeId, entry);
    }

    const parentById = new Map<string, string>();
    for (const entry of entries) {
        const parentKeyId = entry.parentId ??= parentKey(entry.session, entry.session.metadata?.nativeSession?.parentId);
        const parent = parentKeyId ? nativeIndex.get(parentKeyId) : undefined;
        if (parent) parentById.set(entry.session.id, parent.session.id);
    }

    // 原实现纯父子环没有 root，整组会话会消失；只断开稳定 ID 最小节点的展示边，保留原始父归属。
    const states = new Map<string, 1 | 2>();
    for (const entry of entries) {
        if (states.has(entry.session.id)) continue;
        const path: string[] = [];
        let current: string | undefined = entry.session.id;
        while (current && states.get(current) !== 2) {
            if (states.get(current) === 1) {
                const start = path.indexOf(current);
                let anchor = current;
                for (let index = start + 1; index < path.length; index++) if (path[index] < anchor) anchor = path[index];
                parentById.delete(anchor);
                break;
            }
            states.set(current, 1);
            path.push(current);
            current = parentById.get(current);
        }
        for (const id of path) states.set(id, 2);
    }

    const roots: Entry[] = [];
    const children = new Map<string, Entry[]>();
    for (const entry of entries) {
        const parent = parentById.get(entry.session.id);
        if (!parent) { roots.push(entry); continue; }
        let bucket = children.get(parent);
        if (!bucket) { bucket = []; children.set(parent, bucket); }
        bucket.push(entry);
    }
    const familyRecency = new Map(entries.map(entry => [entry.session.id, entry.at]));
    // 在已断环的展示森林上后序汇总；新子会话不能藏在旧父组之后，原更新时间及 parentId 不被改写。
    const traversal = roots.map(entry => ({ entry, visited: false }));
    while (traversal.length) {
        const item = traversal.pop()!;
        if (!item.visited) {
            traversal.push({ entry: item.entry, visited: true });
            for (const child of children.get(item.entry.session.id) ?? []) traversal.push({ entry: child, visited: false });
        } else {
            let latest = item.entry.at;
            for (const child of children.get(item.entry.session.id) ?? []) latest = Math.max(latest, familyRecency.get(child.session.id) ?? child.at);
            familyRecency.set(item.entry.session.id, latest);
        }
    }
    roots.sort((a, b) => (familyRecency.get(b.session.id) ?? b.at) - (familyRecency.get(a.session.id) ?? a.at) || Number(b.pinned) - Number(a.pinned) || a.order - b.order);
    for (const bucket of children.values()) bucket.sort(byRecency);
    return { roots, children };
}

export function buildCodelyncBrowserRows(sessions: Session[], query: string, projects: Set<string>, parents: Set<string>): CodelyncBrowserRow[] {
    const needle = query.trim().toLocaleLowerCase();
    const nativeRows: NativeRow[] = [];
    const subagents: NativeRow[] = [];
    const nativeIndex = new Map<string, Session>();
    const ambiguous = new Set<string>();
    for (let order = 0; order < sessions.length; order++) {
        const session = sessions[order];
        if (!isCodelyncNativeSession(session)) continue;
        const data = session.metadata;
        const nativeId = parentKey(session, data?.bridge?.source.id);
        const isSubagent = data?.nativeSession?.isSubagent === true;
        const row: NativeRow = { session, order, nativeId, isSubagent };
        nativeRows.push(row);
        if (isSubagent) subagents.push(row);
        if (nativeId && !ambiguous.has(nativeId)) {
            if (nativeIndex.has(nativeId)) { nativeIndex.delete(nativeId); ambiguous.add(nativeId); }
            else nativeIndex.set(nativeId, session);
        }
    }

    const display = displayProjects(subagents, nativeIndex);
    const projectKeys = new Map<string, string>();
    const groups = new Map<string, Group>();
    for (let i = 0; i < nativeRows.length; i++) {
        const row = nativeRows[i];
        const session = row.session, data = session.metadata;
        const title = needle ? sessionTitle(session) : undefined;
        if (needle && !matchesSearch(session, title!, needle)) continue;
        const entry: Entry = {
            session, order: row.order, title,
            at: data?.nativeSession?.updatedAt ?? session.updatedAt,
            pinned: data?.nativeSession?.isPinned === true,
            nativeId: row.nativeId,
        };
        const project = display.get(session.id) ?? session;
        let key = projectKeys.get(project.id);
        if (key === undefined) { key = codelyncProjectKey(project); projectKeys.set(project.id, key); }
        let group = groups.get(key);
        if (!group) { group = { key, project, entries: [], count: 0, latestAt: entry.at, order: row.order }; groups.set(key, group); }
        group.entries.push(entry);
        if (!row.isSubagent) group.count++;
        // 巨项目不能用 Math.max(...members)：参数数量会溢出；最大时间在分组时计算一次，排序只读标量。
        if (entry.at > group.latestAt) group.latestAt = entry.at;
    }

    const ordered = [...groups.values()].sort((a, b) => b.latestAt - a.latestAt || a.order - b.order);
    const rows: CodelyncBrowserRow[] = [];
    for (const group of ordered) {
        const data = group.project.metadata;
        const path = data?.nativeSession?.projectPath || data?.path || '/';
        const count = group.count;
        if (count) rows.push({ kind: 'project', key: group.key, path, label: data?.nativeSession?.projectLabel || path.split(/[\\/]/).filter(Boolean).at(-1) || path,
            sourceLabel: codelyncSourceLabel(data?.bridge?.source), count });
        if (!needle && (!count || !projects.has(group.key))) continue;

        // 展示桶内仍按完整原生 namespace 解析，不借用其他来源的同名 ID。
        const { roots, children } = hierarchy(group.entries);
        const stack = roots.map(entry => ({ entry, child: false })).reverse();
        const visited = new Set<string>();
        // 原递归 append 在深层子会话链上溢出；显式栈保持原有深度优先顺序和折叠规则。
        while (stack.length) {
            const { entry, child } = stack.pop()!;
            const session = entry.session;
            if (visited.has(session.id)) continue;
            visited.add(session.id);
            const descendants = children.get(session.id);
            entry.title ??= sessionTitle(session);
            rows.push({ kind: 'session', key: session.id, projectId: group.key, session, title: entry.title, child, children: descendants?.length ?? 0, at: entry.at });
            if (descendants && (needle || parents.has(session.id))) {
                for (let index = descendants.length - 1; index >= 0; index--) stack.push({ entry: descendants[index], child: true });
            }
        }
    }
    return rows;
}
