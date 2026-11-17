import { describe, expect, it } from 'vitest';
import {
    getSessionRouteFromNotificationData,
    getSessionRouteFromNotificationResponse,
} from './notificationRouting';

describe('getSessionRouteFromNotificationData', () => {
    it('returns a session route when sessionId exists', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: 'session-123' })).toBe('/session/session-123');
    });

    it('encodes session ids that contain spaces', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: 'session 123' })).toBe('/session/session%20123');
    });

    it('returns null when sessionId is missing', () => {
        expect(getSessionRouteFromNotificationData({ kind: 'done' })).toBeNull();
    });

    it('returns null for empty session ids', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: '   ' })).toBeNull();
    });

    it('uses a session url when present', () => {
        expect(getSessionRouteFromNotificationData({ url: '/session/session-123' })).toBe('/session/session-123');
    });
});

describe('getSessionRouteFromNotificationResponse', () => {
    it('uses stable Mac identity across endpoint changes and rejects another Mac', () => {
        const response = { notification: { request: { content: { data: { sessionId: 'session', peerId: 'same-mac', origin: 'old-tunnel' } } } } };
        expect(getSessionRouteFromNotificationResponse(response, 'new-tunnel', 'same-mac')).toBe('/session/session');
        expect(getSessionRouteFromNotificationResponse(response, 'old-tunnel', 'another-mac')).toBeNull();
        expect(getSessionRouteFromNotificationResponse(response, 'old-tunnel')).toBeNull();
        const legacy = { notification: { request: { content: { data: { sessionId: 'session', origin: 'old-tunnel' } } } } };
        expect(getSessionRouteFromNotificationResponse(legacy, 'new-tunnel', 'same-mac')).toBeNull();
    });
    it('reads the route from content data', () => {
        expect(getSessionRouteFromNotificationResponse({
            notification: {
                request: {
                    content: {
                        data: { sessionId: 'session-123' }
                    }
                }
            }
        })).toBe('/session/session-123');
    });

    it('returns null when content data is missing', () => {
        expect(getSessionRouteFromNotificationResponse({
            notification: {
                request: {
                    content: {}
                }
            }
        })).toBeNull();
    });
});
