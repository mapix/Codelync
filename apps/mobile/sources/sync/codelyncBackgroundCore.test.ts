import { expect, it } from 'vitest';
import { refreshCodelyncBackground, type CodelyncBackgroundCache } from './codelyncBackgroundCore';
const cache = (): CodelyncBackgroundCache => ({ scope: 'fixture', updatedAt: 0, sessions: [], selected: ['visited'], messages: {} });
it('refreshes all titles and only selected history with authenticated reads', async () => {
    const paths: string[] = []; let saved: CodelyncBackgroundCache | undefined;
    await refreshCodelyncBackground({ origin: 'https://fixture.example', token: 'fixture', scope: 'fixture', cache: cache(), stillCurrent: async () => true,
        commit: value => { saved = value; }, request: (async (url, init) => {
            paths.push(String(url)); expect(init?.method).toBeUndefined(); expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fixture');
            return new Response(JSON.stringify(String(url).includes('/messages') ? { messages: [{ id: 'cipher-1', seq: 8, content: { c: 'encrypted' } }] }
                : { sessions: [{ id: 'visited', metadata: 'encrypted' }, { id: 'unvisited', metadata: 'encrypted' }], hasNext: false }));
        }) as typeof fetch });
    expect(paths).toHaveLength(2); expect(paths[1]).toContain('/visited/messages');
    expect(saved?.sessions).toHaveLength(2); expect(saved?.messages.visited.seq).toBe(8);
});
it('discards fetched data if pairing changes during IO', async () => {
    let current = true; let commits = 0;
    const result = await refreshCodelyncBackground({ origin: 'https://fixture.example', token: 'fixture', scope: 'fixture', cache: cache(),
        stillCurrent: async () => current, commit: () => { commits++; }, request: (async () => { current = false; return new Response(JSON.stringify({ sessions: [], hasNext: false })); }) as typeof fetch });
    expect(result).toBe(false); expect(commits).toBe(0);
});
it('keeps ciphertext and cursor together on a failed message request', async () => {
    let commits = 0;
    await expect(refreshCodelyncBackground({ origin: 'https://fixture.example', token: 'fixture', scope: 'fixture', cache: cache(), stillCurrent: async () => true,
        commit: () => { commits++; }, request: (async url => new Response(JSON.stringify({ sessions: [{ id: 'visited' }], hasNext: false }),
            { status: String(url).includes('/messages') ? 503 : 200 })) as typeof fetch })).rejects.toThrow('503');
    expect(commits).toBe(0);
});
it('rejects a cache from another pairing before network IO', async () => {
    let requests = 0;
    await expect(refreshCodelyncBackground({ origin: 'https://fixture.example', token: 'fixture', scope: 'another-account', cache: cache(),
        stillCurrent: async () => true, commit: () => {}, request: (async () => { requests++; return new Response(); }) as typeof fetch })).rejects.toThrow('identity mismatch');
    expect(requests).toBe(0);
});
