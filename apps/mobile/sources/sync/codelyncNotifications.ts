import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { AppState, Platform } from 'react-native';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { config } from '@/config';
import { getServerUrl } from './serverConfig';
import { apiSocket } from './apiSocket';
import { abortBudget } from './abortBudget';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CodelyncPresenceSequence } from './codelyncPresenceSequence';
const foregroundSequences = new CodelyncPresenceSequence(AsyncStorage);

async function postDevice(credentials: AuthCredentials, path: string, value: unknown, signal?: AbortSignal) {
    const deadline = abortBudget(signal, 5000);
    try {
    if (credentials.peer) {
        // 同一 Mac 的入口可改变，前台保活不能继续使用旧地址/Bearer，否则可见会话会被误回收。
        if (apiSocket.peerIdentity() !== 'peer:' + credentials.peer.id) throw Error('Device peer changed');
        const response = await apiSocket.request(path, { method: 'POST', signal: deadline.signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
        if (!response.ok) throw Error(`Device request failed: ${response.status}`);
        return response.json() as Promise<{ registered: boolean; available: boolean }>;
    }
    const origin = credentials.serverUrl ?? getServerUrl();
    if (origin !== getServerUrl()) throw Error('Notification origin changed');
        const response = await fetch(origin + path, { method: 'POST', signal: deadline.signal,
            headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
        if (!response.ok) throw Error(`Notification registration failed: ${response.status}`);
        return response.json() as Promise<{ registered: boolean; available: boolean }>;
    } finally { deadline.dispose(); }
}
export async function syncCodelyncPushToken(credentials: AuthCredentials, granted: boolean) {
    if (!granted) { await postDevice(credentials, '/codelync/notifications/device', { enabled: false }); return null; }
    const environment = config.codelyncPushEnvironment;
    // 通知权限不等于 APNs entitlement；本地试装包未配置推送签名时不能借用上游 Expo 项目。
    if (Platform.OS !== 'ios' || !Device.isDevice || !environment) return null;
    const token = (await Notifications.getDevicePushTokenAsync()).data;
    if (typeof token !== 'string') throw Error('Native push token unavailable');
    const result = await postDevice(credentials, '/codelync/notifications/device', { enabled: true, token, environment });
    return result.registered && result.available ? token : null;
}
let presenceStop: (() => void) | null = null;
let presenceSend: (() => void) | null = null;
/** Session focus/re-entry renews the current viewer without waiting for a timer. */
export function renewCodelyncPresence() { presenceSend?.(); }
export function startCodelyncPresence(credentials: AuthCredentials, viewingSession: () => string | null, subscribe: (changed: () => void) => () => void) {
    presenceStop?.();
    const cancellation = new AbortController();
    let closed = false, running = false, dirty = false, lastSession = viewingSession();
    const pump = async () => {
        if (closed || running) return;
        running = true;
        try {
            while (!closed && dirty) {
                dirty = false;
                try {
                    const scope = credentials.peer ? 'peer:' + credentials.peer.id : 'origin:' + (credentials.serverUrl ?? getServerUrl());
                    const sequence = await foregroundSequences.next(scope);
                    if (closed) break;
                    const value = { active: AppState.currentState === 'active', sessionId: viewingSession(), sequence };
                    await postDevice(credentials, '/codelync/notifications/presence', value, cancellation.signal);
                } catch { /* A failed scope/sequence cannot send an unordered stale viewer. */ }
            }
        } finally { running = false; }
    };
    const send = () => { if (!closed) { dirty = true; void pump(); } };
    presenceSend = send;
    const appState = AppState.addEventListener('change', send);
    const release = subscribe(() => { const next = viewingSession(); if (next !== lastSession) { lastSession = next; send(); } });
    const timer = setInterval(() => { if (AppState.currentState === 'active') send(); }, 15000);
    presenceStop = () => { closed = true; dirty = false; cancellation.abort(); clearInterval(timer); appState.remove(); release(); if (presenceSend === send) presenceSend = null; };
    send();
    return presenceStop;
}
