import { AppState } from 'react-native';
import { TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';
import { channelList, type PeerChannel } from '@codelync/wire/codelync';
import { apiSocket } from './apiSocket';
import { commitPeerServerUrl } from './serverConfig';
import { peerAuthorization, decodePeerResponse, peerRouteWritable, setPeerRouteWriteFence, peerResponseHeaders } from './peerNetwork';
import { abortBudget } from './abortBudget';
import { sameLocatorOwner } from './startupMacLocatorCore';

type Preference = NonNullable<AuthCredentials['connectionPreference']>;
type ChannelState = PeerChannel & { state: 'connected' | 'available' | 'probing' | 'failed'; latencyMs?: number };
export type ConnectionSnapshot = { peerId: string | null; channels: ChannelState[]; selectedId: string | null; activeId?: string | null;
    desiredKind?: PeerChannel['kind'] | null; writable?: boolean; automatic: boolean; connecting: boolean; readable?: boolean; realtimeRecovering?: boolean;
    failureCode?: 'connection-failed' | 'access-ended' | 'preference-not-saved' | null };
let snapshot: ConnectionSnapshot = { peerId: null, channels: [], selectedId: null, activeId: null, automatic: true, connecting: false };
let credentials: AuthCredentials | null = null, generation = 0;
let probing: AbortController | null = null, releaseStatus: (() => void) | null = null, releaseForeground: (() => void) | null = null;
let writeTail: Promise<unknown> = Promise.resolve();
let recoveryTimer: ReturnType<typeof setTimeout> | null = null, recoveryAttempt = 0, recoveryBurstAt = 0;
let selection: { owner: AuthCredentials; id: string; promise: Promise<void> } | null = null;
const listeners = new Set<() => void>();
const automaticSuspensions = new Set<{ owner: AuthCredentials | null }>();
let automaticRecoveryPending: AuthCredentials | null = null;
let readProof: { peerId: string; endpoint: string; observedAt: number } | null = null;

export function getConnectionSnapshot() { return snapshot; }
export function subscribeConnection(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish(value: ConnectionSnapshot) { snapshot = value; for (const listener of listeners) listener(); }
function preference(value: AuthCredentials): Preference {
    const peer = value.peer!, saved = value.connectionPreference;
    if (saved?.peerId === peer.id && saved.devicePublicKey === peer.device.publicKey && (saved.mode === 'automatic'
        || saved.mode === 'manual' && typeof saved.channelId === 'string' && saved.channelId.length > 0 && saved.channelId.length <= 128
            && ['local', 'cloudflare', 'relay'].includes(saved.kind ?? ''))) return saved;
    const manual = peer.automatic === false, selected = peer.channels.find(channel => channel.id === peer.selectedChannel)
        ?? peer.channels.find(channel => channel.url === value.serverUrl);
    return { peerId: peer.id, devicePublicKey: peer.device.publicKey, mode: manual && selected ? 'manual' : 'automatic',
        ...(manual && selected ? { channelId: selected.id, kind: selected.kind } : {}) };
}
function actualId(value: AuthCredentials) { return value.peer?.channels.find(channel => channel.url === value.serverUrl)?.id ?? null; }
function currentReadProof(value: AuthCredentials) {
    return [apiSocket.peerHttpProof(), readProof].some(proof => !!proof && proof.peerId === value.peer?.id && proof.endpoint === value.serverUrl
        && Date.now() - proof.observedAt >= 0 && Date.now() - proof.observedAt < 20000);
}
function recoverySuspended(value: AuthCredentials) { return [...automaticSuspensions].some(entry => !!entry.owner && sameLocatorOwner(entry.owner, value)); }
function cancelRecovery() { if (recoveryTimer) clearTimeout(recoveryTimer); recoveryTimer = null; }
function scheduleRecovery() {
    const owner = credentials;
    if (!owner?.peer || selection || recoveryTimer || !apiSocket.peerCanReconnect() || snapshot.failureCode === 'access-ended'
        || snapshot.failureCode === 'preference-not-saved' || recoveryAttempt >= 3) return;
    if (recoverySuspended(owner)) { automaticRecoveryPending = owner; return; }
    if (recoveryAttempt === 0) recoveryBurstAt = Date.now();
    const delay = [0, 1000, 5000][recoveryAttempt++];
    recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        if (credentials && sameLocatorOwner(owner, credentials)) void recoverCodelyncConnection().catch(() => {});
    }, delay);
}
export function suspendCodelyncAutomaticRecovery(owner: AuthCredentials | null = credentials) {
    const entry = { owner }; automaticSuspensions.add(entry); let released = false;
    return () => {
        if (released) return; released = true; automaticSuspensions.delete(entry);
        if (entry.owner && automaticRecoveryPending && credentials && sameLocatorOwner(entry.owner, automaticRecoveryPending)
            && sameLocatorOwner(automaticRecoveryPending, credentials) && !recoverySuspended(credentials)) {
            automaticRecoveryPending = null;
            if (!apiSocket.peerConnected() && !currentReadProof(credentials)) scheduleRecovery();
        }
    };
}
function save(value: AuthCredentials, isCurrent: () => boolean) {
    const write = writeTail.catch(() => {}).then(async () => {
        if (!isCurrent()) return false;
        const saved = await TokenStorage.setCredentials(value);
        return saved && isCurrent();
    });
    writeTail = write.catch(() => {}); return write;
}
function stateFor(value: AuthCredentials, connecting: boolean, failedIds: Set<string> = new Set()): ConnectionSnapshot {
    const wanted = preference(value), active = actualId(value), connected = apiSocket.peerConnected() && apiSocket.peerEndpoint() === value.serverUrl;
    return { peerId: value.peer!.id, selectedId: wanted.mode === 'manual' ? wanted.channelId! : active, activeId: active,
        desiredKind: wanted.mode === 'manual' ? wanted.kind! : null, automatic: wanted.mode === 'automatic', connecting,
        writable: peerRouteWritable(value.peer!, value.serverUrl), readable: currentReadProof(value), channels: value.peer!.channels.map(channel => ({ ...channel,
            state: channel.id === active && connected ? 'connected' : failedIds.has(channel.id) ? 'failed' : 'available' })) };
}

export function initializeCodelyncConnection(value: AuthCredentials) {
    ++generation; probing?.abort(); probing = null; selection = null; cancelRecovery(); recoveryAttempt = 0;
    releaseStatus?.(); releaseStatus = null; releaseForeground?.(); releaseForeground = null;
    if (!value.peer) { credentials = null; setPeerRouteWriteFence(null); readProof = null; automaticRecoveryPending = null; publish({ peerId: null, channels: [], selectedId: null, activeId: null, automatic: true, connecting: false }); return; }
    if (automaticRecoveryPending && !sameLocatorOwner(automaticRecoveryPending, value)) automaticRecoveryPending = null;
    credentials = value;
    const wanted = preference(value), activeChannel = value.peer.channels.find(channel => channel.url === value.serverUrl);
    setPeerRouteWriteFence(wanted.mode === 'manual' ? value.peer : null, wanted.mode === 'manual' && wanted.channelId === activeChannel?.id && wanted.kind === activeChannel?.kind ? value.serverUrl ?? null : null);
    if (readProof?.peerId !== value.peer.id || readProof.endpoint !== value.serverUrl) readProof = null;
    publish(stateFor(value, false));
    releaseStatus = apiSocket.onStatusChange(status => {
        if (!credentials?.peer || snapshot.connecting) return;
        if (status === 'connecting' && recoveryAttempt >= 3 && Date.now() - recoveryBurstAt >= 30000) recoveryAttempt = 0;
        const readable = currentReadProof(credentials), active = actualId(credentials);
        if (status === 'connected') { cancelRecovery(); recoveryAttempt = 0; publish({ ...snapshot, activeId: active, readable, realtimeRecovering: false,
            channels: snapshot.channels.map(channel => ({ ...channel, state: channel.id === active ? 'connected' : channel.state })) }); }
        else publish({ ...snapshot, readable, realtimeRecovering: readable && apiSocket.peerCanReconnect(),
            channels: snapshot.channels.map(channel => channel.id === active ? { ...channel, state: readable || status === 'connecting' ? 'probing' : apiSocket.peerCanReconnect() ? 'failed' : 'available' } : channel) });
        if ((status === 'disconnected' || status === 'error') && apiSocket.peerCanReconnect() && !readable) scheduleRecovery();
    });
    releaseForeground = AppState.addEventListener('change', state => {
        if (state !== 'active' || !credentials?.peer) return;
        cancelRecovery(); recoveryAttempt = 0;
        if (!apiSocket.peerConnected() && !currentReadProof(credentials) || snapshot.failureCode === 'connection-failed') scheduleRecovery();
    }).remove;
}

export type FastChannelProof = { channel: PeerChannel; latencyMs: number; legacyChannels?: PeerChannel[] };
type Proof = FastChannelProof & { channels: PeerChannel[] };
async function boundedJson(response: Response, maximum: number): Promise<unknown> {
    const size = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(size) && size > maximum) { await Promise.resolve(response.body?.cancel?.()).catch(() => {}); throw Error('The route reply is too large'); }
    if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
        try {
            while (true) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength;
                if (total > maximum) { await reader.cancel(); throw Error('The route reply is too large'); } chunks.push(next.value); }
            const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            return JSON.parse(new TextDecoder().decode(bytes));
        } finally { reader.releaseLock(); }
    }
    // Native fetch may not expose a reader. Its existing request deadline still cancels the body.
    const text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
    if (new TextEncoder().encode(text).byteLength > maximum) throw Error('The route reply is too large');
    return JSON.parse(text);
}
async function routeRefusal(response: Response, peer: NonNullable<AuthCredentials['peer']>): Promise<Error> {
    // A reused address or public proxy can send a plain 401/403. Only a sealed Mac error proves revocation.
    try {
        const payload = decodePeerResponse(peer, await boundedJson(response, 4096)) as { error?: unknown };
        if (['device-revoked', 'device-access-revoked', 'access-revoked'].includes(String(payload?.error))) return Object.assign(Error('The Mac access ended'), { connectionFailure: 'access-ended' });
    } catch { /* No authenticated peer denial was received. */ }
    return Object.assign(Error('The route is unavailable'), { connectionFailure: 'connection-failed' });
}
/** Small route-only proof; a legacy fallback uses the same deadline once. */
export async function probeCodelyncChannel(channel: PeerChannel, value: AuthCredentials, signal?: AbortSignal): Promise<FastChannelProof> {
    const peer = value.peer!, deadline = abortBudget(signal, channel.kind === 'local' ? 1500 : 3000), start = Date.now();
    try {
        const url = channel.url + '/network-probe';
        let response = await fetch(url, { headers: { ...peerResponseHeaders(), Authorization: peerAuthorization(value.token, peer, channel.url, 'GET', url) }, signal: deadline.signal });
        if (response.status === 404 || response.status === 405) {
            const legacy = channel.url + '/api/peer/channels';
            response = await fetch(legacy, { headers: { ...peerResponseHeaders(), Authorization: peerAuthorization(value.token, peer, channel.url, 'GET', legacy) }, signal: deadline.signal });
            if (!response.ok) throw await routeRefusal(response, peer);
            const data = decodePeerResponse(peer, await boundedJson(response, 16384)) as { channels: unknown }, channels = channelList(data.channels);
            if (!channels.some(current => current.url === channel.url)) throw Error('This Mac has disabled the route');
            return { channel, latencyMs: Date.now() - start, legacyChannels: channels };
        }
        if (!response.ok) throw await routeRefusal(response, peer);
        const payload = decodePeerResponse(peer, await boundedJson(response, 4096)) as { version?: unknown };
        if (payload?.version !== 1) throw Error('The Mac route proof is invalid');
        return { channel, latencyMs: Date.now() - start };
    } finally { deadline.dispose(); }
}
export async function readCodelyncChannelManifest(proof: FastChannelProof, value: AuthCredentials, signal?: AbortSignal): Promise<PeerChannel[]> {
    if (proof.legacyChannels) return proof.legacyChannels;
    const peer = value.peer!, channel = proof.channel, url = channel.url + '/api/peer/channels';
    const deadline = abortBudget(signal, channel.kind === 'local' ? 2500 : 7000);
    try {
        const response = await fetch(url, { headers: { ...peerResponseHeaders(), Authorization: peerAuthorization(value.token, peer, channel.url, 'GET', url) }, signal: deadline.signal });
        if (!response.ok) throw await routeRefusal(response, peer);
        return channelList((decodePeerResponse(peer, await boundedJson(response, 16384)) as { channels: unknown }).channels);
    } finally { deadline.dispose(); }
}
function concurrentProbes(channels: PeerChannel[], value: AuthCredentials, signal: AbortSignal) {
    const flights = channels.map(channel => {
        const stop = new AbortController(), aborted = () => stop.abort(); signal.addEventListener('abort', aborted, { once: true });
        const promise = probeCodelyncChannel(channel, value, stop.signal).finally(() => signal.removeEventListener('abort', aborted));
        void promise.catch(() => {}); return { channel, stop, promise };
    });
    return { flights, cancel: (except?: PeerChannel) => { for (const flight of flights) if (flight.channel !== except) flight.stop.abort(); } };
}
export function selectConnection(id: string): Promise<void> { return runSelection(id, true); }
export function retryCodelyncConnection(): Promise<void> { recoveryAttempt = 0; return recoverCodelyncConnection(); }
/** Authenticated locator data can refresh candidates, never the user's chosen mode. */
export function recoverCodelyncConnection(channels?: PeerChannel[], expectedOwner?: AuthCredentials): Promise<void> {
    const value = credentials;
    if (!value?.peer || expectedOwner && !sameLocatorOwner(expectedOwner, value)) return Promise.reject(Error('The saved Mac connection changed'));
    const wanted = preference(value);
    return runSelection(wanted.mode === 'automatic' ? 'auto' : wanted.channelId!, false, channels);
}
function runSelection(id: string, explicit: boolean, discovered?: PeerChannel[]): Promise<void> {
    const value = credentials;
    if (!value?.peer) return Promise.reject(Error('Scan your Mac to get connection channels'));
    if (selection && sameLocatorOwner(selection.owner, value) && selection.id === id && !discovered) return selection.promise;
    const entry = { owner: value, id, promise: Promise.resolve() };
    entry.promise = performSelection(id, explicit, discovered).finally(() => { if (selection === entry) { selection = null; if (snapshot.failureCode === 'connection-failed') scheduleRecovery(); } });
    selection = entry; return entry.promise;
}
async function performSelection(id: string, explicit: boolean, discovered?: PeerChannel[]) {
    const owner = credentials!; if (!owner.peer) throw Error('The saved Mac is unavailable');
    const sequence = ++generation; cancelRecovery(); probing?.abort(); const abort = new AbortController(); probing = abort;
    if (explicit) { recoveryAttempt = 0; automaticRecoveryPending = null; }
    const current = () => sequence === generation && !!credentials && sameLocatorOwner(owner, credentials);
    const prior = owner, oldWanted = preference(owner), requested = owner.peer.channels.find(channel => channel.id === id);
    const wanted: Preference = explicit ? { peerId: owner.peer.id, devicePublicKey: owner.peer.device.publicKey, mode: id === 'auto' ? 'automatic' : 'manual',
        ...(id !== 'auto' ? { channelId: id, kind: requested?.kind ?? (oldWanted.channelId === id ? oldWanted.kind : undefined) } : {}) } : oldWanted;
    if (wanted.mode === 'manual' && (!wanted.kind || !wanted.channelId)) throw Error('Choose an available connection kind');
    const intentPeer = { ...owner.peer, automatic: wanted.mode === 'automatic', selectedChannel: wanted.mode === 'manual' ? wanted.channelId : owner.peer.selectedChannel };
    const intent = { ...owner, peer: intentPeer, connectionPreference: wanted };
    credentials = intent; setPeerRouteWriteFence(wanted.mode === 'manual' ? intent.peer : null); publish({ ...stateFor(intent, true), failureCode: null });
    let routeCommitted = false;
    try {
        if (!await save(intent, current)) { if (current()) publish({ ...snapshot, connecting: false, failureCode: 'preference-not-saved' }); throw Error('The connection preference could not be saved'); }
        if (!current()) throw Error('A newer channel selection replaced this one');
        const candidateChannels = discovered ? channelList(discovered) : intent.peer.channels;
        const probeValue = { ...intent, peer: { ...intent.peer, channels: candidateChannels } };
        let result: Proof | undefined;
        const batch = concurrentProbes(candidateChannels, probeValue, abort.signal);
        async function admitted(flights: typeof batch.flights, value: AuthCredentials): Promise<Proof> {
            const remaining = [...flights], failures: unknown[] = [];
            while (remaining.length) {
                let fast: FastChannelProof;
                try { fast = await Promise.any(remaining.map(flight => flight.promise)); }
                catch (error) { throw new AggregateError([...failures, ...(error instanceof AggregateError ? error.errors : [error])]); }
                const index = remaining.findIndex(flight => flight.channel === fast.channel); remaining.splice(index, 1);
                try { const channels = await readCodelyncChannelManifest(fast, value, abort.signal);
                    if (!channels.some(channel => channel.url === fast.channel.url)) throw Error('The route was withdrawn');
                    return { ...fast, channels };
                } catch (error) { failures.push(error); if (abort.signal.aborted) throw error; }
            }
            throw new AggregateError(failures);
        }
        try {
            if (wanted.mode === 'automatic') result = await admitted(batch.flights, probeValue);
            else {
                const preferred = batch.flights.find(flight => flight.channel.id === wanted.channelId && flight.channel.kind === wanted.kind);
                const otherSameKind = batch.flights.filter(flight => flight !== preferred && flight.channel.kind === wanted.kind);
                const otherKinds = batch.flights.filter(flight => flight.channel.kind !== wanted.kind);
                const sameKindErrors: unknown[] = [];
                const recordSameKindError = (error: unknown) => {
                    if (error instanceof AggregateError) sameKindErrors.push(...error.errors);
                    else sameKindErrors.push(error);
                };
                if (preferred) {
                    try { result = await admitted([preferred], probeValue); }
                    catch (error) { recordSameKindError(error); if (abort.signal.aborted) throw error; }
                }
                if (!result && otherSameKind.length) {
                    try { result = await admitted(otherSameKind, probeValue); }
                    catch (error) { recordSameKindError(error); if (abort.signal.aborted) throw error; }
                }
                if (!result) {
                    if (!otherKinds.length) {
                        throw sameKindErrors.length === 1 ? sameKindErrors[0] : new AggregateError(sameKindErrors.length ? sameKindErrors : [Error('The route is unavailable')]);
                    }
                    const discovery = await admitted(otherKinds, probeValue);
                    const sameKind = discovery.channels.filter(channel => channel.kind === wanted.kind);
                    if (!sameKind.length) throw Error('The requested connection kind is unavailable on this Mac');
                    const triedSameKindUrls = new Set(
                        [...(preferred ? [preferred] : []), ...otherSameKind].map(flight => flight.channel.url)
                    );
                    const freshSameKind = sameKind.filter(channel => !triedSameKindUrls.has(channel.url));
                    if (!freshSameKind.length) {
                        throw sameKindErrors.length === 1 ? sameKindErrors[0] : new AggregateError(sameKindErrors.length ? sameKindErrors : [Error('The route is unavailable')]);
                    }
                    const refreshed = { ...intent, peer: { ...intent.peer, channels: discovery.channels } };
                    const freshBatch = concurrentProbes(freshSameKind, refreshed, abort.signal);
                    try { result = await admitted(freshBatch.flights, refreshed); } finally { freshBatch.cancel(); }
                }
            }
        } finally { batch.cancel(); }
        if (result && !result.channels.some(channel => channel.url === result!.channel.url)) throw Error('The requested route was withdrawn');
        if (!result || !current()) throw Error('A newer channel selection replaced this one');
        const preferenceAfter = wanted.mode === 'manual' ? { ...wanted, channelId: result.channel.id } : wanted;
        const peer = { ...intent.peer, channels: result.channels, automatic: wanted.mode === 'automatic', selectedChannel: result.channel.id };
        const updated = { ...intent, peer, serverUrl: result.channel.url, connectionPreference: preferenceAfter };
        const oldActual = prior.peer!.channels.find(channel => channel.url === prior.serverUrl);
        const staged = oldActual && !peer.channels.some(channel => channel.url === oldActual.url)
            ? { ...updated, peer: { ...peer, channels: [...peer.channels, oldActual] } } : updated;
        if (JSON.stringify(staged) !== JSON.stringify(credentials) && !await save(staged, current)) throw Error('The connection route could not be saved');
        if (!current()) throw Error('A newer channel selection replaced this one');
        credentials = staged; routeCommitted = true; commitPeerServerUrl(result.channel.url);
        if (apiSocket.peerEndpoint() !== result.channel.url) await apiSocket.switchPeerChannel(result.channel.url, peer, { waitForSocket: false });
        if (!current()) throw Error('A newer channel selection replaced this one');
        if (staged !== updated) { if (!await save(updated, current)) throw Error('The connection route could not be finalized'); if (!current()) throw Error('A newer channel selection replaced this one'); }
        credentials = updated; readProof = { peerId: peer.id, endpoint: result.channel.url, observedAt: Date.now() }; setPeerRouteWriteFence(wanted.mode === 'manual' ? peer : null, result.channel.url);
        publish({ ...stateFor(updated, false), failureCode: null, readable: true, realtimeRecovering: !apiSocket.peerConnected(),
            channels: peer.channels.map(channel => ({ ...channel, state: channel.id === result!.channel.id ? apiSocket.peerConnected() ? 'connected' : 'probing' : 'available', ...(channel.id === result!.channel.id ? { latencyMs: result!.latencyMs } : {}) })) });
    } catch (error) {
        if (current() && routeCommitted && prior.serverUrl && prior.peer) {
            const restored = { ...prior, peer: { ...prior.peer, automatic: wanted.mode === 'automatic', selectedChannel: wanted.mode === 'manual' ? wanted.channelId : prior.peer.selectedChannel }, connectionPreference: wanted };
            if (await save(restored, current) && current()) { credentials = restored; commitPeerServerUrl(prior.serverUrl); await apiSocket.switchPeerChannel(prior.serverUrl, restored.peer, { waitForSocket: false }).catch(() => {}); }
        }
        const failures = error instanceof AggregateError ? error.errors : [error];
        const accessEnded = failures.length > 0 && failures.every(failure => (failure as { connectionFailure?: string })?.connectionFailure === 'access-ended');
        if (current() && snapshot.failureCode !== 'preference-not-saved') publish({ ...stateFor(credentials!, false, new Set(wanted.channelId ? [wanted.channelId] : [])),
            failureCode: accessEnded ? 'access-ended' : 'connection-failed' });
        throw error;
    } finally { abort.abort(); if (probing === abort) probing = null; }
}
