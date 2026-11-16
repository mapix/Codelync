import type { DesktopInput } from './remoteDesktop';

/** A successful HTTP response alone does not confirm native insertion. */
export function desktopInputAcknowledged(receipt: unknown, sequence: number): boolean {
    return !!receipt && typeof receipt === 'object' && !Array.isArray(receipt)
        && (receipt as { accepted?: unknown }).accepted === true
        && (receipt as { sequence?: unknown }).sequence === sequence;
}

export class DesktopInputQueueError extends Error {
    readonly code = 'desktop-input-busy';
    constructor() { super('desktop-input-busy'); this.name = 'DesktopInputQueueError'; }
}

/** Moves and adjacent bounded scrolls may coalesce; other input keeps its order. */
export class DesktopInputQueue {
    private closed = false;
    private running = false;
    private waiting: Array<{ input: DesktopInput; resolve: (accepted: boolean) => void }> = [];
    constructor(private readonly dispatch: (input: DesktopInput) => Promise<void>, private readonly failed: (error: unknown) => void) {}
    send(input: DesktopInput): Promise<boolean> {
        if (this.closed) return Promise.resolve(false);
        return new Promise(resolve => {
            const last = this.waiting[this.waiting.length - 1];
            if (input.action === 'pointer' && input.phase === 'move' && last?.input.action === 'pointer' && last.input.phase === 'move') {
                last.resolve(false); this.waiting[this.waiting.length - 1] = { input, resolve };
            } else if (input.action === 'scroll' && last?.input.action === 'scroll'
                && Math.sign(input.deltaY) === Math.sign(last.input.deltaY)
                && Math.abs(input.deltaY + last.input.deltaY) <= 1200) {
                last.resolve(false); this.waiting[this.waiting.length - 1] = { input: { action: 'scroll', deltaY: input.deltaY + last.input.deltaY }, resolve };
            } else if (this.waiting.length < 16) this.waiting.push({ input, resolve });
            else { resolve(false); this.close(); this.failed(new DesktopInputQueueError()); }
            void this.drain();
        });
    }
    private async drain() {
        if (this.running || this.closed) return;
        this.running = true;
        try {
            while (!this.closed && this.waiting.length) {
                const next = this.waiting.shift()!;
                try { await this.dispatch(next.input); next.resolve(!this.closed); }
                catch (error) { next.resolve(false); this.close(); this.failed(error); }
            }
        } finally { this.running = false; }
    }
    close() { this.closed = true; for (const next of this.waiting) next.resolve(false); this.waiting = []; }
}
