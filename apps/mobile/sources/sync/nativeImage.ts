import { apiSocket } from './apiSocket';
import { getServerUrl } from './serverConfig';
import { sync } from './sync';
import { NativeFileArgumentsSchema, type NativeFileArguments } from './typesRaw';
import { noteNativeImageStage } from './nativeImageDiagnostics';
import { currentImageReadCredentials } from './imageReadCredentials';

export type NativeImageAttachment = Extract<NativeFileArguments, { ref: string }>;

/** Called only after the user opens the placeholder; no image data enters session sync. */
export async function loadNativeImageAttachment(sessionId: string, imageId: string): Promise<NativeImageAttachment> {
    const expected = sync.getCredentials();
    if (!expected) throw Error('The session connection is not ready');
    const credentials = await currentImageReadCredentials(expected), endpoint = getServerUrl();
    const started = Date.now(); noteNativeImageStage('rpc-start');
    let result: unknown;
    try { result = await apiSocket.sessionRPC<unknown, { imageId: string }>(sessionId, 'native-image-read', { imageId }, endpoint); }
    catch (error) { noteNativeImageStage('rpc-failed', { ms: Date.now() - started }); throw error; }
    noteNativeImageStage('rpc-received', { ms: Date.now() - started });
    if (result === null) { noteNativeImageStage('rpc-decrypt-failed'); throw Error('The image response could not be decrypted'); }
    await currentImageReadCredentials(credentials);
    if (!credentials.peer && (getServerUrl() !== endpoint || sync.getCredentials()?.token !== credentials.token)) { noteNativeImageStage('connection-changed'); throw Error('The image connection changed'); }
    const parsed = NativeFileArgumentsSchema.safeParse(result);
    if (!parsed.success) { noteNativeImageStage('response-invalid'); throw Error('The image response is invalid'); }
    const attachment = parsed.data;
    const prefix = `sessions/${sessionId}/attachments/`;
    if (!('ref' in attachment) || !attachment.ref.startsWith(prefix) || !/^[a-f0-9-]{36}\.enc$/.test(attachment.ref.slice(prefix.length))) throw Error('The image does not belong to this session');
    return attachment;
}
