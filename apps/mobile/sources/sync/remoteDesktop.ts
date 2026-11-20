import nacl from 'tweetnacl';
import { getRandomBytes } from 'expo-crypto';
import { TokenStorage } from '@/auth/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { peerAuthorization, decodePeerResponse } from './peerNetwork';
import { getServerUrl } from './serverConfig';

export type DesktopViewport = { width: number; height: number };
export type DesktopQuality = { width: 1280 | 1920 | 2560; fps: 15 | 30 | 60 };
export type DesktopPermissions = { screenRecording: boolean; accessibility: boolean; locked: boolean };
export type DesktopDisplay = {
    id: string;
    name: string;
    kind?: 'physical' | 'virtual';
    width: number;
    height: number;
    logicalWidth?: number;
    logicalHeight?: number;
    geometry: string;
};
export type DesktopDisplaysResponse = {
    displays: DesktopDisplay[];
    permissions: DesktopPermissions;
    virtualDisplaySupported?: boolean;
};
export type DesktopWindowItem = {
    id: string;
    pid: number;
    windowId: number;
    appName: string;
    bundleId: string | null;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
    minimized: boolean;
    onVirtualDisplay: boolean;
};
export type DesktopWindowsResponse = {
    windows: DesktopWindowItem[];
    activeWindowId: string | null;
};
export type DesktopWindowActionResponse = {
    display: DesktopDisplay;
    geometry: string;
    trackSid: string;
    viewPending?: boolean;
    permissions?: DesktopPermissions;
    activeWindowId: string | null;
    upshifted?: boolean;
    connected?: boolean;
    capturing?: boolean;
};
export type DesktopStatus = { version: 1; enabled: boolean; mode: 'local' | 'external'; connected: boolean; permissions: DesktopPermissions | null; quality: DesktopQuality };
export type DesktopGrant = { version: 1; connectionId: string; generation: string; key: string; token: string; url: string; hostIdentity: string; display: DesktopDisplay; quality: DesktopQuality; trackSid: string };
export type DesktopInput =
    | { action: 'pointer'; phase: 'move' | 'down' | 'up' | 'click'; x: number; y: number; button?: 'left' | 'right' }
    | { action: 'scroll'; deltaY: number; x?: number; y?: number }
    | { action: 'text'; text: string }
    | { action: 'key'; key: string; modifiers: Array<'command' | 'option' | 'control' | 'shift'> };
export type DesktopSpaceAction = 'previous' | 'next' | 'overview';
export type DesktopView = {
    connected: boolean;
    capturing: boolean;
    geometry: string;
    trackSid: string;
    viewPending?: boolean;
    permissions: DesktopPermissions;
    display?: DesktopDisplay;
    activeWindowId?: string | null;
};
export class DesktopRequestError extends Error { constructor(public readonly code: string) { super(code); } }

export function isVirtualDesktopDisplay(display: Pick<DesktopDisplay, 'id' | 'kind'> | null | undefined): boolean {
    return !!display && (display.kind === 'virtual' || display.id === 'virtual');
}

const LONG_TIMEOUT_ACTIONS = ['join', 'quality', 'display', 'space', 'windows', 'window', 'heartbeat'];
const DETERMINISTIC_WINDOW_ERRORS = new Set([
    'desktop-virtual-display-unavailable',
    'desktop-virtual-display-required',
    'desktop-accessibility-required',
    'desktop-input-permission-required',
    'desktop-window-unavailable',
    'desktop-window-unresponsive',
    'desktop-restore-persist-failed',
    'desktop-view-changed',
    'desktop-display-changed',
    'desktop-locked',
]);

/** Requests have no session identifiers. Secrets and OS input are sealed to the paired Mac. */
export async function desktopRequest<T>(action: string, value: Record<string, unknown> = {}, expectedPeer?: string): Promise<T> {
    const credentials = await TokenStorage.getCredentials(), peer = credentials?.peer;
    if (!credentials || !peer || expectedPeer && peer.id !== expectedPeer) throw new DesktopRequestError('desktop-disconnected');
    const origin = getServerUrl();
    if (!peer.channels.some(channel => channel.url === origin)) throw new DesktopRequestError('desktop-disconnected');
    const method = action === 'status' ? 'GET' : 'POST', url = origin.replace(/\/$/, '') + '/api/peer/desktop/' + action;
    let body: string | undefined;
    if (method === 'POST') {
        const nonce = getRandomBytes(24), input = new TextEncoder().encode(JSON.stringify({ ...value, version: 1, action, at: Date.now() }));
        if (input.length > 8192) throw new DesktopRequestError('invalid-desktop-input');
        const ciphertext = nacl.box(input, nonce, decodeBase64(peer.key, 'base64url'), decodeBase64(peer.device.secretKey, 'base64url'));
        body = JSON.stringify({ version: 1, nonce: encodeBase64(nonce, 'base64url'), ciphertext: encodeBase64(ciphertext, 'base64url') });
    }
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), LONG_TIMEOUT_ACTIONS.includes(action) ? 25_000 : 10_000);
    try {
        if (getServerUrl() !== origin) throw new DesktopRequestError('desktop-disconnected');
        const response = await fetch(url, { method, body, signal: abort.signal, headers: {
            'Content-Type': 'application/json', Authorization: peerAuthorization(credentials.token, peer, origin, method, url) } });
        if (!response.ok) {
            let code = 'desktop-relay-unavailable';
            try { const result = await response.json(); if (typeof result.error === 'string') code = result.error; } catch { /* fixed local error */ }
            if (action === 'input' && response.status >= 500 && !['desktop-input-permission-required', 'desktop-locked'].includes(code)) code = 'desktop-operation-unknown';
            if (action === 'space' && response.status >= 500 && !['desktop-space-shortcut-disabled', 'desktop-space-shortcut-unavailable', 'desktop-input-permission-required', 'desktop-view-changed', 'desktop-locked'].includes(code)) code = 'desktop-operation-unknown';
            if (action === 'window' && response.status >= 500 && !DETERMINISTIC_WINDOW_ERRORS.has(code)) code = 'desktop-operation-unknown';
            throw new DesktopRequestError(code);
        }
        const result = decodePeerResponse(peer, await response.json());
        const current = await TokenStorage.getCredentials();
        if (getServerUrl() !== origin || current?.peer?.id !== peer.id || current.peer.device.publicKey !== peer.device.publicKey) throw new DesktopRequestError('desktop-disconnected');
        return result as T;
    } catch (error) {
        if (error instanceof DesktopRequestError) throw error;
        if ((error as { code?: string })?.code === 'preferred-route-unavailable') throw Object.assign(new DesktopRequestError('preferred-route-unavailable'), { effectMayHaveOccurred: false });
        throw new DesktopRequestError(action === 'input' || action === 'space' || action === 'window' ? 'desktop-operation-unknown' : 'desktop-relay-unavailable');
    } finally { clearTimeout(timeout); }
}

export function desktopBinding(grant: DesktopGrant) {
    return { connectionId: grant.connectionId, generation: grant.generation, geometry: grant.display.geometry };
}

export type SafeAreaInsetsLike = { top: number; right: number; bottom: number; left: number };
export type WindowMetricsLike = { frame: { width: number; height: number }; insets: SafeAreaInsetsLike };
export type PortraitSafeViewportInput = {
    window: { width: number; height: number };
    insets: SafeAreaInsetsLike;
    keyboardHeight?: number;
    cachedPortrait?: DesktopViewport | null;
    initialMetrics?: WindowMetricsLike | null;
    platformOS?: string;
    platformOs?: string;
    isPad?: boolean;
};

function safeInset(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function clampPortraitDimensions(rawSafeW: number, rawSafeH: number): DesktopViewport {
    if (!Number.isFinite(rawSafeW) || !Number.isFinite(rawSafeH)) {
        return { width: 540, height: 1080 };
    }
    const width = Math.min(10_000, Math.max(100, Math.round(rawSafeW)));
    const height = Math.min(10_000, Math.max(width, Math.round(rawSafeH)));
    return { width, height };
}

/** Pure 3-tier portrait safe-area resolver without React Native runtime imports or model tables. */
export function resolvePortraitSafeViewport({
    window,
    insets,
    keyboardHeight = 0,
    cachedPortrait = null,
    initialMetrics = null,
    platformOS,
    platformOs,
    isPad = false,
}: PortraitSafeViewportInput): DesktopViewport {
    const os = platformOS ?? platformOs ?? 'ios';
    if (Number.isFinite(window.width) && Number.isFinite(window.height)
        && window.width > 0 && window.height > window.width && keyboardHeight <= 0) {
        const rawW = Math.max(1, window.width - safeInset(insets.left) - safeInset(insets.right));
        const rawH = Math.max(1, window.height - safeInset(insets.top) - safeInset(insets.bottom));
        return clampPortraitDimensions(rawW, rawH);
    }
    if (cachedPortrait && Number.isFinite(cachedPortrait.width) && Number.isFinite(cachedPortrait.height)
        && cachedPortrait.width > 0 && cachedPortrait.height > 0) {
        return clampPortraitDimensions(cachedPortrait.width, cachedPortrait.height);
    }
    if (initialMetrics && Number.isFinite(initialMetrics.frame.width) && Number.isFinite(initialMetrics.frame.height)
        && initialMetrics.frame.width > 0 && initialMetrics.frame.height > initialMetrics.frame.width) {
        const rawW = Math.max(1, initialMetrics.frame.width - safeInset(initialMetrics.insets.left) - safeInset(initialMetrics.insets.right));
        const rawH = Math.max(1, initialMetrics.frame.height - safeInset(initialMetrics.insets.top) - safeInset(initialMetrics.insets.bottom));
        return clampPortraitDimensions(rawW, rawH);
    }
    if (!Number.isFinite(window.width) || !Number.isFinite(window.height) || window.width <= 0 || window.height <= 0) {
        return { width: 540, height: 1080 };
    }
    const portraitWidth = Math.min(window.width, window.height);
    const portraitHeight = Math.max(window.width, window.height);
    const portraitTop = Math.max(safeInset(insets.top), safeInset(insets.left), safeInset(insets.right));
    const rawBottom = safeInset(insets.bottom);
    const portraitBottom = os === 'ios' && !isPad && rawBottom > 0 ? 34 : rawBottom;
    return clampPortraitDimensions(portraitWidth, Math.max(1, portraitHeight - portraitTop - portraitBottom));
}

/** Inverse transform for the fitted video and its user-selected zoom/pan. */
export function desktopPoint(x: number, y: number, viewport: { width: number; height: number }, display: { width: number; height: number }, zoom = 1, offset = { x: 0, y: 0 }) {
    const scale = Math.min(viewport.width / display.width, viewport.height / display.height) * zoom;
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const width = display.width * scale, height = display.height * scale;
    const normalized = { x: (x - (viewport.width - width) / 2 - offset.x) / width, y: (y - (viewport.height - height) / 2 - offset.y) / height };
    return normalized.x >= 0 && normalized.x <= 1 && normalized.y >= 0 && normalized.y <= 1 ? normalized : null;
}
