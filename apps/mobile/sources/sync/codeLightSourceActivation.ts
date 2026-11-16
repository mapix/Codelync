import type { Session } from './storageTypes';
import { runNoninvasiveMachineRpc } from './noninvasiveRpc';
import { CodeLightActivationGate } from './codeLightActivationGate';
import { getServerUrl } from './serverConfig';
import { TokenStorage } from '@/auth/tokenStorage';
import { isCodeLightSessionSource } from '@/utils/codeLightSourceScope';
import { apiSocket } from './apiSocket';

const starts = new CodeLightActivationGate();
/** Entering a source is the user action; only the existing desktop owner starts its observation. */
export async function activateCodeLightSource(session: Session | null, options: { force?: boolean; authority?: string } = {}): Promise<unknown> {
    const bridge = session?.metadata?.bridge;
    if (!session || !bridge || !isCodeLightSessionSource(bridge.source, bridge.controlMode) || !options.force && bridge.sourceStatus === 'connected') return Promise.resolve();
    const authority = options.authority ?? apiSocket.peerIdentity() ?? getServerUrl();
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) throw Error('Source credentials unavailable');
    const peerAuthority = credentials.peer ? 'peer:' + credentials.peer.id : null;
    const assertAuthority = () => {
        if (peerAuthority ? authority !== peerAuthority || apiSocket.peerIdentity() !== peerAuthority : getServerUrl() !== authority) throw Error('Source activation authority changed');
    };
    assertAuthority();
    const identity = JSON.stringify([authority, peerAuthority ? null : credentials.token, session.id, session.metadata?.machineId,
        bridge.sourceKey, bridge.source.runtimeGeneration]);
    return starts.run(identity, async () => {
        assertAuthority();
        const result = bridge.controller === 'machine' && session.metadata?.machineId && bridge.sourceKey
            ? await runNoninvasiveMachineRpc(session.metadata.machineId, 'codelight-observe-source', { sourceKey: bridge.sourceKey }) : undefined;
        assertAuthority(); return result;
    });
}
