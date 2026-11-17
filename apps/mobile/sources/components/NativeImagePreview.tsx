import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AttachmentImagePreview } from './AttachmentImagePreview';
import { loadNativeImageAttachment, type NativeImageAttachment } from '@/sync/nativeImage';
import { t } from '@/text';

type Props = { sessionId: string; imageId: string; name: string; onClose?: () => void };
export function NativeImagePreview({ sessionId, imageId, name, onClose }: Props) {
    const { theme } = useUnistyles(), insets = useSafeAreaInsets(), screen = useWindowDimensions();
    const [attempt, setAttempt] = React.useState(0);
    const [attachment, setAttachment] = React.useState<NativeImageAttachment | null>(null);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => {
        let cancelled = false;
        setAttachment(null); setFailed(false);
        loadNativeImageAttachment(sessionId, imageId).then(value => { if (!cancelled) setAttachment(value); }).catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
    }, [sessionId, imageId, attempt]);
    if (attachment) return <AttachmentImagePreview sessionId={sessionId} refValue={attachment.ref} name={attachment.name} width={attachment.image?.width} height={attachment.image?.height} onClose={onClose} />;
    return <View testID="codelync-native-image-loading" style={[styles.container, { width: screen.width, height: screen.height, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.header}><Text style={styles.name} numberOfLines={1}>{name}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('imagePreview.close')} onPress={onClose} style={styles.button}><Ionicons name="close" size={24} color={theme.colors.text} /></Pressable></View>
        <View style={styles.status}>{failed ? <><Text style={styles.text}>{t('imagePreview.loadFailed')}</Text><Pressable testID="codelync-native-image-retry" accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={styles.button}><Text style={styles.text}>{t('common.retry')}</Text></Pressable></> : <><ActivityIndicator /><Text style={styles.text}>{t('common.loading')}</Text></>}</View>
    </View>;
}
const styles = StyleSheet.create(theme => ({
    container: { flex: 1, backgroundColor: theme.colors.groupped.background },
    header: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
    name: { flex: 1, color: theme.colors.text, fontSize: 16 },
    status: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
    button: { padding: 12 }, text: { color: theme.colors.textSecondary, fontSize: 15 },
}));
