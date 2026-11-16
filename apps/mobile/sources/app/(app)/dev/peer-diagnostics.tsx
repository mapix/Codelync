import * as React from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text } from '@/components/StyledText';
import { TokenStorage } from '@/auth/tokenStorage';
import { apiSocket } from '@/sync/apiSocket';
import { abortBudget } from '@/sync/abortBudget';
import { peerAuthorization, decodePeerResponse, decodePeerResponseAsync, peerResponseHeaders } from '@/sync/peerNetwork';
import { getConnectionSnapshot, selectConnection } from '@/sync/codeLightConnection';
import { nativeRecentMessages, peerDescriptorSession } from '@/sync/codeLightRecent';
import { decodeBase64 } from '@/encryption/base64';
import { storage } from '@/sync/storage';
import { codeLightLoadingProgress } from '@/sync/codeLightLoadingProgress';
import { NATIVE_CODEC_STRESS_KEY, runNativeCodecStress } from '@/sync/nativeCodecStress';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';

const diagnosticHash = (value: string) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value);

async function residentMessageDiagnostics(sessionId: string) {
    const resident = storage.getState().sessionMessages[sessionId];
    if (!resident) return { present: false, messageCount: 0 };
    const reducer = resident.reducerState;
    const messages = resident.messages.slice(0, 64).map(message => ({
        id: message.id, kind: message.kind, nativeId: message.meta?.nativeRow?.id,
        textChars: 'text' in message && typeof message.text === 'string' ? message.text.length : 0,
        isThinking: message.kind === 'agent-text' && message.isThinking === true,
        createdAt: message.createdAt, nativeOrder: message.meta?.nativeOrder ?? null,
    }));
    const nativeRows = [...reducer.nativeRowIds].slice(0, 64).map(([id, canonicalId]) => {
        const row = reducer.messages.get(canonicalId), owner = reducer.nativeSnapshotOwners.get(id);
        return { id, canonicalId, canonicalPresent: !!row, canonicalTextChars: row?.text?.length ?? 0,
            canonicalThinking: row?.isThinking === true, retired: reducer.nativeRetiredRowIds.has(id),
            streamRevision: reducer.nativeRevisions.get(id) ?? null,
            snapshotRevision: owner === undefined ? null : reducer.nativeRevisions.get(JSON.stringify(['snapshot', owner, id])) ?? null };
    });
    const counts = { present: true, messageCount: resident.messages.length, isLoaded: resident.isLoaded,
        hasMoreOlder: resident.hasMoreOlder, isLoadingOlder: resident.isLoadingOlder,
        canonicalCount: reducer.messages.size, wireIdCount: reducer.messageIds.size,
        nativeRowCount: reducer.nativeRowIds.size, retiredRowCount: reducer.nativeRetiredRowIds.size,
        revisionWatermarkCount: reducer.nativeRevisions.size, summaryLimit: 64,
        summaryTruncated: resident.messages.length > 64 || reducer.nativeRowIds.size > 64 };
    return { ...counts, messages: await Promise.all(messages.map(async ({ id, nativeId, ...message }) => ({
        ...message, messageIdHash: await diagnosticHash(id), nativeRowIdHash: nativeId ? await diagnosticHash(nativeId) : null,
    }))), nativeRows: await Promise.all(nativeRows.map(async ({ id, canonicalId, ...row }) => ({
        ...row, nativeRowIdHash: await diagnosticHash(id), canonicalIdHash: await diagnosticHash(canonicalId),
    }))) };
}

async function recentRowDiagnostics(window: any, sessionId: string) {
    const reducer = storage.getState().sessionMessages[sessionId]?.reducerState;
    const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
    const rows = (Array.isArray(window.rows) ? window.rows : []).slice(0, 64).map((row: any) => ({
        id: typeof row.id === 'string' ? row.id : '', role: ['user', 'assistant', 'reasoning', 'tool'].includes(row.role) ? row.role : 'unknown', textChars: typeof row.text === 'string' ? row.text.length : 0,
        order: integer(row.order), at: integer(row.at), projectionRevision: integer(row.projectionRevision),
        snapshotRevision: integer(row.snapshotRevision), streamRevision: integer(row.streamRevision),
        retired: reducer?.nativeRetiredRowIds.has(row.id) ?? false,
        canonicalPresent: !!reducer?.messages.get(reducer.nativeRowIds.get(row.id) ?? ''),
    }));
    return { rowCount: Array.isArray(window.rows) ? window.rows.length : 0, requestedLimit: 1,
        rows: await Promise.all(rows.map(async ({ id, ...row }: any) => ({ ...row, nativeRowIdHash: await diagnosticHash(id) }))) };
}

function sourceDiagnostics(session: any) {
    if (!session) return null;
    const bridge = session.metadata?.bridge, source = bridge?.source;
    const controls = session.metadata?.nativeControls;
    const input = session.agentState?.nativeInput;
    return {
        id: session.id, metadataVersion: session.metadataVersion, seq: session.seq,
        source: source && { app: source.app, id: source.id, hostId: source.hostId, kind: source.kind,
            protocol: source.protocol, runtimeGeneration: source.runtimeGeneration },
        bridge: bridge && { sourceStatus: bridge.sourceStatus, projectionStatus: bridge.projectionStatus,
            hasSourceKey: typeof bridge.sourceKey === 'string', hasCurrentTurn: !!bridge.currentTurnId },
        steering: session.metadata?.capabilities?.steering,
        rpcMethods: session.metadata?.capabilities?.rpcMethods,
        controls: controls && { compatibility: controls.compatibility, modelAvailable: controls.model?.available,
            commandsAvailable: controls.commands?.available },
        nativeInput: input && { available: input.available, reason: input.reason,
            parentConversationId: input.parentConversationId, agentPath: input.agentPath,
            app: input.app, nativeConversationId: input.nativeConversationId, hostId: input.hostId,
            ownerGeneration: input.ownerGeneration },
        nativeSession: { isSubagent: session.metadata?.nativeSession?.isSubagent === true,
            parentId: session.metadata?.nativeSession?.parentId },
    };
}

/** Native QA with an optional same-peer Auto selection. No native session command is dispatched. */
export default function PeerDiagnostics() {
    const params = useLocalSearchParams<{ thread?: string; host?: string; select?: string; catalog?: string; only?: string; codec?: string }>();
    const [report, setReport] = React.useState('Checking connection…');
    const stressStarted = React.useRef(false);
    React.useEffect(() => {
        let cancelled = false;
        if (params.codec === 'stress-v1') {
            const controller = new AbortController();
            // Explicit route only. Deferral lets StrictMode cleanup cancel a
            // probe before it starts; one mounted entry never repeats a run.
            const scheduled = setTimeout(() => {
                if (cancelled || stressStarted.current) return;
                stressStarted.current = true;
                setReport('Checking native codec…');
                void runNativeCodecStress({ signal: controller.signal }).then(async result => {
                    if (cancelled) return;
                    await AsyncStorage.setItem(NATIVE_CODEC_STRESS_KEY, JSON.stringify(result));
                    if (!cancelled) setReport(JSON.stringify(result, null, 2));
                }, async () => {
                    if (cancelled) return;
                    const result = { version: 1, synthetic: true, status: 'failed', code: 'STRESS_ENTRY_FAILED', payloadPersisted: false, keysPersisted: false };
                    await AsyncStorage.setItem(NATIVE_CODEC_STRESS_KEY, JSON.stringify(result));
                    if (!cancelled) setReport(JSON.stringify(result, null, 2));
                }).catch(() => { if (!cancelled) setReport(JSON.stringify({ version: 1, synthetic: true, status: 'failed', code: 'STRESS_STORE_FAILED' })); });
            }, 0);
            return () => { cancelled = true; clearTimeout(scheduled); controller.abort(); };
        }
        void (async () => {
            const result: Record<string, unknown> = { at: Date.now(), stages: [] };
            const stages = result.stages as Record<string, unknown>[];
            try {
                let credentials = await TokenStorage.getCredentials();
                if (!credentials?.peer) throw Error('No stored peer');
                if (params.select === 'auto' || params.select === 'relay') {
                    result.currentStage = 'selection';
                    const started = Date.now();
                    try { await selectConnection(params.select); result.selectionTest = { ok: true, ms: Date.now() - started }; }
                    catch { result.selectionTest = { ok: false, ms: Date.now() - started, connectionError: apiSocket.peerConnectionError() }; }
                    credentials = await TokenStorage.getCredentials();
                    if (!credentials?.peer) throw Error('Peer credentials changed');
                }
                const authenticated = credentials, peer = authenticated.peer;
                if (!peer) throw Error('Peer credentials changed');
                if (params.catalog === 'wire') {
                    // Actual received envelopes stay in memory. This branch records only
                    // sizes/timings and never applies native rows to selected-session state.
                    const measure = async (path: string, options?: RequestInit, compact = true) => {
                        const deadline = abortBudget(undefined, path.endsWith('/recent') ? 30000 : 10000);
                        try {
                            const headers = new Headers(options?.headers);
                            if (compact) Object.entries(peerResponseHeaders()).forEach(([key, value]) => headers.set(key, value));
                            const started = performance.now();
                            const response = await apiSocket.request(path, { ...options, headers: Object.fromEntries(headers.entries()), signal: deadline.signal });
                            const raw = await response.text(), bodyReadMs = performance.now() - started;
                            const report: Record<string, unknown> = { status: response.status, requestAndBodyReadMs: bodyReadMs,
                                responseBodyUtf8Bytes: new TextEncoder().encode(raw).length, negotiatedCodec: compact ? 3 : null };
                            if (!response.ok) return { data: null, report };
                            const parseStarted = performance.now(), packet = JSON.parse(raw);
                            report.envelopeParseMs = performance.now() - parseStarted;
                            const tuple = Array.isArray(packet) && packet[0] === 3;
                            const ciphertext = tuple ? packet[2] : packet.ciphertext, nonce = tuple ? packet[1] : packet.nonce;
                            const phases: Record<string, number> = {};
                            let nativeMetrics: Record<string, number> | null = null;
                            const decodeStarted = performance.now(), data = await decodePeerResponseAsync(peer, packet, { signal: deadline.signal,
                                isCurrent: () => apiSocket.peerIdentity() === 'peer:' + peer.id,
                                onStage: (stage, elapsed) => { phases[stage] = (phases[stage] ?? 0) + elapsed; }, onNativeMetrics: metrics => { nativeMetrics = metrics; } }) as any;
                            report.nativeDecodeMs = performance.now() - decodeStarted;
                            report.decodePhaseMs = phases;
                            report.nativeCodecMetrics = nativeMetrics;
                            report.packetCodec = tuple ? 3 : packet.version;
                            report.nonceBytes = decodeBase64(nonce, 'base64url').length;
                            report.ciphertextBytes = decodeBase64(ciphertext, 'base64url').length;
                            report.authenticatedFrameBytes = Number(report.ciphertextBytes) - 16;
                            report.decodedJsonUtf8Bytes = new TextEncoder().encode(JSON.stringify(data)).length;
                            const repeatStarted = performance.now();
                            for (let index = 0; index < 10; index++) await decodePeerResponseAsync(peer, packet, { signal: deadline.signal, isCurrent: () => apiSocket.peerIdentity() === 'peer:' + peer.id });
                            report.repeatDecodeCount = 10; report.repeatDecodeMeanMs = (performance.now() - repeatStarted) / 10;
                            report.version = data?.version; report.mode = data?.mode;
                            report.rows = Array.isArray(data?.sessions) ? data.sessions.length : data?.rows?.length;
                            report.removed = data?.removedIds?.length; report.hasMore = data?.hasMore;
                            return { data, report };
                        } finally { deadline.dispose(); }
                    };
                    result.measurementBoundary = 'authenticated response body only; no HTTP/TLS/TCP headers';
                    result.nativeStateApplied = false;
                    let selected: any;
                    if (params.only === 'rows') {
                        const matches = Object.values(storage.getState().sessions).filter(entry => entry.metadata?.bridge?.source?.id === params.thread);
                        selected = matches.length === 1 ? matches[0] : undefined;
                        result.catalogSkipped = true;
                    } else {
                        result.currentStage = 'wire-catalog-full';
                        const full = await measure('/api/peer/catalog?catalogVersion=2&limit=2000');
                        result.catalogFullWire = full.report;
                        if (full.data?.version === 2 && typeof full.data.watermark === 'string' && !full.data.hasMore) {
                            const deltaPath = '/api/peer/catalog?catalogVersion=2&limit=2000&since=' + encodeURIComponent(full.data.watermark);
                            result.currentStage = 'wire-catalog-delta';
                            result.catalogDeltaWire = (await measure(deltaPath)).report;
                            result.currentStage = 'wire-catalog-v2';
                            result.catalogDeltaV2Wire = (await measure(deltaPath, undefined, false)).report;
                        }
                        selected = full.data?.sessions?.find((entry: any) => entry.metadata?.bridge?.source?.id === params.thread);
                    }
                    result.selectedFound = !!selected;
                    if (selected) {
                        result.currentStage = 'wire-recent';
                        const recent = await measure(`/api/peer/sessions/${encodeURIComponent(selected.id)}/recent`,
                            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 1 }) });
                        result.recentWire = recent.report;
                        result.networkRecent = sourceDiagnostics(recent.data?.session);
                        result.recentSourceApp = recent.data?.session?.metadata?.bridge?.source?.app;
                        result.recentOwnerMatches = recent.data?.ownerGeneration === selected.metadata?.bridge?.source?.runtimeGeneration;
                        if (recent.data?.hasMore && typeof recent.data.nextCursor === 'string') {
                            result.currentStage = 'wire-history';
                            const query = new URLSearchParams({ cursor: recent.data.nextCursor, limit: '4' });
                            const older = await measure(`/api/peer/sessions/${encodeURIComponent(selected.id)}/history?${query}`);
                            result.historyWire = older.report;
                            result.historyOwnerMatches = older.data?.ownerGeneration === recent.data.ownerGeneration;
                            result.historyCursorAdvanced = typeof older.data?.nextCursor === 'string' && older.data.nextCursor !== recent.data.nextCursor;
                        }
                    }
                    result.currentStage = 'complete';
                } else if (params.catalog === 'delta') {
                    const measure = async (path: string) => {
                        const started = Date.now(), response = await apiSocket.peerRequest(path);
                        const text = await response.text(), data = response.ok ? JSON.parse(text) : null;
                        return { data, report: { status: response.status, ms: Date.now() - started,
                            logicalUtf8Bytes: new TextEncoder().encode(text).length,
                            version: data?.version, mode: data?.mode, rows: data?.sessions?.length,
                            removed: data?.removedIds?.length, hasMore: data?.hasMore,
                            watermarkPresent: typeof data?.watermark === 'string' } };
                    };
                    result.currentStage = 'catalog-full';
                    const full = await measure('/api/peer/catalog?catalogVersion=2&limit=2000');
                    result.catalogFull = full.report;
                    if (full.data?.version === 2 && typeof full.data.watermark === 'string' && !full.data.hasMore) {
                        result.currentStage = 'catalog-delta';
                        const delta = await measure('/api/peer/catalog?catalogVersion=2&limit=2000&since=' + encodeURIComponent(full.data.watermark));
                        result.catalogDelta = delta.report;
                    }
                    result.currentStage = 'complete';
                } else {
                result.channels = await Promise.all(peer.channels.map(async (channel, index) => {
                    const started = Date.now(), deadline = abortBudget(undefined, channel.kind === 'local' ? 2500 : 7000);
                    try {
                        const url = channel.url + '/api/peer/channels';
                        const response = await fetch(url, { headers: { Authorization: peerAuthorization(authenticated.token, peer, channel.url, 'GET', url) }, signal: deadline.signal });
                        if (response.ok) decodePeerResponse(peer, await response.json());
                        return { index, kind: channel.kind, status: response.status, ms: Date.now() - started };
                    } catch { return { index, kind: channel.kind, status: 'unavailable', ms: Date.now() - started }; }
                    finally { deadline.dispose(); }
                }));
                result.socketConnected = apiSocket.peerConnected(); result.connectionError = apiSocket.peerConnectionError(); result.automatic = getConnectionSnapshot().automatic;
                let started = Date.now();
                result.currentStage = 'catalog';
                const catalog = await apiSocket.peerRequest('/api/peer/catalog?limit=200');
                stages.push({ name: 'catalog', status: catalog.status, ms: Date.now() - started });
                if (catalog.ok) {
                    const data = await catalog.json();
                    result.catalogCount = data.sessions?.length;
                    const selected = data.sessions?.find((entry: any) => entry.metadata?.bridge?.source?.id === params.thread
                        && (!params.host || entry.metadata?.bridge?.source?.hostId === params.host));
                    result.selectedFound = !!selected;
                    if (selected) {
                        result.localBeforeRecent = sourceDiagnostics(storage.getState().sessions[selected.id]);
                        result.residentBeforeRecent = await residentMessageDiagnostics(selected.id);
                        result.nativeRowProvenance = (storage.getState().sessionMessages[selected.id]?.messages ?? []).flatMap(message => message.kind === 'agent-text'
                            && /CODELIGHT_(?:NATIVE_(?:ARGON|SLASH)|SUBAGENT_RESUMED)/.test(message.text) ? [{ id: message.id,
                            marker: /CODELIGHT_NATIVE_SLASH/.test(message.text) ? 'slash' : /CODELIGHT_NATIVE_ARGON/.test(message.text) ? 'argon' : 'resumed',
                            nativeRow: message.meta?.nativeRow ?? null, sentFrom: message.meta?.sentFrom, thinking: message.isThinking === true }] : []);
                        result.currentViewMatches = storage.getState().currentViewingSessionId === selected.id;
                        result.loadingBeforeRecent = codeLightLoadingProgress.getSession(selected.id);
                        started = Date.now();
                        result.currentStage = 'recent';
                        const recent = await apiSocket.peerRequest(`/api/peer/sessions/${selected.id}/recent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 1 }) });
                        stages.push({ name: 'recent', status: recent.status, ms: Date.now() - started });
                        if (recent.ok) {
                            const window = await recent.json(); result.recentRows = window.rows?.length; result.nativeStatus = window.status;
                            result.httpRecentRows = await recentRowDiagnostics(window, selected.id);
                            const local = storage.getState().sessions[selected.id];
                            result.localAfterRecent = sourceDiagnostics(local);
                            result.networkRecent = sourceDiagnostics(window.session);
                            result.metadataAhead = !!local && local.metadataVersion > window.session.metadataVersion;
                            result.sameOwner = local?.metadata?.bridge?.source.runtimeGeneration === window.session.metadata?.bridge?.source.runtimeGeneration;
                            result.loadingAfterRecent = codeLightLoadingProgress.getSession(selected.id);
                            result.residentAfterRecent = await residentMessageDiagnostics(selected.id);
                            peerDescriptorSession(window.session); nativeRecentMessages(window);
                            result.nativeProjectionValid = true;
                            result.sessionKeyBytes = decodeBase64(window.session.sessionKey, 'base64').length;
                        }
                    }
                }
                result.currentStage = 'complete';
                }
            } catch { result.failed = true; }
            result.finishedAt = Date.now();
            await AsyncStorage.setItem('codelight-peer-diagnostics-v1', JSON.stringify(result));
            if (!cancelled) setReport(JSON.stringify(result, null, 2));
        })();
        return () => { cancelled = true; };
    }, [params.thread, params.select, params.catalog, params.only, params.codec]);
    return <ScrollView contentContainerStyle={{ padding: 24 }}><Stack.Screen options={{ headerTitle: 'Connection diagnostics' }} /><Text>{report}</Text></ScrollView>;
}
