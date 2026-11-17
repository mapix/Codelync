import * as React from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { randomUUID } from 'expo-crypto';
import { TokenStorage } from '@/auth/tokenStorage';
import { apiSocket } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import { codelyncAccountScope } from '@/sync/codelyncBackgroundCache';
import { CodelyncProjectActivityController, codelyncProjectActivityStore, type CodelyncProjectDescriptor } from '@/sync/codelyncProjectActivity';
import { CodelyncActivityTransport } from '@/sync/codelyncActivityTransport';
import type { Session } from '@/sync/storageTypes';
import { codelyncSessionActivityScope } from './useCodelyncSessionActivity';
import { codelyncSavedHistory } from '@/utils/nativeSavedHistory';
import { sealPeerRequest } from '@/sync/peerNetwork';

export async function requestCodelyncActivity(body: Record<string, unknown>): Promise<Response> {
    const identity = apiSocket.peerIdentity(), credentials = await TokenStorage.getCredentials();
    if (!identity || !credentials?.peer || identity !== 'peer:' + credentials.peer.id || apiSocket.peerIdentity() !== identity) throw Error('Activity request peer changed');
    const carrier = sealPeerRequest(credentials.peer, body, '/api/peer/activity', 'POST');
    if (apiSocket.peerIdentity() !== identity) throw Error('Activity request peer changed');
    return apiSocket.peerRequest('/api/peer/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(carrier) });
}

export async function codelyncActivityScope() {
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) return '';
    if (credentials.peer && apiSocket.peerIdentity() !== 'peer:' + credentials.peer.id) return '';
    return (credentials.peer ? 'peer:' + credentials.peer.id : getServerUrl()) + ':' + await codelyncAccountScope(credentials);
}

export function useCodelyncProjectActivities(projects: CodelyncProjectDescriptor[], screenActive = true) {
    const focused = useIsFocused();
    const [foreground, setForeground] = React.useState(AppState.currentState === 'active');
    const controller = React.useMemo(() => {
        const transport = new CodelyncActivityTransport({ peerIdentity: () => apiSocket.peerIdentity(), endpoint: getServerUrl,
            request: requestCodelyncActivity });
        return new CodelyncProjectActivityController({ store: codelyncProjectActivityStore, clientId: randomUUID(),
            scope: codelyncActivityScope, request: (machine, params, authority) => apiSocket.peerIdentity()
                ? transport.read(machine, params, authority) : apiSocket.machineRPC(machine, 'codelync-project-activity', params) });
    }, []);
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
        return () => subscription.remove();
    }, []);
    React.useEffect(() => { controller.setProjects(projects); }, [controller, projects]);
    React.useEffect(() => { controller.setEnabled(focused && foreground && screenActive); }, [controller, focused, foreground, screenActive]);
    // StrictMode 会先清理再重新设置 effects；停采已释放所有资源，不能把可重用控制器永久标成 closed。
    React.useEffect(() => () => controller.setEnabled(false), [controller]);
}

export function useCodelyncSelectedSessionActivity(session: Session | null, active: boolean) {
    const key = codelyncSessionActivityScope(session), source = session?.metadata?.bridge?.source;
    const projects = React.useMemo<CodelyncProjectDescriptor[]>(() => key && session && source && session.metadata?.nativeSession?.isSubagent !== true
        && session.metadata?.nativeSession?.catalogueAvailable !== false && session.metadata?.nativeSession?.archived !== true && !codelyncSavedHistory(session)
        ? [{ id: 'selected:' + session.id, projectKey: session.metadata?.nativeSession?.projectKey || session.metadata?.path || '/',
            machineId: session.metadata!.machineId!, app: source.app as CodelyncProjectDescriptor['app'], hostId: source.hostId,
            sessions: [{ id: session.id, nativeId: source.id }] }] : [], [key, session?.id, session?.metadata?.path, session?.metadata?.nativeSession?.projectKey, session?.metadata?.nativeSession?.isSubagent,
            session?.metadata?.nativeSession?.catalogueAvailable, session?.metadata?.nativeSession?.archived, session?.metadata?.nativeSavedHistory]);
    useCodelyncProjectActivities(projects, active);
}

export function useCodelyncProjectActivity(id: string) {
    const subscribe = React.useCallback((changed: () => void) => codelyncProjectActivityStore.subscribe(id, changed), [id]);
    const get = React.useCallback(() => codelyncProjectActivityStore.get(id), [id]);
    return React.useSyncExternalStore(subscribe, get);
}

export function useCodelyncSessionActivity(id: string) {
    const subscribe = React.useCallback((changed: () => void) => codelyncProjectActivityStore.subscribeSession(id, changed), [id]);
    const get = React.useCallback(() => codelyncProjectActivityStore.getSession(id), [id]);
    return React.useSyncExternalStore(subscribe, get);
}
