import { describe, expect, it } from 'vitest';
import { CodelyncViewportFill, codelyncViewportBatch, codelyncNativeWindowEnd, MAX_COLLAPSED_FILL_STEPS, type NativeViewportMeasurement } from './codelyncViewport';
const first: NativeViewportMeasurement = { viewportHeight: 600, contentHeight: 150, windowEnd: 1, visibleKey: 'latest', measureVersion: 1, ready: true };
describe('Codelync measured viewport', () => {
    it('starts with one row, waits for measurements and stops at the first covered screen', () => {
        const fill = new CodelyncViewportFill(); expect(codelyncNativeWindowEnd(10000, 1)).toBe(1);
        expect(fill.decide({ ...first, ready: false })).toBe('wait'); expect(fill.decide(first)).toBe('advance'); fill.requested(first);
        expect(fill.decide({ ...first, windowEnd: 2, visibleKey: 'latest,older' })).toBe('wait');
        const second = { ...first, contentHeight: 350, windowEnd: 2, visibleKey: 'latest,older', measureVersion: 2 };
        expect(fill.decide(second)).toBe('advance'); fill.requested(second);
        expect(fill.decide({ ...second, contentHeight: 640, windowEnd: 3, visibleKey: 'latest,older,last', measureVersion: 3 })).toBe('covered');
        expect(fill.decide({ ...second, viewportHeight: 1000, contentHeight: 350, measureVersion: 4 })).toBe('covered');
    });
    it('a collapsed group with hidden extra rows stops when boundary is unchanged', () => {
        const fill = new CodelyncViewportFill(); expect(fill.decide(first)).toBe('advance'); fill.requested(first);
        expect(fill.decide({ ...first, windowEnd: 2 })).toBe('no-progress');
        expect(fill.decide({ ...first, windowEnd: 5000, visibleKey: 'other', measureVersion: 3 })).toBe('no-progress');
    });
    it('traverses bounded collapsed-tail boundary advances until real content covers the viewport, then caps unbounded tool runs', () => {
        const fill = new CodelyncViewportFill();
        let m: NativeViewportMeasurement = { viewportHeight: 600, contentHeight: 44, windowEnd: 2, visibleKey: 'tools-group', boundaryKey: 'tools-group:t10', collapsedTail: true, measureVersion: 1, ready: true };
        expect(fill.decide(m)).toBe('advance');
        fill.requested(m);
        for (let step = 1; step <= MAX_COLLAPSED_FILL_STEPS; step++) {
            m = { ...m, windowEnd: 2 + step * 8, boundaryKey: `tools-group:t${10 + step}` };
            expect(fill.decide(m)).toBe('advance');
            fill.requested(m);
        }
        expect(fill.decide({ ...m, windowEnd: 200, boundaryKey: 'tools-group:t99' })).toBe('no-progress');

        fill.reset();
        const start: NativeViewportMeasurement = { viewportHeight: 600, contentHeight: 44, windowEnd: 2, visibleKey: 'tools-group', boundaryKey: 'tools-group:t2', collapsedTail: true, measureVersion: 1, ready: true };
        expect(fill.decide(start)).toBe('advance'); fill.requested(start);
        const mid = { ...start, windowEnd: 10, boundaryKey: 'tools-group:t1' };
        expect(fill.decide(mid)).toBe('advance'); fill.requested(mid);
        const withUser = { ...mid, contentHeight: 180, windowEnd: 11, visibleKey: 'tools-group\nuser-1', boundaryKey: 'user-1', collapsedTail: false, measureVersion: 2 };
        expect(fill.decide(withUser)).toBe('advance'); fill.requested(withUser);
        expect(fill.decide({ ...withUser, contentHeight: 640, windowEnd: 12, visibleKey: 'tools-group\nuser-1\nassistant-1', boundaryKey: 'assistant-1', measureVersion: 3 })).toBe('covered');
    });
    it('a fresh measurement with no height progress stops, and explicit reset owns another visit', () => {
        const fill = new CodelyncViewportFill(); fill.requested(first);
        expect(fill.decide({ ...first, windowEnd: 2, visibleKey: 'second', measureVersion: 2 })).toBe('no-progress'); fill.reset();
        expect(fill.decide(first)).toBe('advance'); fill.stop(); expect(fill.decide(first)).toBe('covered');
        expect(codelyncViewportBatch(600, 300, 4)).toBe(8); expect(codelyncViewportBatch(600, 800, 1)).toBe(1);
    });
});
