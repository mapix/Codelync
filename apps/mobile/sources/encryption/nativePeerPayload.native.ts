import { NativeModules, Platform } from 'react-native';
import type { NativePeerPayloadRequest, NativePeerPayloadResult } from './nativePeerPayload';
export function nativePeerPayloadAvailable(): boolean { return Platform.OS === 'ios' && typeof NativeModules.CodelyncCodec?.decodeAuthenticatedPayload === 'function'; }
export async function decodeNativePeerPayload(request: NativePeerPayloadRequest): Promise<NativePeerPayloadResult> {
    if (!nativePeerPayloadAvailable()) throw Error('Native payload codec unavailable');
    return NativeModules.CodelyncCodec.decodeAuthenticatedPayload(request);
}
