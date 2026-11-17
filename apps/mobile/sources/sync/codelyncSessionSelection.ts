import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { useSyncExternalStore } from 'react';
import { TokenStorage } from '@/auth/tokenStorage';
import type { Session } from './storageTypes';
import { apiSocket } from './apiSocket';
import { getServerUrl } from './serverConfig';
import { codelyncAccountScope } from './codelyncBackgroundCache';
import { CodelyncSelectionJournal } from './codelyncSelectionJournal';
import type { BridgeRpcReply } from './noninvasiveRpcJournal';
import { isCodelyncSessionSource } from '@/utils/codelyncSourceScope';

const journals = new Map<string, CodelyncSelectionJournal>();
const states = new Map<string, { revision: number; state: 'connecting' | 'selected' | 'failed' }>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
export function useCodelyncSelectionState(sessionId: string) {
    return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
        () => states.get(sessionId)?.state ?? 'idle');
}
/** Invoked only by a real navigation tap or Retry, never by a preload/background refresh. */
export async function selectCodelyncSession(session: Session | null) {
    const bridge = session?.metadata?.bridge;
    if (!session || !bridge || !isCodelyncSessionSource(bridge.source, bridge.controlMode)) return;
    const revision = (states.get(session.id)?.revision ?? 0) + 1;
    states.set(session.id, { revision, state: 'connecting' }); notify();
    try {
        const credentials = await TokenStorage.getCredentials(), machine = session.metadata?.machineId;
        if (!credentials || !machine || typeof bridge.sourceKey !== 'string') throw Error('Source binding unavailable');
        const origin = getServerUrl(), scope = await codelyncAccountScope(credentials);
        const peerAuthority = credentials.peer ? 'peer:' + credentials.peer.id : null;
        // 同一 Mac 的认证通道切换不会改变选择所有者；旧 origin 判断会把正常自动恢复误记为选择失败。
        const assertAuthority = () => {
            if (peerAuthority ? apiSocket.peerIdentity() !== peerAuthority : getServerUrl() !== origin) throw Error('Selection authority changed');
        };
        assertAuthority();
        let journal = journals.get(scope);
        if (!journal) {
            const key = 'codelync-selection-journal-v1:' + scope;
            journal = new CodelyncSelectionJournal({ get: () => AsyncStorage.getItem(key), set: value => AsyncStorage.setItem(key, value) },
                (id, params) => { assertAuthority(); return apiSocket.machineRPC<BridgeRpcReply, unknown>(id, 'codelync-select-source', params); }, randomUUID);
            journals.set(scope, journal);
        }
        await journal.select(machine, bridge.sourceKey);
        if (states.get(session.id)?.revision === revision) { states.set(session.id, { revision, state: 'selected' }); notify(); }
    } catch (error) {
        if (states.get(session.id)?.revision === revision) { states.set(session.id, { revision, state: 'failed' }); notify(); }
        throw error;
    }
}
