export const PEER_RESPONSE_CODEC_HEADER: 'x-codelight-peer-codec';
export const PEER_RESPONSE_CODEC_VALUE: '3';
export const PEER_RESPONSE_MAX_BYTES: number;
export const PEER_COMPACT_PREFIX_BYTES: number;
/** Explicit synthetic fixtures only; live response encoding owns its compressor. */
export function gzipSync(body: Uint8Array, options?: { level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }): Uint8Array;
export function compactPeerBody(payload: unknown): { body: Uint8Array; compact: boolean };
export function encodeCompactPeerPlaintext(peerId: string, payload: unknown, compress?: (body: Uint8Array) => Uint8Array): Uint8Array;
export type PeerDecodeStage = 'validate' | 'base64' | 'authenticate' | 'inflate' | 'checksum' | 'utf8' | 'json' | 'native-body';
export type PeerDecodeObserver = (stage: PeerDecodeStage, milliseconds: number) => void;
export function decodePeerUtf8(bytes: Uint8Array): string;
export function inspectCompactPeerPlaintext(plain: Uint8Array, expectedPeerId: string): { body: Uint8Array; expectedBytes: number; compressed: boolean; compact: boolean };
export function parseCompactPeerJson(text: string, compact: boolean): unknown;
export function decodeCompactPeerPlaintext(plain: Uint8Array, expectedPeerId: string, options?: { onStage?: PeerDecodeObserver; decodeText?: (body: Uint8Array) => string }): unknown;
