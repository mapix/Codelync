import * as React from 'react';
import type { Metadata } from '@/sync/storageTypes';
import { apiSocket } from '@/sync/apiSocket';
import { getServerUrl } from '@/sync/serverConfig';
import { nativeReadingIdentity, retainNativeReadingWindow, type NativeReadingWindowState } from '@/utils/nativeReadingWindow';

const subscribeAuthority = (listener: () => void) => apiSocket.onStatusChange(listener);
const readAuthority = () => apiSocket.peerIdentity() ?? getServerUrl();

type ReadingInputs = {
    authority: string;
    sessionId: string;
    machineId: string | null | undefined;
    clientId: string | null | undefined;
    controlMode: unknown;
    app: unknown;
    hostId: unknown;
    sourceId: unknown;
    kind: unknown;
    protocol: unknown;
    appMode: unknown;
    nativeCollection: unknown;
    runtimeGeneration: unknown;
};

function sameReadingInputs(a: ReadingInputs, b: ReadingInputs): boolean {
    return a.authority === b.authority
        && a.sessionId === b.sessionId
        && a.machineId === b.machineId
        && a.clientId === b.clientId
        && a.controlMode === b.controlMode
        && a.app === b.app
        && a.hostId === b.hostId
        && a.sourceId === b.sourceId
        && a.kind === b.kind
        && a.protocol === b.protocol
        && a.appMode === b.appMode
        && a.nativeCollection === b.nativeCollection
        && a.runtimeGeneration === b.runtimeGeneration;
}

/** Read-scope retention never restores a controller or modifies native metadata. */
export function useNativeReadingWindow(sessionId: string, metadata: Metadata | null): string {
    const authority = React.useSyncExternalStore(subscribeAuthority, readAuthority, readAuthority);
    const source = metadata?.bridge?.source;
    const inputs: ReadingInputs = {
        authority,
        sessionId,
        machineId: metadata?.machineId ?? null,
        clientId: metadata?.client?.id ?? null,
        controlMode: metadata?.bridge?.controlMode,
        app: source?.app,
        hostId: source?.hostId,
        sourceId: source?.id,
        kind: source?.kind,
        protocol: source?.protocol,
        appMode: source?.appMode,
        nativeCollection: source?.nativeCollection,
        runtimeGeneration: source?.runtimeGeneration,
    };
    const previous = React.useRef<{ inputs: ReadingInputs; state: NativeReadingWindowState; key: string } | null>(null);
    let next: NativeReadingWindowState;
    let serialized: string;
    if (previous.current && sameReadingInputs(previous.current.inputs, inputs)) {
        next = previous.current.state;
        serialized = previous.current.key;
    } else {
        const identity = nativeReadingIdentity(sessionId, metadata, authority) ?? JSON.stringify([authority, sessionId, 'unverified-native-reading']);
        next = retainNativeReadingWindow(previous.current?.state ?? null, identity, source?.runtimeGeneration);
        serialized = next === previous.current?.state ? previous.current.key : JSON.stringify(next);
    }
    React.useLayoutEffect(() => {
        previous.current = { inputs, state: next, key: serialized };
    }, [next, serialized, inputs.authority, inputs.sessionId, inputs.machineId, inputs.clientId, inputs.controlMode, inputs.app, inputs.hostId, inputs.sourceId, inputs.kind, inputs.protocol, inputs.appMode, inputs.nativeCollection, inputs.runtimeGeneration]);
    return serialized;
}
