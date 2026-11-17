import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ show: vi.fn(), image: vi.fn(), load: vi.fn() }));
vi.mock('react-native', async () => {
    const React = await import('react');
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return { View: host('View'), Text: host('Text'), Pressable: host('Pressable'), ActivityIndicator: host('ActivityIndicator'), useWindowDimensions: () => ({ width: 390, height: 844 }), Platform: { OS: 'ios', select: (value: any) => value.ios ?? value.default } };
});
vi.mock('react-native-unistyles', async () => {
    const { lightTheme } = await import('@/theme');
    return { StyleSheet: { create: (value: any) => typeof value === 'function' ? value(lightTheme) : value }, useUnistyles: () => ({ theme: lightTheme }) };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@/modal', () => ({ Modal: { show: calls.show } }));
vi.mock('@/text', () => ({ t: (key: string) => key, getCurrentLanguage: () => 'en' }));
vi.mock('@/components/AttachmentFilePreview', () => ({ AttachmentFilePreview: 'FilePreview' }));
vi.mock('@/utils/thumbhash', () => ({ thumbhashToDataUri: () => undefined }));
vi.mock('@/hooks/useAttachmentImage', () => ({ useAttachmentImage: calls.image }));
vi.mock('@/sync/nativeImage', () => ({ loadNativeImageAttachment: calls.load }));
vi.mock('@/components/AttachmentImagePreview', async () => {
    const React = await import('react');
    return { AttachmentImagePreview: (props: any) => React.createElement('ImagePreview', props) };
});
import { FileView } from './FileView';
import { NativeImagePreview } from '@/components/NativeImagePreview';
const renderers: ReturnType<typeof create>[] = [];
afterEach(async () => { for (const renderer of renderers.splice(0)) await act(() => renderer.unmount()); vi.clearAllMocks(); });

describe('native image placeholders', () => {
    it('does not fetch images when mounted; clicking opens the separate loader', async () => {
        calls.load.mockResolvedValue({ ref: 'fixture-ref', name: 'image.png', image: { width: 390, height: 844 } });
        let renderer: ReturnType<typeof create>;
        await act(() => { renderer = create(React.createElement(FileView, { tool: { name: 'file', input: { nativeImageId: 'original-image', name: 'image.png' } } as any, sessionId: 'session-1', metadata: null, messages: [] })); }); renderers.push(renderer!);
        expect(calls.load).not.toHaveBeenCalled(); expect(calls.image).not.toHaveBeenCalled();
        await act(() => renderer!.root.findByProps({ testID: 'codelync-native-image-original-image' }).props.onPress());
        const modal = calls.show.mock.calls[0][0]; expect(modal.props).toEqual({ sessionId: 'session-1', imageId: 'original-image', name: 'image.png' });
        let preview: ReturnType<typeof create>; await act(async () => { preview = create(React.createElement(modal.component, modal.props)); }); renderers.push(preview!);
        expect(calls.load).toHaveBeenCalledTimes(1); expect(calls.load).toHaveBeenCalledWith('session-1', 'original-image');
        expect(preview!.root.findByType('ImagePreview').props).toMatchObject({ refValue: 'fixture-ref', width: 390, height: 844 });
        expect(calls.image).not.toHaveBeenCalled();
    });
    it('keeps loading failures retryable inside the preview', async () => {
        calls.load.mockRejectedValueOnce(Error('missing')).mockResolvedValueOnce({ ref: 'fixture-ref', name: 'image.png' });
        let renderer: ReturnType<typeof create>;
        await act(async () => { renderer = create(React.createElement(NativeImagePreview, { sessionId: 'session-1', imageId: 'original-image', name: 'image.png' })); }); renderers.push(renderer!);
        await act(async () => renderer!.root.findByProps({ testID: 'codelync-native-image-retry' }).props.onPress());
        expect(calls.load).toHaveBeenCalledTimes(2); expect(renderer!.root.findByType('ImagePreview').props.refValue).toBe('fixture-ref');
    });
});

describe('attachment media cards', () => {
    it.each([1_000_000, 1_000_001])('known video card at %s bytes keeps a strict 1 MB Open boundary with zero IO', async size => {
        let renderer!: ReturnType<typeof create>;
        await act(() => { renderer = create(React.createElement(FileView, { tool: { name: 'file', input: { ref: 'video-ref', name: 'clip.mp4', mimeType: 'video/mp4', size } } as any,
            sessionId: 'session', metadata: null, messages: [] })); }); renderers.push(renderer);
        const card = renderer.root.findByProps({ testID: 'codelync-attachment-video-ref' });
        expect(card.props.disabled).toBe(size > 1_000_000);
        await act(() => card.props.onPress());
        expect(calls.show).toHaveBeenCalledTimes(size > 1_000_000 ? 0 : 1);
        expect(calls.load).not.toHaveBeenCalled(); expect(calls.image).not.toHaveBeenCalled();
        if (size > 1_000_000) expect(card.props.accessibilityLabel).toContain('1 MB');
    });
    it('ordinary files above 1 MB and unknown-sized videos still open their bounded loader', async () => {
        for (const input of [{ ref: 'file', name: 'document.pdf', mimeType: 'application/pdf', size: 2_000_000 }, { ref: 'video', name: 'clip.mp4', mimeType: 'video/mp4' }]) {
            let renderer!: ReturnType<typeof create>;
            await act(() => { renderer = create(React.createElement(FileView, { tool: { name: 'file', input } as any, sessionId: 'session', metadata: null, messages: [] })); }); renderers.push(renderer);
            const card = renderer.root.findByProps({ testID: 'codelync-attachment-' + input.ref });
            expect(card.props.disabled).toBe(false); await act(() => card.props.onPress());
        }
        expect(calls.show).toHaveBeenCalledTimes(2); expect(calls.load).not.toHaveBeenCalled();
    });
    it('generic MIME with a known video extension still disables an oversized card without opening', async () => {
        let renderer!: ReturnType<typeof create>;
        await act(() => { renderer = create(React.createElement(FileView, { tool: { name: 'file', input: { ref: 'generic-video', name: 'clip.mp4', mimeType: 'application/octet-stream', size: 1_000_001 } } as any,
            sessionId: 'session', metadata: null, messages: [] })); }); renderers.push(renderer);
        const card = renderer.root.findByProps({ testID: 'codelync-attachment-generic-video' });
        expect(card.props.disabled).toBe(true); expect(card.props.accessibilityLabel).toContain('1 MB');
        await act(() => card.props.onPress()); expect(calls.show).not.toHaveBeenCalled(); expect(calls.load).not.toHaveBeenCalled();
    });
    it.each([
        { name: 'clip.mp4', mimeType: 'video/mp4', image: false },
        { name: 'report.pdf', mimeType: 'application/pdf', image: false },
        { name: 'photo.png', mimeType: 'image/png', image: true },
    ])('loads $name only after opening its card, once per mounted preview', async ({ name, mimeType, image }) => {
        let renderer!: ReturnType<typeof create>;
        await act(async () => { renderer = create(React.createElement(FileView, { tool: { name: 'file', input: { ref: 'owned-ref', name, mimeType, size: 100 } } as any,
            sessionId: 'session-1', metadata: null, messages: [] })); }); renderers.push(renderer);
        expect(calls.image).not.toHaveBeenCalled(); expect(calls.load).not.toHaveBeenCalled(); expect(calls.show).not.toHaveBeenCalled();
        const card = renderer.root.findByProps({ testID: 'codelync-attachment-owned-ref' });
        await act(async () => { card.props.onPress(); card.props.onPress(); });
        expect(calls.show).toHaveBeenCalledOnce();
        expect(calls.show.mock.calls[0][0].props).toMatchObject({ sessionId: 'session-1', refValue: 'owned-ref', image, metadata: { name, mimeType } });
        calls.show.mock.calls[0][0].props.onClosed();
        await act(async () => card.props.onPress()); expect(calls.show).toHaveBeenCalledTimes(2);
    });
    it('metadata without an owned reference never invokes a download or invents a file RPC', async () => {
        let renderer!: ReturnType<typeof create>;
        await act(async () => { renderer = create(React.createElement(FileView, { tool: { name: 'file', input: { name: 'clip.mp4', mimeType: 'video/mp4' } } as any,
            sessionId: 'session-1', metadata: null, messages: [] })); }); renderers.push(renderer);
        const card = renderer.root.findByProps({ testID: 'codelync-attachment-unavailable' });
        expect(card.props.disabled).toBe(true); await act(async () => card.props.onPress());
        expect(calls.show).not.toHaveBeenCalled(); expect(calls.image).not.toHaveBeenCalled();
    });
});
