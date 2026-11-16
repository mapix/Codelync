import { expect, it, vi } from 'vitest';
import { retainedConnectionBootstrap } from './retainedConnectionBootstrap';
it('shares a read retry and initializes the retained connection only once after recovery', async () => {
    const read = vi.fn().mockResolvedValueOnce('unavailable'), restore = vi.fn();
    let finish!: (value: string) => void;
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const initialize = retainedConnectionBootstrap(async () => {
        const state = await read(); if (state === 'available') await restore(); return state;
    });
    expect(await initialize()).toBe('unavailable'); expect(restore).not.toHaveBeenCalled();
    const first = initialize(), second = initialize(); expect(first).toBe(second);
    await Promise.resolve(); finish('available'); await first;
    expect(read).toHaveBeenCalledTimes(2); expect(restore).toHaveBeenCalledOnce();
});
