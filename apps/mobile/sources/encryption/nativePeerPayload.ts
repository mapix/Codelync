export type NativePeerPayloadRequest = { bodyBase64: string; expectedBytes: number; compression: 'none' | 'gzip'; includeMetrics?: boolean };
export type NativePeerPayloadResult = { text: string; metrics?: Record<string, number> };
export function nativePeerPayloadAvailable(): boolean { return false; }
export async function decodeNativePeerPayload(_request: NativePeerPayloadRequest): Promise<NativePeerPayloadResult> { throw Error('Native payload codec unavailable'); }
