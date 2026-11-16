import AsyncStorage from '@react-native-async-storage/async-storage';
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';
import { apiSocket } from './apiSocket';
import { getServerUrl } from './serverConfig';
import type { BridgeRpcReply } from './noninvasiveRpcJournal';
import { ScopedNoninvasiveRpc } from './scopedNoninvasiveRpc';
import { storage } from './storage';
import { codeLightOperationSource, type CodeLightOperationTrace } from '@/utils/codeLightOperationLog';
import { confirmedNativeModelRpcReceipt } from '@/utils/nativeModelControls';

const sourceContext = (id: string) => codeLightOperationSource(storage.getState().sessions[id]);
const logListeners = new Map<string, Set<() => void>>();
const onDiagnostics = (id: string) => { for (const listener of logListeners.get(id) ?? []) listener(); };
export function subscribeNoninvasiveOperationLogs(id: string, listener: () => void) {
    let listeners = logListeners.get(id); if (!listeners) { listeners = new Set(); logListeners.set(id, listeners); }
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) logListeners.delete(id); };
}

const KEY = 'noninvasive-rpc-journal-v1';
const journal = new ScopedNoninvasiveRpc({
    storage: AsyncStorage, legacyKey: KEY, legacyScopedPrefix: 'noninvasive-rpc-v2:', keyPrefix: 'noninvasive-rpc-v3:', serverUrl: getServerUrl,
    identity: () => apiSocket.peerIdentity() ?? getServerUrl(),
    rpc: (sessionId, method, params, origin) => apiSocket.sessionRPC<BridgeRpcReply, unknown>(sessionId, method, params, origin),
    id: randomUUID, digest: text => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
    sourceContext,
    onDiagnostics,
});

export function runNoninvasiveRpc(sessionId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return journal.execute(sessionId, method, params);
}
export function recoverNoninvasiveRpc(sessionId: string, method: string): Promise<boolean> {
    return journal.recover(sessionId, method);
}
/** Explicit receipt-only check of the original target and command; never resubmits. */
export function recoverNoninvasiveRpcDetailed(sessionId: string, method: string, params: Record<string, unknown>, expectedCommandId: string): ReturnType<ScopedNoninvasiveRpc['recoverDetailed']> {
    if (!expectedCommandId?.trim() || expectedCommandId.length > 512) return Promise.resolve({ confirmed: false });
    return journal.recoverDetailed(sessionId, method, params, expectedCommandId);
}
const modelJournal = new ScopedNoninvasiveRpc({
    storage: AsyncStorage, legacyScopedPrefix: 'codelight-model-rpc-v1:', keyPrefix: 'codelight-model-rpc-v3:', serverUrl: getServerUrl,
    identity: () => apiSocket.peerIdentity() ?? getServerUrl(),
    rpc: (id, method, params, origin) => apiSocket.sessionRPC<BridgeRpcReply, unknown>(id, method, params, origin),
    id: randomUUID, digest: text => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
    sourceContext,
    onDiagnostics,
    validateComplete: (pending, result) => pending.method === 'codex-controls-update' && confirmedNativeModelRpcReceipt(pending.target, result),
});
export async function runCodeLightModelRpc(sessionId: string, params: Record<string, unknown>) {
    return modelJournal.execute(sessionId, 'codex-controls-update', params);
}
export async function recoverCodeLightModelRpc(sessionId: string, params: Record<string, unknown> = {}) {
    return modelJournal.recover(sessionId, 'codex-controls-update', params);
}
export async function recoverCodeLightNativeModelRpc(sessionId: string, params: Record<string, unknown>) {
    return modelJournal.recoverDetailed(sessionId, 'codex-controls-update', params);
}

const MACHINE_KEY = 'codelight-machine-rpc-journal-v1';
const machineJournal = new ScopedNoninvasiveRpc({
    storage: AsyncStorage, legacyKey: MACHINE_KEY, legacyScopedPrefix: 'codelight-machine-rpc-v2:', keyPrefix: 'codelight-machine-rpc-v3:', serverUrl: getServerUrl,
    identity: () => apiSocket.peerIdentity() ?? getServerUrl(),
    rpc: (machineId, method, params, origin) => apiSocket.machineRPC<BridgeRpcReply, unknown>(machineId, method === 'bridge-receipt' ? 'codelight-receipt' : method, params, origin),
    id: randomUUID, digest: text => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
    sourceContext: (machineId, target) => {
        const [method, kind, key] = JSON.parse(target);
        if (!method || kind !== 'source' || typeof key !== 'string') return null;
        const matches = Object.values(storage.getState().sessions).filter(session => session.metadata?.machineId === machineId && session.metadata?.bridge?.sourceKey === key);
        return matches.length === 1 ? codeLightOperationSource(matches[0]) : null;
    },
    onDiagnostics,
});

apiSocket.onReconnected(() => { void journal.recoverPending(); void modelJournal.recoverPending(); });

export function runNoninvasiveMachineRpc(machineId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    return machineJournal.execute(machineId, method, params);
}

export async function readNoninvasiveOperationLogs(sessionId: string): Promise<CodeLightOperationTrace[]> {
    return (await Promise.all([journal.readDiagnostics(sessionId), modelJournal.readDiagnostics(sessionId), machineJournal.readDiagnostics(sessionId)])).flat();
}
