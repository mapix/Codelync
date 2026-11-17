/** Metadata-only attachment cards. Bytes are loaded only by the opened preview. */
import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { z } from 'zod';
import { Modal } from '@/modal';
import { t, getCurrentLanguage } from '@/text';
import { thumbhashToDataUri } from '@/utils/thumbhash';
import { NativeImagePreview } from '@/components/NativeImagePreview';
import { AttachmentFilePreview } from '@/components/AttachmentFilePreview';
import { attachmentMediaKind, attachmentByteLabel, MAX_VIDEO_PREVIEW_BYTES } from '@/utils/attachmentMedia';
import { codelyncMediaLabels } from '@/text/codelyncMediaLabels';

const fileInputSchema = z.object({
    ref: z.string().min(1).optional(), name: z.string(), size: z.number().nonnegative().optional(), mimeType: z.string().max(128).optional(),
    image: z.object({ width: z.number(), height: z.number(), thumbhash: z.string().optional() }).optional(),
});

export const FileView = React.memo<ToolViewProps>(props => {
    const marker = z.object({ nativeImageId: z.string().min(1), name: z.string() }).safeParse(props.tool.input);
    if (marker.success) return <NativeImagePlaceholder sessionId={props.sessionId} imageId={marker.data.nativeImageId} name={marker.data.name} />;
    return <AttachmentFileView {...props} />;
});

function NativeImagePlaceholder({ sessionId, imageId, name }: { sessionId?: string; imageId: string; name: string }) {
    const { theme } = useUnistyles();
    return <View style={styles.container}>
        <Pressable testID={`codelync-native-image-${imageId}`} accessibilityRole="button" accessibilityLabel={t('imagePreview.open')} disabled={!sessionId}
            onPress={() => { if (sessionId) Modal.show({ component: NativeImagePreview, props: { sessionId, imageId, name } }); }}
            style={styles.media}>
            <Ionicons name="image-outline" size={32} color={theme.colors.textSecondary} />
            <Text style={styles.detail}>{t('imagePreview.open')}</Text>
        </Pressable>
        <Text style={styles.name} numberOfLines={1}>{name}</Text>
    </View>;
}

function AttachmentFileView({ tool, sessionId }: ToolViewProps) {
    const { theme } = useUnistyles(), labels = codelyncMediaLabels[getCurrentLanguage()];
    const opening = React.useRef(false);
    const parsed = fileInputSchema.safeParse(tool.input);
    if (!parsed.success) return null;
    const { name, size, image, ref, mimeType } = parsed.data;
    const metadata = { name, size, image, mimeType }, kind = attachmentMediaKind(metadata);
    const oversizedVideo = kind === 'video' && size !== undefined && size > MAX_VIDEO_PREVIEW_BYTES;
    const readable = !!sessionId && !!ref && !oversizedVideo;
    const thumbnail = image?.thumbhash ? thumbhashToDataUri(image.thumbhash) : undefined;
    const open = () => {
        if (!readable || !sessionId || !ref || opening.current) return;
        opening.current = true;
        try { Modal.show({ component: AttachmentFilePreview, props: { sessionId, refValue: ref, metadata, image: kind === 'image', onClosed: () => { opening.current = false; } } }); }
        catch { opening.current = false; }
    };
    return <View style={styles.container}>
        <Pressable testID={`codelync-attachment-${ref ?? 'unavailable'}`} accessibilityRole="button" accessibilityLabel={`${oversizedVideo ? labels.videoTooLarge : labels.open} · ${name}`}
            accessibilityState={{ disabled: !readable }} disabled={!readable} onPress={open} style={kind === 'file' ? styles.file : styles.media}>
            {kind === 'image' && thumbnail ? <Image source={{ uri: thumbnail }} style={styles.thumbnail} contentFit="cover" /> : null}
            <Ionicons name={kind === 'video' ? 'play-circle-outline' : kind === 'image' ? 'image-outline' : 'document-text-outline'}
                size={kind === 'file' ? 24 : 44} color={theme.colors.textSecondary} />
            {kind === 'file' ? <View style={styles.identity}><Text style={styles.name} numberOfLines={1}>{name}</Text>
                {attachmentByteLabel(size) ? <Text style={styles.detail}>{attachmentByteLabel(size)}</Text> : null}</View> : null}
        </Pressable>
        {kind !== 'file' ? <View style={styles.caption}><Text style={[styles.name, { flex: 1 }]} numberOfLines={1}>{name}</Text>
            {attachmentByteLabel(size) ? <Text style={styles.detail}>{attachmentByteLabel(size)}</Text> : null}</View> : null}
        {oversizedVideo ? <Text style={styles.detail}>{labels.videoTooLarge}</Text> : !readable ? <Text style={styles.detail}>{labels.unavailable}</Text> : null}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    container: { paddingHorizontal: 12, paddingVertical: 8, gap: 6 },
    media: { width: 280, maxWidth: '100%', aspectRatio: 16 / 9, borderRadius: 8, backgroundColor: theme.colors.surfaceHigh,
        overflow: 'hidden', gap: 10, alignItems: 'center', justifyContent: 'center' },
    file: { minHeight: 60, maxWidth: 300, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 8,
        borderRadius: 8, backgroundColor: theme.colors.surfaceHigh }, identity: { flex: 1, gap: 4 },
    caption: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 280 }, name: { fontSize: 13, color: theme.colors.text },
    detail: { color: theme.colors.textSecondary, fontSize: 12 }, thumbnail: { ...StyleSheet.absoluteFillObject },
}));
