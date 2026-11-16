import nacl from 'tweetnacl';
import { getRandomBytes } from 'expo-crypto';
import type { PeerCredentials } from '@slopus/happy-wire/codelight';
import { gzipSync, PEER_COMPACT_PREFIX_BYTES, PEER_RESPONSE_MAX_BYTES } from '@slopus/happy-wire/peer-codec';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { openPeerBox } from '@/encryption/openPeerBox';
import { decodeNativePeerPayload, nativePeerPayloadAvailable } from '@/encryption/nativePeerPayload';
import type { NativePeerPayloadRequest } from '@/encryption/nativePeerPayload';
import { decodePeerResponseAsync } from './peerNetwork';
import { abortBudget } from './abortBudget';

export const NATIVE_CODEC_STRESS_KEY = 'codelight-native-codec-stress-v1';
export type NativeCodecStressCase = { name: string; ok: boolean; ms: number; code?: string; counts?: Record<string, number>; stages?: Record<string, number>; native?: Record<string, number> };
export type NativeCodecStressReport = { version: 1; synthetic: true; authenticatedSynthetic: true; nativeAvailable: boolean;
    status: 'passed' | 'failed' | 'cancelled' | 'unavailable'; cases: NativeCodecStressCase[]; elapsedMs: number;
    rawNativeCalls: number; nativeCallUpperBound: number; publishedResults: 0; payloadPersisted: false; keysPersisted: false };
const NATIVE_FIELDS = new Set(['base64Ms', 'inflateMs', 'utf8Ms', 'workMs', 'queueMs', 'inputBytes', 'outputBytes', 'pendingAtAdmission', 'reservedBytesAtAdmission']);
const STAGES = new Set(['validate', 'base64', 'authenticate', 'inflate', 'checksum', 'utf8', 'json', 'native-body']);
const NATIVE_CODES = new Set(['E_CODEC_BUSY', 'E_CODEC_REQUEST', 'E_CODEC_INPUT', 'E_CODEC_GZIP', 'E_CODEC_CRC', 'E_CODEC_LENGTH', 'E_CODEC_TOO_LARGE', 'E_CODEC_UTF8', 'E_CODEC_NATIVE']);
let running = false;
function reason(error: unknown): string {
    if (error instanceof Error && error.message === 'Peer decode context changed') return 'STRESS_CONTEXT_CHANGED';
    if (error instanceof Error && error.message === 'The response did not authenticate this Mac') return 'STRESS_AUTH_REJECTED';
    if (error instanceof Error && error.message === 'foreign-peer-frame') return 'STRESS_PEER_REJECTED';
    if (typeof error === 'object' && error !== null && 'code' in error && NATIVE_CODES.has(String(error.code))) return String(error.code);
    return 'STRESS_CASE_FAILED';
}
function numeric(value: Record<string, number> | undefined): Record<string, number> {
    return Object.fromEntries(Object.entries(value ?? {}).filter(([key, item]) => NATIVE_FIELDS.has(key) && Number.isFinite(item) && item >= 0));
}
function check(value: unknown): asserts value { if (!value) throw Error('Stress assertion failed'); }
function concat(...parts: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0)); let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}
function asciiJSON(size: number): Uint8Array {
    const bytes = new Uint8Array(size).fill(120); bytes[0] = 34; bytes[size - 1] = 34; return bytes;
}
function within<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(Error('Peer decode context changed'));
        if (signal.aborted) { promise.catch(() => {}); abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        promise.then(value => { if (signal.aborted) abort(); else resolve(value); }, reject)
            .finally(() => signal.removeEventListener('abort', abort));
    });
}

/** Explicit one-shot diagnostic only. No credentials, network, selection or session store is accessed. */
export async function runNativeCodecStress(options: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<NativeCodecStressReport> {
    const began = performance.now(), available = nativePeerPayloadAvailable();
    const report: NativeCodecStressReport = { version: 1, synthetic: true, authenticatedSynthetic: true, nativeAvailable: available,
        status: available ? 'passed' : 'unavailable', cases: [], elapsedMs: 0, rawNativeCalls: 0, nativeCallUpperBound: 0,
        publishedResults: 0, payloadPersisted: false, keysPersisted: false };
    if (!available || running) { if (running) report.status = 'cancelled'; return report; }
    const duration = options.deadlineMs ?? 15000;
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 15000) throw Error('Invalid stress deadline');
    const sender = nacl.box.keyPair.fromSecretKey(getRandomBytes(32)), receiver = nacl.box.keyPair.fromSecretKey(getRandomBytes(32));
    running = true;
    const budget = abortBudget(options.signal, duration);
    const peer: PeerCredentials = { id: 'ab'.repeat(32), key: encodeBase64(sender.publicKey, 'base64url'), channels: [],
        device: { publicKey: encodeBase64(receiver.publicKey, 'base64url'), secretKey: encodeBase64(receiver.secretKey, 'base64url') } };
    const current = () => { if (budget.signal.aborted) throw Error('Peer decode context changed'); };
    const packet = (body: Uint8Array, expected: number, flags = 1, identity = peer.id): unknown[] => {
        current(); const frame = new Uint8Array(PEER_COMPACT_PREFIX_BYTES + body.length); frame[0] = flags;
        for (let index = 0; index < 32; index++) frame[index + 1] = parseInt(identity.slice(index * 2, index * 2 + 2), 16);
        new DataView(frame.buffer).setUint32(33, expected, true); frame.set(body, PEER_COMPACT_PREFIX_BYTES);
        const nonce = getRandomBytes(24), cipher = nacl.box(new Uint8Array(frame), new Uint8Array(nonce), receiver.publicKey, sender.secretKey);
        return [3, encodeBase64(nonce, 'base64url'), encodeBase64(cipher, 'base64url')];
    };
    const authenticatedRequest = (sealed: unknown[]): NativePeerPayloadRequest => {
        current();
        const plain = openPeerBox(decodeBase64(String(sealed[2]), 'base64url'), decodeBase64(String(sealed[1]), 'base64url'), sender.publicKey, receiver.secretKey);
        check(plain && plain.length >= PEER_COMPACT_PREFIX_BYTES && plain.length <= PEER_RESPONSE_MAX_BYTES && plain[0] <= 3);
        let identity = ''; for (let index = 1; index <= 32; index++) identity += plain[index].toString(16).padStart(2, '0');
        check(identity === peer.id);
        const expected = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(33, true);
        check(expected >= 2 && expected <= PEER_RESPONSE_MAX_BYTES - PEER_COMPACT_PREFIX_BYTES);
        return { bodyBase64: encodeBase64(plain.subarray(PEER_COMPACT_PREFIX_BYTES), 'base64'), expectedBytes: expected,
            compression: plain[0] & 1 ? 'gzip' : 'none', includeMetrics: true };
    };
    const run = async (name: string, work: (item: NativeCodecStressCase) => Promise<void>) => {
        current(); const at = performance.now(), item: NativeCodecStressCase = { name, ok: false, ms: 0 };
        try { await work(item); current(); item.ok = true; }
        catch (error) { item.code = reason(error); if (budget.signal.aborted) report.status = 'cancelled'; else report.status = 'failed'; }
        item.ms = performance.now() - at; report.cases.push(item);
    };
    const observe = (item: NativeCodecStressCase) => ({ signal: budget.signal,
        onStage: (stage: string, elapsed: number) => { if (STAGES.has(stage) && Number.isFinite(elapsed) && elapsed >= 0) { item.stages ??= {}; item.stages[stage] = (item.stages[stage] ?? 0) + elapsed; } },
        onNativeMetrics: (metrics: Record<string, number>) => { item.native = numeric(metrics); } });
    try {
        const unicode = new TextEncoder().encode(JSON.stringify({ text: 'Synthetic Unicode 正文 😀 '.repeat(4000) })), gzip = gzipSync(unicode);
        await run('large-unicode-native', async item => {
            report.nativeCallUpperBound += 3;
            const value = await within(decodePeerResponseAsync(peer, packet(gzip, unicode.length), observe(item)), budget.signal) as { text?: string };
            check(value.text === 'Synthetic Unicode 正文 😀 '.repeat(4000) && item.stages?.['native-body'] !== undefined && item.native?.workMs !== undefined);
        });
        await run('mac-authentication-final', async item => {
            const sealed = packet(gzip, unicode.length), cipher = decodeBase64(String(sealed[2]), 'base64url'); cipher[16] ^= 1;
            sealed[2] = encodeBase64(cipher, 'base64url');
            try { await decodePeerResponseAsync(peer, sealed, observe(item)); throw Error('Unexpected authentication success'); }
            catch (error) { check(reason(error) === 'STRESS_AUTH_REJECTED'); check(item.stages?.['native-body'] === undefined && !item.native); }
        });
        await run('foreign-peer-final', async item => {
            try { await decodePeerResponseAsync(peer, packet(gzip, unicode.length, 1, 'cd'.repeat(32)), observe(item)); throw Error('Unexpected peer success'); }
            catch (error) { check(reason(error) === 'STRESS_PEER_REJECTED'); check(item.stages?.['native-body'] === undefined && !item.native); }
        });
        await run('utf8-only-portable-compatibility', async item => {
            const invalid = new TextEncoder().encode(JSON.stringify({ text: 'x'.repeat(128 * 1024) })); invalid[10] = 255;
            report.nativeCallUpperBound += 3;
            const value = await within(decodePeerResponseAsync(peer, packet(gzipSync(invalid), invalid.length), observe(item)), budget.signal) as { text?: string };
            check(value.text?.includes('\ufffd') && item.stages?.utf8 !== undefined && item.stages?.['native-body'] === undefined);
        });
        for (const count of [1, 2]) await run('native-bom-' + count, async item => {
            const bom = new Uint8Array([239, 187, 191]), body = count === 1 ? concat(bom, unicode) : concat(bom, bom, unicode);
            const request = authenticatedRequest(packet(gzipSync(body), body.length)); report.rawNativeCalls++; report.nativeCallUpperBound++;
            const value = await within(decodeNativePeerPayload(request), budget.signal);
            check(value.text === (count === 1 ? '' : '\ufeff') + new TextDecoder().decode(unicode)); item.native = numeric(value.metrics);
        });
        const corrupt = new Uint8Array(gzip); corrupt[corrupt.length - 8] ^= 1;
        const trailing = concat(gzip, new Uint8Array([0]), gzip.subarray(gzip.length - 8));
        const badCases = [ ['gzip-crc-final', corrupt], ['gzip-truncation-final', gzip.subarray(0, gzip.length - 5)],
            ['gzip-trailing-final', trailing], ['gzip-multimember-final', concat(gzip, gzip)] ] as const;
        for (const [name, body] of badCases) await run(name, async item => {
            const request = authenticatedRequest(packet(body, unicode.length)); report.rawNativeCalls++; report.nativeCallUpperBound++;
            try { await within(decodeNativePeerPayload(request), budget.signal); throw Error('Unexpected compressed success'); }
            catch (error) { const code = reason(error); check(['E_CODEC_GZIP', 'E_CODEC_CRC', 'E_CODEC_LENGTH'].includes(code)); item.code = code; }
        });
        for (const [name, size] of [['pending-queue-bound', 4 * 1024 * 1024], ['native-byte-budget', PEER_RESPONSE_MAX_BYTES - PEER_COMPACT_PREFIX_BYTES]] as const) {
            await run(name, async item => {
                const request = authenticatedRequest(packet(gzipSync(asciiJSON(size)), size));
                report.rawNativeCalls += 3; report.nativeCallUpperBound += 3;
                const outcomes = await within(Promise.all(Array.from({ length: 3 }, async () => {
                    try { const value = await decodeNativePeerPayload(request); const metrics = numeric(value.metrics);
                        return { ok: true, code: '', metrics, exact: value.text.length === size && value.text.startsWith('"') && value.text.endsWith('"') }; }
                    catch (error) { return { ok: false, code: reason(error), metrics: {}, exact: false }; }
                })), budget.signal);
                const accepted = outcomes.filter(value => value.ok), busy = outcomes.filter(value => value.code === 'E_CODEC_BUSY');
                check(accepted.length > 0 && busy.length > 0 && accepted.length + busy.length === 3);
                check(accepted.every(value => value.exact && value.metrics.pendingAtAdmission <= 2 && value.metrics.reservedBytesAtAdmission <= 16777218));
                item.counts = { submitted: 3, accepted: accepted.length, busy: busy.length,
                    maxPending: Math.max(...accepted.map(value => value.metrics.pendingAtAdmission)), maxReservedBytes: Math.max(...accepted.map(value => value.metrics.reservedBytesAtAdmission)) };
            });
        }
        for (const mode of ['local-context', 'abort-signal'] as const) await run('late-' + mode, async item => {
            let alive = true, published = 0; const controller = new AbortController(); report.nativeCallUpperBound += 3;
            const pending = decodePeerResponseAsync(peer, packet(gzip, unicode.length), { ...observe(item), signal: controller.signal, isCurrent: () => alive })
                .then(() => { published++; });
            if (mode === 'local-context') alive = false; else controller.abort();
            try { await within(pending, budget.signal); throw Error('Unexpected late result'); }
            catch (error) { check(reason(error) === 'STRESS_CONTEXT_CHANGED'); check(published === 0 && item.stages?.json === undefined && !item.native); item.counts = { published }; }
        });
        check(report.nativeCallUpperBound <= 24);
    } catch (error) { report.status = budget.signal.aborted ? 'cancelled' : 'failed'; report.cases.push({ name: 'bounded-run', ok: false, ms: 0, code: reason(error) }); }
    finally { sender.secretKey.fill(0); receiver.secretKey.fill(0); budget.dispose(); running = false; report.elapsedMs = performance.now() - began; }
    return report;
}
