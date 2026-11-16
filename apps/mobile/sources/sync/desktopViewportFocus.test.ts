import { describe, expect, it, vi } from 'vitest';
import { desktopViewportFocus } from './desktopViewportFocus';

// Only desktopPoint is exercised; isolate the same module's native transport.
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn() }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: {} }));
vi.mock('@/encryption/base64', () => ({ decodeBase64: vi.fn(), encodeBase64: vi.fn() }));
vi.mock('./peerNetwork', () => ({ peerAuthorization: vi.fn(), decodePeerResponse: vi.fn() }));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn() }));
import { desktopPoint } from './remoteDesktop';

describe('local desktop focus during keyboard layout', () => {
    it('maps the smaller viewport center back to the selected remote point', () => {
        const display = { width: 1920, height: 1200 }, previous = { width: 844, height: 390 }, next = { width: 844, height: 160 };
        const target = { x: .82, y: .67 };
        const camera = desktopViewportFocus(display, previous, next, { zoom: 1.4, offset: { x: 17, y: -23 } }, target)!;
        const mapped = desktopPoint(next.width / 2, next.height / 2, next, display, camera.zoom, camera.offset)!;
        expect(mapped.x).toBeCloseTo(target.x, 12); expect(mapped.y).toBeCloseTo(target.y, 12);
    });

    it('retains the desktop pixel scale when the zoom cap is not reached', () => {
        const display = { width: 1440, height: 900 }, previous = { width: 900, height: 420 }, next = { width: 900, height: 220 };
        const original = { zoom: 1.25, offset: { x: -18, y: 22 } }, target = { x: .3, y: .8 };
        const camera = desktopViewportFocus(display, previous, next, original, target)!;
        expect(camera.zoom).toBeLessThan(4);
        const oldScale = Math.min(previous.width / display.width, previous.height / display.height) * original.zoom;
        const newScale = Math.min(next.width / display.width, next.height / display.height) * camera.zoom;
        expect(newScale).toBeCloseTo(oldScale, 12);
        const mapped = desktopPoint(next.width / 2, next.height / 2, next, display, camera.zoom, camera.offset)!;
        expect(mapped.x).toBeCloseTo(target.x, 12); expect(mapped.y).toBeCloseTo(target.y, 12);
    });

    it('caps zoom safely and leaves an unselected or invalid viewport unchanged', () => {
        const display = { width: 1440, height: 900 }, previous = { width: 900, height: 420 }, next = { width: 900, height: 72 };
        const original = Object.freeze({ zoom: 3, offset: Object.freeze({ x: 12, y: -9 }) }), target = { x: .93, y: .07 };
        const camera = desktopViewportFocus(display, previous, next, original, target)!;
        expect(camera.zoom).toBe(4);
        const mapped = desktopPoint(next.width / 2, next.height / 2, next, display, camera.zoom, camera.offset)!;
        expect(mapped.x).toBeCloseTo(target.x, 12); expect(mapped.y).toBeCloseTo(target.y, 12);
        expect(desktopViewportFocus(display, previous, next, original, null)).toBeNull();
        expect(desktopViewportFocus(display, previous, { width: 0, height: 72 }, original, target)).toBeNull();
        expect(desktopViewportFocus(display, previous, next, original, { x: NaN, y: .5 })).toBeNull();
        expect(original).toEqual({ zoom: 3, offset: { x: 12, y: -9 } });
    });
});
