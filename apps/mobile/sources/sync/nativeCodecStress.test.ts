import { beforeEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { gunzipSync, inflateRawSync } from 'node:zlib';
const native = vi.hoisted(() => ({ available: true, pending: 0, reserved: 0, calls: 0 }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)) }));
vi.mock('@/encryption/nativePeerPayload', () => ({
    nativePeerPayloadAvailable: () => native.available,
    decodeNativePeerPayload: async (request: { bodyBase64: string; expectedBytes: number; compression: string }) => {
        native.calls++;
        const input = Buffer.from(request.bodyBase64, 'base64'), reserve = input.length + request.expectedBytes + 1;
        if (native.pending >= 2 || reserve > 16777218 - native.reserved) throw { code: 'E_CODEC_BUSY' };
        native.pending++; native.reserved += reserve;
        const metrics = { pendingAtAdmission: native.pending, reservedBytesAtAdmission: native.reserved, workMs: 1, outputBytes: request.expectedBytes, inputBytes: input.length };
        try {
            await new Promise(resolve => setTimeout(resolve, 2));
            let body: Buffer;
            try { body = request.compression === 'gzip' ? gunzipSync(input) : input; } catch { throw { code: 'E_CODEC_GZIP' }; }
            if (request.compression === 'gzip') {
                const stream = inflateRawSync(input.subarray(10), { info: true }) as unknown as { engine: { bytesWritten: number } };
                if (10 + stream.engine.bytesWritten + 8 !== input.length) throw { code: 'E_CODEC_GZIP' };
            }
            if (request.compression === 'gzip' && (input[3] !== 0 || body.length !== request.expectedBytes)) throw { code: 'E_CODEC_LENGTH' };
            // Node accepts members/trailing bytes; emulate the strict native
            // single-member boundary for this isolated runner fixture.
            if (request.compression === 'gzip' && (input.readUInt32LE(input.length - 4) !== request.expectedBytes || body.length !== request.expectedBytes)) throw { code: 'E_CODEC_GZIP' };
            let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { throw { code: 'E_CODEC_UTF8' }; }
            return { text, metrics };
        } finally { native.pending--; native.reserved -= reserve; }
    },
}));
import { runNativeCodecStress, NATIVE_CODEC_STRESS_KEY } from './nativeCodecStress';
beforeEach(() => { native.available = true; native.pending = 0; native.reserved = 0; native.calls = 0; });

it('runs only synthetic authenticated data and exposes bounded sanitized results', async () => {
    const report = await runNativeCodecStress();
    expect(report.status, JSON.stringify(report)).toBe('passed'); expect(report.cases.every(item => item.ok)).toBe(true);
    expect(report.nativeCallUpperBound).toBeLessThanOrEqual(24); expect(report.rawNativeCalls).toBe(12);
    expect(report.publishedResults).toBe(0); expect(report.payloadPersisted).toBe(false); expect(report.keysPersisted).toBe(false);
    expect(report.cases.find(item => item.name === 'pending-queue-bound')?.counts?.maxPending).toBeLessThanOrEqual(2);
    expect(JSON.stringify(report)).not.toMatch(/bodyBase64|secretKey|ciphertext|Synthetic Unicode|\"text\"/);
    expect(NATIVE_CODEC_STRESS_KEY).toBe('codelync-native-codec-stress-v1');
});

it('never treats missing installed native codec as a passed portable test', async () => {
    native.available = false; const report = await runNativeCodecStress();
    expect(report.status).toBe('unavailable'); expect(report.cases).toEqual([]); expect(native.calls).toBe(0);
});

it('cancelled entry stops without native work or a published result', async () => {
    const controller = new AbortController(); controller.abort(); const report = await runNativeCodecStress({ signal: controller.signal });
    expect(report.status).toBe('cancelled'); expect(native.calls).toBe(0); expect(report.publishedResults).toBe(0);
});

it('one diagnostic run cannot start another overlapping native stress plan', async () => {
    const first = runNativeCodecStress();
    const concurrent = await runNativeCodecStress();
    expect(concurrent.status).toBe('cancelled'); expect(concurrent.rawNativeCalls).toBe(0);
    expect((await first).status).toBe('passed');
});
