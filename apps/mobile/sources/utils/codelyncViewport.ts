export type NativeViewportMeasurement = {
    viewportHeight: number;
    contentHeight: number;
    windowEnd: number;
    visibleKey: string;
    boundaryKey?: string;
    collapsedTail?: boolean;
    measureVersion: number;
    ready: boolean;
};
export type NativeViewportDecision = 'wait' | 'advance' | 'covered' | 'no-progress';

export const MAX_COLLAPSED_FILL_STEPS = 12;

/** One first-viewport budget. Real content measurements or bounded boundary
 * advances across a collapsed tail group extend the window until covered. */
export class CodelyncViewportFill {
    private finished: 'covered' | 'no-progress' | null = null;
    private pending: NativeViewportMeasurement | null = null;
    private collapsedSteps = 0;
    reset() { this.finished = null; this.pending = null; this.collapsedSteps = 0; }
    stop(reason: 'covered' | 'no-progress' = 'covered') { this.finished = reason; this.pending = null; this.collapsedSteps = 0; }
    get reason() { return this.finished; }
    requested(measurement: NativeViewportMeasurement) { this.pending = { ...measurement }; }
    decide(measurement: NativeViewportMeasurement): NativeViewportDecision {
        if (this.finished) return this.finished;
        if (!measurement.ready || measurement.viewportHeight <= 0 || measurement.contentHeight <= 0 || measurement.windowEnd < 1) return 'wait';
        if (measurement.contentHeight >= measurement.viewportHeight - 1) { this.stop(); return 'covered'; }
        const before = this.pending;
        if (before) {
            if (measurement.windowEnd <= before.windowEnd) return 'wait';
            const boundaryChanged = measurement.boundaryKey !== undefined
                && before.boundaryKey !== undefined
                && measurement.boundaryKey !== before.boundaryKey;
            if (measurement.visibleKey === before.visibleKey) {
                if (measurement.collapsedTail && boundaryChanged && this.collapsedSteps < MAX_COLLAPSED_FILL_STEPS) {
                    this.collapsedSteps += 1;
                    this.pending = null;
                    return 'advance';
                }
                this.stop('no-progress');
                return 'no-progress';
            }
            if (measurement.measureVersion <= before.measureVersion) return 'wait';
            if (measurement.contentHeight <= before.contentHeight + 1) {
                if (measurement.collapsedTail && boundaryChanged && this.collapsedSteps < MAX_COLLAPSED_FILL_STEPS) {
                    this.collapsedSteps += 1;
                    this.pending = null;
                    return 'advance';
                }
                this.stop('no-progress');
                return 'no-progress';
            }
            this.collapsedSteps = 0;
            this.pending = null;
        }
        return 'advance';
    }
}

/** Explicit native history gestures use one small measured-viewport batch.
 * Initial filling always adds just one complete row. */
export function codelyncViewportBatch(viewportHeight: number, contentHeight: number, visibleItems: number): number {
    const average = visibleItems > 0 && contentHeight > 0 ? contentHeight / visibleItems : 72;
    return Math.max(1, Math.min(8, Math.ceil(Math.max(1, viewportHeight) / Math.max(24, average))));
}
export function codelyncNativeWindowEnd(total: number, desired: number): number { return Math.max(0, Math.min(total, Math.max(1, Math.floor(desired)))); }
