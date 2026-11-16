import { describe, expect, it } from 'vitest';
import { CodeLightViewportFill, codeLightViewportBatch, codeLightNativeWindowEnd, type NativeViewportMeasurement } from './codeLightViewport';
const first: NativeViewportMeasurement = { viewportHeight: 600, contentHeight: 150, windowEnd: 1, visibleKey: 'latest', measureVersion: 1, ready: true };
describe('CodeLight measured viewport', () => {
    it('starts with one row, waits for measurements and stops at the first covered screen', () => {
        const fill = new CodeLightViewportFill(); expect(codeLightNativeWindowEnd(10000, 1)).toBe(1);
        expect(fill.decide({ ...first, ready: false })).toBe('wait'); expect(fill.decide(first)).toBe('advance'); fill.requested(first);
        expect(fill.decide({ ...first, windowEnd: 2, visibleKey: 'latest,older' })).toBe('wait');
        const second = { ...first, contentHeight: 350, windowEnd: 2, visibleKey: 'latest,older', measureVersion: 2 };
        expect(fill.decide(second)).toBe('advance'); fill.requested(second);
        expect(fill.decide({ ...second, contentHeight: 640, windowEnd: 3, visibleKey: 'latest,older,last', measureVersion: 3 })).toBe('covered');
        expect(fill.decide({ ...second, viewportHeight: 1000, contentHeight: 350, measureVersion: 4 })).toBe('covered');
    });
    it('a collapsed group with hidden extra rows stops instead of walking the entire turn', () => {
        const fill = new CodeLightViewportFill(); expect(fill.decide(first)).toBe('advance'); fill.requested(first);
        expect(fill.decide({ ...first, windowEnd: 2 })).toBe('no-progress');
        expect(fill.decide({ ...first, windowEnd: 5000, visibleKey: 'other', measureVersion: 3 })).toBe('no-progress');
    });
    it('a fresh measurement with no height progress stops, and explicit reset owns another visit', () => {
        const fill = new CodeLightViewportFill(); fill.requested(first);
        expect(fill.decide({ ...first, windowEnd: 2, visibleKey: 'second', measureVersion: 2 })).toBe('no-progress'); fill.reset();
        expect(fill.decide(first)).toBe('advance'); fill.stop(); expect(fill.decide(first)).toBe('covered');
        expect(codeLightViewportBatch(600, 300, 4)).toBe(8); expect(codeLightViewportBatch(600, 800, 1)).toBe(1);
    });
});
