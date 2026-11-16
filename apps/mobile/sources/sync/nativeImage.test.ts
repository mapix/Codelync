import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ endpoint: 'http://localhost:1234', token: 'fixture-token', rpc: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: state.rpc } }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => state.endpoint }));
vi.mock('./sync', () => ({ sync: { getCredentials: () => ({ token: state.token }) } }));
vi.mock('./nativeImageDiagnostics', () => ({ noteNativeImageStage: vi.fn() }));
vi.mock('./imageReadCredentials', () => ({ currentImageReadCredentials: async (value: unknown) => value }));
import { loadNativeImageAttachment } from './nativeImage';

describe('explicit original image reads', () => {
    it('requests only the original image identity and validates the same-session attachment', async () => {
        const attachment = { ref: 'sessions/session-1/attachments/11111111-1111-1111-1111-111111111111.enc', name: 'image.png', image: { width: 390, height: 844 } };
        state.rpc.mockResolvedValueOnce(attachment);
        await expect(loadNativeImageAttachment('session-1', 'native-image')).resolves.toEqual(attachment);
        expect(state.rpc).toHaveBeenLastCalledWith('session-1', 'native-image-read', { imageId: 'native-image' }, state.endpoint);
        state.rpc.mockResolvedValueOnce({ ...attachment, ref: attachment.ref.replace('session-1', 'session-2') });
        await expect(loadNativeImageAttachment('session-1', 'native-image')).rejects.toThrow('does not belong');
        state.rpc.mockImplementationOnce(async () => { state.token = 'another-account'; return attachment; });
        await expect(loadNativeImageAttachment('session-1', 'native-image')).rejects.toThrow('connection changed');
    });
});
