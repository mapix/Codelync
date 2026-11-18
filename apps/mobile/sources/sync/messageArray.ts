/** Merge only changed rows into a newest-first array; lifecycle events keep the exact reference. */
export function mergeMessageArray<T extends { id: string }>(previous: T[], changed: T[], removed: readonly string[], key: (value: T) => number): T[] {
    if (!changed.length && !removed.length) return previous;

    // Fast path for single-row streaming updates and inserts: avoids Map/Set allocations and O(M) ordinal maps.
    if (changed.length === 1 && removed.length === 0) {
        const row = changed[0];
        const len = previous.length;
        if (len === 0) return [row];
        const rowKey = key(row);
        if (previous[0].id === row.id) {
            if (previous[0] === row) return previous;
            if (len === 1 || rowKey >= key(previous[1])) {
                const next = previous.slice();
                next[0] = row;
                return next;
            }
        }
        let existingIdx = -1;
        for (let i = 0; i < len; i++) {
            if (previous[i].id === row.id) { existingIdx = i; break; }
        }
        if (existingIdx !== -1) {
            if (previous[existingIdx] === row) return previous;
            const prevOk = existingIdx === 0 || key(previous[existingIdx - 1]) >= rowKey;
            const nextOk = existingIdx === len - 1 || rowKey >= key(previous[existingIdx + 1]);
            if (prevOk && nextOk) {
                const next = previous.slice();
                next[existingIdx] = row;
                return next;
            }
            const next: T[] = [];
            let inserted = false;
            for (let i = 0; i < len; i++) {
                if (i === existingIdx) continue;
                if (!inserted) {
                    const candidateKey = key(previous[i]);
                    const staysBefore = candidateKey > rowKey || (candidateKey === rowKey && i < existingIdx);
                    if (!staysBefore) {
                        next.push(row);
                        inserted = true;
                    }
                }
                next.push(previous[i]);
            }
            if (!inserted) next.push(row);
            return next;
        }
        let insertAt = 0;
        while (insertAt < len && key(previous[insertAt]) >= rowKey) insertAt++;
        const next = previous.slice(0, insertAt);
        next.push(row);
        for (let i = insertAt; i < len; i++) next.push(previous[i]);
        return next;
    }

    const deleted = removed.length ? new Set(removed) : null;
    const updates = new Map<string, T>();
    for (const row of changed) updates.set(row.id, row);
    const retained: T[] = [];
    const retainedOrdinals: number[] = [];
    const updateOrdinals = new Map<string, number>();
    let dirty = false;
    for (let index = 0; index < previous.length; index++) {
        const row = previous[index];
        const updated = updates.get(row.id);
        if (deleted?.has(row.id) && updated === undefined) { dirty = true; continue; }
        if (updated !== undefined) {
            updateOrdinals.set(row.id, index);
            if (updated === row) { updates.delete(row.id); retained.push(row); retainedOrdinals.push(index); }
            else dirty = true;
        } else {
            retained.push(row);
            retainedOrdinals.push(index);
        }
    }
    if (!dirty && !updates.size) return previous;
    let ordinal = previous.length;
    for (const row of updates.values()) if (!updateOrdinals.has(row.id)) updateOrdinals.set(row.id, ordinal++);
    const sorted = [...updates.values()].sort((a, b) => key(b) - key(a) || updateOrdinals.get(a.id)! - updateOrdinals.get(b.id)!);
    const result: T[] = [];
    let i = 0, j = 0;
    while (i < retained.length && j < sorted.length) {
        const retKey = key(retained[i]), updKey = key(sorted[j]);
        if (retKey > updKey || (retKey === updKey && retainedOrdinals[i] <= updateOrdinals.get(sorted[j].id)!)) {
            result.push(retained[i++]);
        } else {
            result.push(sorted[j++]);
        }
    }
    while (i < retained.length) result.push(retained[i++]);
    while (j < sorted.length) result.push(sorted[j++]);
    return result;
}

type CatalogRow = { updatedAt: number; metadata?: { isSideChat?: boolean } | null };
const catalogs = new WeakMap<object, CatalogRow[]>();
/** Unrelated message writes must not repeatedly allocate/sort the whole encrypted catalog. */
export function selectCatalog<T extends CatalogRow>(sessions: Record<string, T>): T[] {
    let result = catalogs.get(sessions);
    if (!result) { result = Object.values(sessions).filter(row => !row.metadata?.isSideChat).sort((a, b) => b.updatedAt - a.updatedAt); catalogs.set(sessions, result); }
    return result as T[];
}
