import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ save: vi.fn(), alert: vi.fn(), close: vi.fn() }));
vi.mock('react-native', async () => {
    const React = await import('react'); const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return { View: host('View'), Text: host('Text'), Pressable: host('Pressable'), ActivityIndicator: host('ActivityIndicator'), useWindowDimensions: () => ({ width: 390, height: 844 }), Platform: { OS: 'ios', select: (v: any) => v.ios ?? v.default } };
});
vi.mock('react-native-unistyles', async () => { const { lightTheme } = await import('@/theme'); return { StyleSheet: { create: (value: any) => typeof value === 'function' ? value(lightTheme) : value }, useUnistyles: () => ({ theme: lightTheme }) }; });
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-native-gesture-handler', async () => {
    const React = await import('react'); const host = (props: any) => React.createElement('Gesture', props, props.children);
    const chain: any = {}; for (const key of ['onBegin', 'onUpdate', 'onEnd', 'enabled', 'maxDistance']) chain[key] = () => chain;
    return { GestureHandlerRootView: host, GestureDetector: host, Gesture: { Pinch: () => chain, Pan: () => chain, Tap: () => chain, Simultaneous: () => chain } };
});
vi.mock('react-native-reanimated', async () => { const React = await import('react'); return { default: { View: (props: any) => React.createElement('Animated', props, props.children) }, useSharedValue: (value: any) => ({ value }), useAnimatedStyle: (fn: any) => fn(), withTiming: (value: any) => value, runOnJS: (fn: any) => fn }; });
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-image', async () => { const React = await import('react'); return { Image: (props: any) => React.createElement('Image', props) }; });
vi.mock('@/hooks/useAttachmentImage', () => ({ useAttachmentImage: () => ({ uri: 'data:image/jpeg;base64,AQID', loading: false, error: null }) }));
vi.mock('@/hooks/useAttachmentPreviewScope', () => ({ useAttachmentPreviewScope: () => ({ valid: true, changed: false, retry: () => true, isCurrent: () => true, assertCurrent: async () => {} }) }));
vi.mock('@/utils/savePreviewImage', () => ({ savePreviewImage: calls.save }));
vi.mock('@/sync/nativeImageDiagnostics', () => ({ noteNativeImageStage: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: calls.alert } }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
import { AttachmentImagePreview } from './AttachmentImagePreview';
let renderer: ReturnType<typeof create> | undefined;
afterEach(async () => { if (renderer) await act(() => renderer.unmount()); renderer = undefined; vi.clearAllMocks(); });
it('enables download after rendering, saves the current preview and keeps save failures retryable', async () => {
    await act(() => { renderer = create(React.createElement(AttachmentImagePreview, { sessionId: 'session', refValue: 'ref', name: 'preview.jpg', onClose: calls.close })); });
    expect(renderer!.root.findByProps({ testID: 'happy-image-download' }).props.disabled).toBe(true);
    await act(() => renderer!.root.findByType('Image').props.onLoad());
    expect(renderer!.root.findByProps({ testID: 'happy-image-download' }).props.disabled).toBe(false);
    await act(async () => renderer!.root.findByProps({ testID: 'happy-image-download' }).props.onPress());
    expect(calls.save).toHaveBeenCalledWith('data:image/jpeg;base64,AQID', 'preview.jpg', expect.any(Function));
    calls.save.mockRejectedValueOnce(Error('save failed'));
    await act(async () => renderer!.root.findByProps({ testID: 'happy-image-download' }).props.onPress());
    expect(calls.alert).toHaveBeenCalledWith('common.error', 'Could not save this file. Try Save again.');
    expect(renderer!.root.findByProps({ testID: 'happy-image-download' }).props.disabled).toBe(false);
    await act(() => renderer!.root.findByProps({ testID: 'happy-image-close' }).props.onPress()); expect(calls.close).toHaveBeenCalledOnce();
});
