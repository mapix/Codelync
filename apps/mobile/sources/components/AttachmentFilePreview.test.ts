import * as React from 'react';
// @ts-expect-error The existing renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ credentials: null as any, key: null as Uint8Array | null, peer: 'peer:one',
    stores: new Set<() => void>(), statuses: new Set<() => void>(), close: vi.fn(), load: vi.fn(), dispose: vi.fn(),
    available: vi.fn(), share: vi.fn(), savedRead: vi.fn() }));
vi.mock('react-native', () => ({ ActivityIndicator: 'Spinner', Pressable: 'Button', ScrollView: 'Scroll', Text: 'Text', View: 'View',
    useWindowDimensions: () => ({ width: 390, height: 844 }), Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default } }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({}) }, useUnistyles: () => ({ theme: { colors: { text: 'black', textSecondary: 'gray' } } }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-video', () => ({ VideoView: 'Video', useVideoPlayer: () => ({}) }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: state.available, shareAsync: state.share }));
vi.mock('@/sync/attachmentFile', () => ({ loadAttachmentFile: state.load, MAX_ATTACHMENT_PREVIEW_BYTES: 10 * 1024 * 1024 }));
vi.mock('@/sync/sync', () => ({ sync: { getCredentials: () => state.credentials, encryption: { getSessionBlobKey: () => state.key } } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ currentViewingSessionId: 'session', sessions: {} }),
    subscribe: (f: () => void) => { state.stores.add(f); return () => state.stores.delete(f); } } }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerIdentity: () => state.peer,
    onStatusChange: (f: () => void) => { state.statuses.add(f); return () => state.statuses.delete(f); } } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://channel-one' }));
vi.mock('@/sync/imageReadCredentials', () => ({ currentImageReadCredentials: state.savedRead }));
vi.mock('@/sync/nativeImageDiagnostics', () => ({ noteNativeImageStage: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key, getCurrentLanguage: () => 'en' }));
vi.mock('./AttachmentImagePreview', () => ({ AttachmentImagePreview: () => null }));
import { AttachmentFilePreview } from './AttachmentFilePreview';
let screen: ReturnType<typeof create> | undefined;
beforeEach(() => {
    vi.clearAllMocks(); state.key = null; state.peer = 'peer:one';
    state.credentials = { token: 'owner-token', secret: 'account-one', peer: { id: 'one', device: { publicKey: 'device-one' } } };
    state.savedRead.mockResolvedValue(state.credentials); state.available.mockResolvedValue(true);
    state.dispose.mockResolvedValue(undefined); state.share.mockResolvedValue(undefined);
    state.load.mockResolvedValue({ uri: 'private-video-uri', name: 'fixture.mp4', mimeType: 'video/mp4', size: 50, text: null, dispose: state.dispose });
});
afterEach(async () => { if (screen) await act(() => screen!.unmount()); screen = undefined; state.stores.clear(); state.statuses.clear(); });
async function mount(metadata = { name: 'fixture.mp4', mimeType: 'video/mp4' } as { name: string; mimeType: string; size?: number }) { await act(() => { screen = create(React.createElement(AttachmentFilePreview, {
    sessionId: 'session', refValue: 'ref', metadata, onClose: state.close,
})); }); }
async function changed() { await act(() => { for (const f of state.stores) f(); for (const f of state.statuses) f(); }); }

it('renders initial unavailable video with zero loader IO and only retries after the same-source key is ready', async () => {
    await mount();
    expect(screen!.root.findByProps({ testID: 'codelight-file-preview' })).toBeTruthy();
    expect(screen!.root.findByProps({ testID: 'codelight-file-retry' })).toBeTruthy();
    expect(screen!.root.findAllByType('Spinner')).toHaveLength(0); expect(state.close).not.toHaveBeenCalled();
    await act(() => screen!.root.findByProps({ testID: 'codelight-file-retry' }).props.onPress());
    expect(state.load).not.toHaveBeenCalled(); expect(state.savedRead).not.toHaveBeenCalled();
    state.key = new Uint8Array(32); await changed();
    expect(state.load).not.toHaveBeenCalled();
    await act(() => screen!.root.findByProps({ testID: 'codelight-file-retry' }).props.onPress());
    expect(state.load).toHaveBeenCalledOnce(); expect(screen!.root.findByProps({ testID: 'codelight-video-player' })).toBeTruthy();
});

it.each(['key', 'peer'])('a loaded video %s replacement hides, disposes and fences its stale Save', async field => {
    state.key = new Uint8Array(32); await mount();
    const save = screen!.root.findAllByType('Button').find((node: any) => node.props.accessibilityLabel === 'Save')!.props.onPress;
    if (field === 'key') state.key = null;
    else { state.credentials.peer.id = 'two'; state.peer = 'peer:two'; }
    await changed();
    expect(screen!.toJSON()).toBe(null); expect(state.close).toHaveBeenCalledOnce(); expect(state.dispose).toHaveBeenCalledOnce();
    await act(() => save()); expect(state.share).not.toHaveBeenCalled(); expect(state.load).toHaveBeenCalledOnce();
});

it('a result arriving after source replacement is disposed without a player or second load', async () => {
    let resolve!: (value: any) => void;
    state.load.mockReturnValueOnce(new Promise(done => { resolve = done; })); state.key = new Uint8Array(32); await mount();
    const signal = state.load.mock.calls[0][3]; state.key = new Uint8Array(32).fill(1); await changed();
    expect(signal.aborted).toBe(true);
    await act(() => resolve({ uri: 'late-private-uri', name: 'fixture.mp4', mimeType: 'video/mp4', size: 50, text: null, dispose: state.dispose }));
    expect(state.dispose).toHaveBeenCalledOnce(); expect(screen!.toJSON()).toBe(null); expect(state.load).toHaveBeenCalledOnce();
});

it('a pending unavailable Retry cannot load a different peer that reuses the same ref', async () => {
    await mount(); const retry = screen!.root.findByProps({ testID: 'codelight-file-retry' }).props.onPress;
    state.credentials.peer.id = 'two'; state.peer = 'peer:two'; state.key = new Uint8Array(32);
    await act(() => retry());
    expect(state.load).not.toHaveBeenCalled(); expect(state.close).toHaveBeenCalledOnce();
});

it('an explicitly opened known oversized video never loads bytes, exposes Retry or constructs a player', async () => {
    state.key = new Uint8Array(32); await mount({ name: 'large.mp4', mimeType: 'video/mp4', size: 1_000_001 });
    expect(state.load).not.toHaveBeenCalled(); expect(state.savedRead).not.toHaveBeenCalled();
    expect(screen!.root.findAllByProps({ testID: 'codelight-file-retry' })).toHaveLength(0);
    expect(screen!.root.findAllByProps({ testID: 'codelight-video-player' })).toHaveLength(0);
    expect(screen!.root.findAllByType('Text').map((node: any) => node.props.children)).toContain('Video exceeds the 1 MB limit.');
    expect(screen!.root.findAllByType('Button').find((node: any) => node.props.accessibilityLabel === 'Save')!.props.disabled).toBe(true);
});
it('Save failure is separate from loading and retries the existing preview without another download', async () => {
    state.key = new Uint8Array(32); await mount();
    state.share.mockRejectedValueOnce(Error('PRIVATE_SAVE_URL')).mockResolvedValueOnce(undefined);
    const save = () => screen!.root.findAllByType('Button').find((node: any) => node.props.accessibilityLabel === 'Save')!.props.onPress;
    await act(async () => { const press = save(); press(); press(); });
    expect(state.share).toHaveBeenCalledOnce(); expect(state.load).toHaveBeenCalledOnce();
    expect(screen!.root.findByProps({ testID: 'codelight-file-save-error' }).props.children).toBe('Could not save this file. Try Save again.');
    expect(screen!.root.findByProps({ testID: 'codelight-video-player' })).toBeTruthy(); expect(state.dispose).not.toHaveBeenCalled();
    expect(screen!.root.findAllByProps({ testID: 'codelight-file-retry' })).toHaveLength(0);
    await act(async () => save()());
    expect(state.share).toHaveBeenCalledTimes(2); expect(state.load).toHaveBeenCalledOnce();
    expect(screen!.root.findAllByProps({ testID: 'codelight-file-save-error' })).toHaveLength(0);
});
it('a device without Save support shows a specific message while retaining the loaded preview', async () => {
    state.key = new Uint8Array(32); state.available.mockResolvedValueOnce(false); await mount();
    await act(async () => screen!.root.findAllByType('Button').find((node: any) => node.props.accessibilityLabel === 'Save')!.props.onPress());
    expect(screen!.root.findByProps({ testID: 'codelight-file-save-error' }).props.children).toBe('Saving is unavailable on this device.');
    expect(state.share).not.toHaveBeenCalled(); expect(state.load).toHaveBeenCalledOnce(); expect(state.dispose).not.toHaveBeenCalled();
});

it.each([1_000_000, 1_000_001])('loaded video result at %s bytes cannot bypass the player limit', async size => {
    state.key = new Uint8Array(32); state.load.mockResolvedValueOnce({ uri: 'private-video-uri', name: 'fixture.mp4', mimeType: 'video/mp4', size, text: null, dispose: state.dispose });
    await mount();
    expect(screen!.root.findAllByProps({ testID: 'codelight-video-player' })).toHaveLength(size > 1_000_000 ? 0 : 1);
    expect(state.dispose).toHaveBeenCalledTimes(size > 1_000_000 ? 1 : 0);
    if (size > 1_000_000) {
        expect(screen!.root.findAllByProps({ testID: 'codelight-file-retry' })).toHaveLength(0);
        const save = screen!.root.findAllByType('Button').find((node: any) => node.props.accessibilityLabel === 'Save')!;
        expect(save.props.disabled).toBe(true); await act(() => save.props.onPress()); expect(state.share).not.toHaveBeenCalled();
    }
});
