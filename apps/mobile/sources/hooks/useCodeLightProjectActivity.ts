import * as React from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { randomUUID } from 'expo-crypto';
import { TokenStorage } from '@/auth/tokenStorage';
import { apiSocket } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import { codeLightAccountScope } from '@/sync/codeLightBackgroundCache';
import { CodeLightProjectActivityController, codeLightProjectActivityStore, type CodeLightProjectDescriptor } from '@/sync/codeLightProjectActivity';
import { CodeLightActivityTransport } from '@/sync/codeLightActivityTransport';
import type { Session } from '@/sync/storageTypes';
import { codeLightSessionActivityScope } from './useCodeLightSessionActivity';
import { codeLightSavedHistory } from '@/utils/nativeSavedHistory';
import { sealPeerRequest } from '@/sync/peerNetwork';

export async function requestCodeLightActivity(body: Record<string, unknown>): Promise<Response> {
    const identity = apiSocket.peerIdentity(), credentials = await TokenStorage.getCredentials();
    if (!identity || !credentials?.peer || identity !== 'peer:' + credentials.peer.id || apiSocket.peerIdentity() !== identity) throw Error('Activity request peer changed');
    const carrier = sealPeerRequest(credentials.peer, body, '/api/peer/activity', 'POST');
    if (apiSocket.peerIdentity() !== identity) throw Error('Activity request peer changed');
    return apiSocket.peerRequest('/api/peer/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(carrier) });
}

export async function codeLightActivityScope() {
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) return '';
    if (credentials.peer && apiSocket.peerIdentity() !== 'peer:' + credentials.peer.id) return '';
    return (credentials.peer ? 'peer:' + credentials.peer.id : getServerUrl()) + ':' + await codeLightAccountScope(credentials);
}

export function useCodeLightProjectActivities(projects: CodeLightProjectDescriptor[], screenActive = true) {
    const focused = useIsFocused();
    const [foreground, setForeground] = React.useState(AppState.currentState === 'active');
    const controller = React.useMemo(() => {
        const transport = new CodeLightActivityTransport({ peerIdentity: () => apiSocket.peerIdentity(), endpoint: getServerUrl,
            request: requestCodeLightActivity });
        return new CodeLightProjectActivityController({ store: codeLightProjectActivityStore, clientId: randomUUID(),
            scope: codeLightActivityScope, request: (machine, params, authority) => apiSocket.peerIdentity()
                ? transport.read(machine, params, authority) : apiSocket.machineRPC(machine, 'codelight-project-activity', params) });
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

export function useCodeLightSelectedSessionActivity(session: Session | null, active: boolean) {
    const key = codeLightSessionActivityScope(session), source = session?.metadata?.bridge?.source;
    const projects = React.useMemo<CodeLightProjectDescriptor[]>(() => key && session && source && session.metadata?.nativeSession?.isSubagent !== true
        && session.metadata?.nativeSession?.catalogueAvailable !== false && session.metadata?.nativeSession?.archived !== true && !codeLightSavedHistory(session)
        ? [{ id: 'selected:' + session.id, projectKey: session.metadata?.nativeSession?.projectKey || session.metadata?.path || '/',
            machineId: session.metadata!.machineId!, app: source.app as CodeLightProjectDescriptor['app'], hostId: source.hostId,
            sessions: [{ id: session.id, nativeId: source.id }] }] : [], [key, session?.id, session?.metadata?.path, session?.metadata?.nativeSession?.projectKey, session?.metadata?.nativeSession?.isSubagent,
            session?.metadata?.nativeSession?.catalogueAvailable, session?.metadata?.nativeSession?.archived, session?.metadata?.nativeSavedHistory]);
    useCodeLightProjectActivities(projects, active);
}

export function useCodeLightProjectActivity(id: string) {
    const subscribe = React.useCallback((changed: () => void) => codeLightProjectActivityStore.subscribe(id, changed), [id]);
    const get = React.useCallback(() => codeLightProjectActivityStore.get(id), [id]);
    return React.useSyncExternalStore(subscribe, get);
}

export function useCodeLightSessionActivity(id: string) {
    const subscribe = React.useCallback((changed: () => void) => codeLightProjectActivityStore.subscribeSession(id, changed), [id]);
    const get = React.useCallback(() => codeLightProjectActivityStore.getSession(id), [id]);
    return React.useSyncExternalStore(subscribe, get);
}
