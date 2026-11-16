import { beforeEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ write: vi.fn(), remove: vi.fn().mockResolvedValue(undefined), share: vi.fn(), available: vi.fn().mockResolvedValue(true) }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///cache/', EncodingType: { Base64: 'base64' }, writeAsStringAsync: calls.write, deleteAsync: calls.remove }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: calls.available, shareAsync: calls.share }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'fixture' }));
import { savePreviewImage } from './savePreviewImage';
beforeEach(() => { vi.clearAllMocks(); calls.available.mockResolvedValue(true); calls.write.mockResolvedValue(undefined); calls.remove.mockResolvedValue(undefined); calls.share.mockResolvedValue(undefined); });
describe('saving the loaded image preview', () => {
    it('stages the existing bytes, opens the system save menu and removes the temporary file', async () => {
        await savePreviewImage('data:image/jpeg;base64,AQID', '../../image.png');
        expect(calls.write).toHaveBeenCalledWith('file:///cache/codelight-image-fixture-______image.jpg', 'AQID', { encoding: 'base64' });
        expect(calls.share).toHaveBeenCalledWith('file:///cache/codelight-image-fixture-______image.jpg', { mimeType: 'image/jpeg', UTI: 'public.jpeg' });
        expect(calls.remove).toHaveBeenCalledWith('file:///cache/codelight-image-fixture-______image.jpg', { idempotent: true });
    });
    it('still cleans up after saving fails and rejects nonimage data', async () => {
        calls.share.mockRejectedValueOnce(Error('cancelled'));
        await expect(savePreviewImage('data:image/png;base64,AQID', 'image.png')).rejects.toThrow();
        expect(calls.remove).toHaveBeenLastCalledWith('file:///cache/codelight-image-fixture-image.png', { idempotent: true });
        await expect(savePreviewImage('data:text/html;base64,AQID', 'image.html')).rejects.toThrow('not an image');
    });
    it.each(['availability', 'write'])('rechecks scope after %s waits and never shares obsolete bytes', async stage => {
        let finish!: () => void, current = true;
        const waiting = new Promise<void>(resolve => { finish = resolve; });
        if (stage === 'availability') calls.available.mockImplementationOnce(async () => { await waiting; return true; });
        else calls.write.mockImplementationOnce(async () => { await waiting; });
        const save = savePreviewImage('data:image/png;base64,AQID', 'image.png', async () => { if (!current) throw Error('Preview scope changed'); });
        await vi.waitFor(() => expect(stage === 'availability' ? calls.available : calls.write).toHaveBeenCalledOnce());
        current = false; finish(); await expect(save).rejects.toThrow('scope changed');
        expect(calls.share).not.toHaveBeenCalled();
        if (stage === 'availability') { expect(calls.write).not.toHaveBeenCalled(); expect(calls.remove).not.toHaveBeenCalled(); }
        else expect(calls.remove).toHaveBeenCalledOnce();
    });
});
