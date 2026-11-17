import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import { previewImagePoint } from '@/utils/windowControlGeometry';
import { getCurrentLanguage, t } from '@/text';
import { codelyncMediaLabels } from '@/text/codelyncMediaLabels';
import { savePreviewImage } from '@/utils/savePreviewImage';
import { Modal } from '@/modal';
import { noteNativeImageStage } from '@/sync/nativeImageDiagnostics';
import { useAttachmentPreviewScope } from '@/hooks/useAttachmentPreviewScope';

type PreviewProps = { sessionId: string; refValue: string; name: string; width?: number; height?: number; onClose?: () => void; live?: boolean; onPoint?: (x: number, y: number) => void; interactionEnabled?: boolean; statusText?: string };
export const AttachmentImagePreview = React.memo(function AttachmentImagePreview(props: PreviewProps) {
    const [attempt, setAttempt] = React.useState(0);
    const scope = useAttachmentPreviewScope(props.sessionId, props.refValue, props.onClose, props.live === true);
    const retry = () => { if (scope.retry()) setAttempt(value => value + 1); };
    if (scope.changed) return null;
    if (!scope.valid) return <UnavailableImagePreview name={props.name} onClose={props.onClose} onRetry={retry} />;
    return <ImagePreviewBody key={`${props.sessionId}:${props.live ? 'live' : props.refValue}:${attempt}`} {...props} onRetry={retry}
        isScopeCurrent={scope.isCurrent} assertScopeCurrent={scope.assertCurrent} />;
});

function UnavailableImagePreview({ name, onClose, onRetry }: { name: string; onClose?: () => void; onRetry: () => void }) {
    const { theme } = useUnistyles(), screen = useWindowDimensions(), insets = useSafeAreaInsets();
    return <View testID="happy-image-preview" style={[styles.container, { width: screen.width, height: screen.height, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.toolbar}><Text numberOfLines={1} style={styles.title}>{name}</Text>
            <Pressable testID="happy-image-close" accessibilityRole="button" accessibilityLabel={t('imagePreview.close')} onPress={onClose} style={styles.button}><Ionicons name="close" size={24} color={theme.colors.text} /></Pressable>
        </View>
        <View style={[styles.imageArea, { flex: 1 }]}><Text style={styles.statusText}>{t('imagePreview.loadFailed')}</Text>
            <Pressable testID="codelync-image-retry" accessibilityRole="button" onPress={onRetry} style={styles.button}><Text style={styles.statusText}>{t('common.retry')}</Text></Pressable>
        </View>
    </View>;
}

function ImagePreviewBody({ sessionId, refValue, name, width, height, onClose, onRetry, onPoint, interactionEnabled = true, statusText, isScopeCurrent, assertScopeCurrent }: PreviewProps & {
    onRetry: () => void; isScopeCurrent(): boolean; assertScopeCurrent(): Promise<void>;
}) {
    const { theme } = useUnistyles();
    const screen = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const { uri, loading, error } = useAttachmentImage(sessionId, refValue);
    const [imageReady, setImageReady] = React.useState(false);
    const [renderFailed, setRenderFailed] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [zoom, setZoom] = React.useState(1);
    const [control, setControl] = React.useState(false);
    const areaHeight = Math.max(1, screen.height - insets.top - insets.bottom - 112);
    const ratio = width && height && width > 0 && height > 0 ? width / height : 4 / 3;
    const imageW = Math.min(screen.width, areaHeight * ratio);
    const imageH = imageW / ratio;
    const scale = useSharedValue(1), originScale = useSharedValue(1);
    const x = useSharedValue(0), y = useSharedValue(0), startX = useSharedValue(0), startY = useSharedValue(0);
    const reset = () => { scale.value = withTiming(1); x.value = withTiming(0); y.value = withTiming(0); setZoom(1); };
    const changeZoom = (value: number) => { const next = Math.min(5, Math.max(1, value)); scale.value = withTiming(next); if (next === 1) { x.value = withTiming(0); y.value = withTiming(0); } setZoom(next); };
    const pinch = Gesture.Pinch().onBegin(() => { originScale.value = scale.value; }).onUpdate(event => {
        scale.value = Math.min(5, Math.max(1, originScale.value * event.scale));
        const maxX = Math.max(0, (imageW * scale.value - screen.width) / 2);
        const maxY = Math.max(0, (imageH * scale.value - areaHeight) / 2);
        x.value = Math.max(-maxX, Math.min(maxX, x.value));
        y.value = Math.max(-maxY, Math.min(maxY, y.value));
    }).onEnd(() => { runOnJS(setZoom)(scale.value); });
    const pan = Gesture.Pan().onBegin(() => { startX.value = x.value; startY.value = y.value; }).onUpdate(event => {
        const maxX = Math.max(0, (imageW * scale.value - screen.width) / 2);
        const maxY = Math.max(0, (imageH * scale.value - areaHeight) / 2);
        x.value = Math.max(-maxX, Math.min(maxX, startX.value + event.translationX));
        y.value = Math.max(-maxY, Math.min(maxY, startY.value + event.translationY));
    });
    const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }));
    React.useEffect(() => { setImageReady(false); setRenderFailed(false); }, [uri]);
    const failed = !!error || renderFailed || (!loading && !uri);
    const download = async () => {
        if (!uri || failed || saving || !imageReady || !isScopeCurrent()) return;
        setSaving(true);
        try { await assertScopeCurrent(); await savePreviewImage(uri, name, assertScopeCurrent); }
        catch { Modal.alert(t('common.error'), codelyncMediaLabels[getCurrentLanguage()].saveFailed); }
        finally { setSaving(false); }
    };
    const point = onPoint;
    const tap = Gesture.Tap().enabled(!!point && control && !!uri && imageReady && !failed && interactionEnabled).maxDistance(10).onEnd((event, success) => {
        if (!success || !point) return;
        const position = previewImagePoint(event.absoluteX, event.absoluteY, { centerX: screen.width / 2, centerY: insets.top + 56 + areaHeight / 2,
            imageWidth: imageW, imageHeight: imageH, scale: scale.value, x: x.value, y: y.value });
        if (position) runOnJS(point)(position.x, position.y);
    });
    return <GestureHandlerRootView testID="happy-image-preview" style={[styles.container, { width: screen.width, height: screen.height, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.toolbar}>
            <Text numberOfLines={1} style={styles.title}>{name}</Text>
            <Pressable testID="happy-image-download" accessibilityRole="button" accessibilityLabel={t('imagePreview.download')} disabled={!uri || failed || saving || !imageReady} onPress={download} style={styles.button}>
                {saving ? <ActivityIndicator size="small" color={theme.colors.text} /> : <Ionicons name="download-outline" size={24} color={!uri || failed || !imageReady ? theme.colors.textSecondary : theme.colors.text} />}
            </Pressable>
            {onPoint && <Pressable accessibilityRole="button" testID="codelync-window-control-mode" disabled={!interactionEnabled} onPress={() => setControl(value => !value)} style={styles.button}><Text style={styles.statusText}>{control ? t('windowControl.controlling') : t('windowControl.viewOnly')}</Text></Pressable>}
            <Pressable testID="happy-image-close" accessibilityRole="button" accessibilityLabel={t('imagePreview.close')} onPress={onClose} style={styles.button}><Ionicons name="close" size={24} color={theme.colors.text} /></Pressable>
        </View>
        <View style={[styles.imageArea, { height: areaHeight }]}>
            {uri && !failed && <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, tap)}><Animated.View style={[{ width: imageW, height: imageH }, animatedStyle]}>
                <Image source={{ uri }} style={{ width: imageW, height: imageH }} contentFit="contain" onLoad={() => setImageReady(true)} onError={() => { noteNativeImageStage('render-failed'); setRenderFailed(true); }} />
            </Animated.View></GestureDetector>}
            {(loading || !imageReady) && !failed && <View style={styles.status}><ActivityIndicator color={theme.colors.text} /><Text style={styles.statusText}>{t('common.loading')}</Text></View>}
            {failed && <View style={styles.status}><Ionicons name="alert-circle-outline" size={28} color={theme.colors.textSecondary} /><Text style={styles.statusText}>{t('imagePreview.loadFailed')}</Text><Pressable accessibilityRole="button" onPress={onRetry} style={styles.button}><Text style={styles.statusText}>{t('common.retry')}</Text></Pressable></View>}
        </View>
        {statusText && <View style={{ position: 'absolute', bottom: insets.bottom + 60, left: 16, right: 16 }}><Text accessibilityRole="alert" numberOfLines={2} style={styles.statusText}>{statusText}</Text></View>}
        <View style={styles.controls}>
            <Pressable testID="happy-image-zoom-out" accessibilityRole="button" accessibilityLabel={t('imagePreview.zoomOut')} onPress={() => changeZoom(zoom - 1)} style={styles.button}><Ionicons name="remove" size={24} color={theme.colors.text} /></Pressable>
            <Pressable testID="happy-image-reset" accessibilityRole="button" accessibilityLabel={t('imagePreview.reset')} onPress={reset} style={styles.button}><Ionicons name="refresh" size={22} color={theme.colors.text} /></Pressable>
            <Pressable testID="happy-image-zoom-in" accessibilityRole="button" accessibilityLabel={t('imagePreview.zoomIn')} onPress={() => changeZoom(zoom + 1)} style={styles.button}><Ionicons name="add" size={24} color={theme.colors.text} /></Pressable>
        </View>
    </GestureHandlerRootView>;
}

const styles = StyleSheet.create(theme => ({
    container: { backgroundColor: theme.colors.groupped.background },
    toolbar: { height: 56, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
    title: { flex: 1, fontSize: 16, fontWeight: '600', color: theme.colors.text },
    imageArea: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    status: { position: 'absolute', alignItems: 'center', justifyContent: 'center', gap: 14 },
    statusText: { color: theme.colors.textSecondary, fontSize: 15 },
    button: { padding: 12, alignItems: 'center', justifyContent: 'center' },
    controls: { height: 56, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 28 },
}));
