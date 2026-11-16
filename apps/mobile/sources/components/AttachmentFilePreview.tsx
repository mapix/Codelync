import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { loadAttachmentFile, type LoadedAttachmentFile } from '@/sync/attachmentFile';
import { attachmentByteLabel, attachmentPreviewByteLimit, AttachmentPreviewLimitError, loadedVideoExceedsPreviewLimit,
    MAX_VIDEO_PREVIEW_BYTES, type AttachmentMediaMetadata } from '@/utils/attachmentMedia';
import { codeLightMediaLabels } from '@/text/codeLightMediaLabels';
import { getCurrentLanguage, t } from '@/text';
import { AttachmentImagePreview } from './AttachmentImagePreview';
import { useAttachmentPreviewScope } from '@/hooks/useAttachmentPreviewScope';

type Props = { sessionId: string; refValue: string; metadata: AttachmentMediaMetadata; image?: boolean; onClose?: () => void; onClosed?: () => void };

/** The card mounts this preview only after an explicit open. */
export function AttachmentFilePreview(props: Props) {
    React.useEffect(() => () => props.onClosed?.(), []);
    if (props.image) return <AttachmentImagePreview sessionId={props.sessionId} refValue={props.refValue} name={props.metadata.name}
        width={props.metadata.image?.width} height={props.metadata.image?.height} onClose={props.onClose} />;
    return <LoadedFilePreview {...props} />;
}

function LoadedFilePreview({ sessionId, refValue, metadata, onClose }: Props) {
    const scope = useAttachmentPreviewScope(sessionId, refValue, onClose);
    const { theme } = useUnistyles(), screen = useWindowDimensions(), insets = useSafeAreaInsets();
    const labels = codeLightMediaLabels[getCurrentLanguage()];
    const [loaded, setLoaded] = React.useState<LoadedAttachmentFile | null>(null), [failed, setFailed] = React.useState(false);
    const [attempt, setAttempt] = React.useState(0), [saving, setSaving] = React.useState(false);
    const [saveError, setSaveError] = React.useState<'failed' | 'unavailable' | null>(null), saveFlight = React.useRef(false);
    const [limitExceeded, setLimitExceeded] = React.useState<number | null>(null);
    const limit = attachmentPreviewByteLimit(metadata), oversized = metadata.size !== undefined && metadata.size > limit;
    const blockedLimit = oversized ? limit : loaded && loadedVideoExceedsPreviewLimit(loaded) ? MAX_VIDEO_PREVIEW_BYTES : limitExceeded;
    const currentFile = !blockedLimit ? loaded : null;
    React.useEffect(() => {
        if (!scope.valid || oversized) return;
        const controller = new AbortController(); let active = true, value: LoadedAttachmentFile | null = null;
        setLoaded(null); setFailed(false); setLimitExceeded(null);
        void loadAttachmentFile(sessionId, refValue, metadata, controller.signal).then(result => {
            if (!active || !scope.isCurrent()) { void result.dispose(); return; }
            if (loadedVideoExceedsPreviewLimit(result)) { void result.dispose(); setLimitExceeded(MAX_VIDEO_PREVIEW_BYTES); setFailed(true); return; }
            value = result;
            setLoaded(result);
        }, error => { if (active && !controller.signal.aborted) {
            setFailed(true); if (error instanceof AttachmentPreviewLimitError) setLimitExceeded(error.limit);
        } });
        return () => { active = false; controller.abort(); void value?.dispose(); };
    }, [sessionId, refValue, attempt, scope.valid, scope.isCurrent, oversized, limit]);
    const save = async () => {
        if (!currentFile || saving || saveFlight.current || !scope.isCurrent()) return;
        saveFlight.current = true; setSaving(true); setSaveError(null);
        try {
            await scope.assertCurrent();
            if (Platform.OS === 'web') {
                const link = document.createElement('a'); link.href = currentFile.uri; link.download = currentFile.name; link.click();
            } else if (await isAvailableAsync()) { await scope.assertCurrent(); await shareAsync(currentFile.uri, { mimeType: currentFile.mimeType }); }
            else setSaveError('unavailable');
        } catch { setSaveError('failed'); } finally { saveFlight.current = false; setSaving(false); }
    };
    if (scope.changed) return null;
    return <View testID="codelight-file-preview" style={[styles.container, { width: screen.width, height: screen.height, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
            <Text style={styles.name} numberOfLines={1}>{metadata.name}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={labels.save} disabled={!currentFile || saving} style={styles.action} onPress={() => { void save(); }}>
                <Ionicons name="share-outline" size={22} color={currentFile ? theme.colors.text : theme.colors.textSecondary} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={t('imagePreview.close')} style={styles.action} onPress={onClose}>
                <Ionicons name="close" size={24} color={theme.colors.text} />
            </Pressable>
        </View>
        {saveError ? <Text testID="codelight-file-save-error" accessibilityLiveRegion="polite" style={[styles.detail, { paddingHorizontal: 14, paddingVertical: 8 }]}>{saveError === 'unavailable' ? labels.saveUnavailable : labels.saveFailed}</Text> : null}
        {currentFile ? <View style={styles.content}>
            {currentFile.mimeType.startsWith('video/') ? Platform.OS === 'web'
                ? React.createElement('video', { controls: true, autoPlay: false, preload: 'none', src: currentFile.uri, style: { width: '100%', height: '100%' } })
                : <LocalVideoPlayer uri={currentFile.uri} />
                : currentFile.mimeType.startsWith('image/') ? <Image source={{ uri: currentFile.uri }} style={{ flex: 1 }} contentFit="contain" />
                : currentFile.text !== null ? <ScrollView contentContainerStyle={styles.textContent}><Text selectable style={styles.code}>{currentFile.text}</Text></ScrollView>
                : <View style={styles.status}><Ionicons name="document-outline" size={44} color={theme.colors.textSecondary} /><Text style={styles.detail}>{labels.binary}</Text>
                    <Text style={styles.detail}>{attachmentByteLabel(currentFile.size)}</Text></View>}
        </View> : <View style={styles.status}>{failed || !scope.valid || blockedLimit ? <><Text style={styles.detail}>{blockedLimit === MAX_VIDEO_PREVIEW_BYTES ? labels.videoTooLarge : blockedLimit ? labels.tooLarge : failed ? labels.loadFailed : labels.unavailable}</Text>
            {!blockedLimit ? <Pressable testID="codelight-file-retry" accessibilityRole="button" style={styles.action} onPress={() => { if (scope.retry()) setAttempt(value => value + 1); }}><Text style={styles.detail}>{t('common.retry')}</Text></Pressable> : null}</>
            : <><ActivityIndicator /><Text style={styles.detail}>{labels.loading}</Text></>}</View>}
    </View>;
}

function LocalVideoPlayer({ uri }: { uri: string }) {
    const player = useVideoPlayer({ uri }, instance => { instance.loop = false; instance.pause(); });
    return <VideoView testID="codelight-video-player" player={player} nativeControls contentFit="contain" style={{ flex: 1 }} />;
}

const styles = StyleSheet.create(theme => ({
    container: { flex: 1, backgroundColor: theme.colors.surface }, header: { minHeight: 56, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center' },
    name: { flex: 1, color: theme.colors.text, fontSize: 16 }, action: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    content: { flex: 1 }, status: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20 }, detail: { color: theme.colors.textSecondary },
    textContent: { padding: 16 }, code: { color: theme.colors.text, fontSize: 14, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
}));
