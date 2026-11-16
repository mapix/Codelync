export type NativeViewportMeasurement = { viewportHeight: number; contentHeight: number; windowEnd: number; visibleKey: string; measureVersion: number; ready: boolean };
export type NativeViewportDecision = 'wait' | 'advance' | 'covered' | 'no-progress';

/** One first-viewport budget. Only real content measurements or a visibly
 * unchanged collapsed group settle requested growth; later layouts cannot page. */
export class CodeLightViewportFill {
    private finished: 'covered' | 'no-progress' | null = null;
    private pending: NativeViewportMeasurement | null = null;
    reset() { this.finished = null; this.pending = null; }
    stop(reason: 'covered' | 'no-progress' = 'covered') { this.finished = reason; this.pending = null; }
    get reason() { return this.finished; }
    requested(measurement: NativeViewportMeasurement) { this.pending = { ...measurement }; }
    decide(measurement: NativeViewportMeasurement): NativeViewportDecision {
        if (this.finished) return this.finished;
        if (!measurement.ready || measurement.viewportHeight <= 0 || measurement.contentHeight <= 0 || measurement.windowEnd < 1) return 'wait';
        if (measurement.contentHeight >= measurement.viewportHeight - 1) { this.stop(); return 'covered'; }
        const before = this.pending;
        if (before) {
            if (measurement.windowEnd <= before.windowEnd) return 'wait';
            if (measurement.visibleKey === before.visibleKey) { this.stop('no-progress'); return 'no-progress'; }
            if (measurement.measureVersion <= before.measureVersion) return 'wait';
            if (measurement.contentHeight <= before.contentHeight + 1) { this.stop('no-progress'); return 'no-progress'; }
            this.pending = null;
        }
        return 'advance';
    }
}

/** Explicit native history gestures use one small measured-viewport batch.
 * Initial filling always adds just one complete row. */
export function codeLightViewportBatch(viewportHeight: number, contentHeight: number, visibleItems: number): number {
    const average = visibleItems > 0 && contentHeight > 0 ? contentHeight / visibleItems : 72;
    return Math.max(1, Math.min(8, Math.ceil(Math.max(1, viewportHeight) / Math.max(24, average))));
}
export function codeLightNativeWindowEnd(total: number, desired: number): number { return Math.max(0, Math.min(total, Math.max(1, Math.floor(desired)))); }
