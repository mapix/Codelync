import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useCodelyncMessageProgress } from '@/sync/codelyncLoadingProgress';
import { sync } from '@/sync/sync';
import { t } from '@/text';
export function CodelyncSessionLoading({ sessionId, initial, older, topInset = 0 }: { sessionId: string; initial: boolean; older: boolean; topInset?: number }) {
    const { theme } = useUnistyles(); const progress = useCodelyncMessageProgress(sessionId);
    // Initial/explicit older reads own this overlay; socket recovery never mounts it.
    const failed = progress.phase === 'error';
    if (!initial && !older) return null;
    return <View testID="codelync-session-loading" accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, paddingVertical: 12, paddingTop: initial ? topInset + 12 : 12,
        ...(!initial ? { position: 'absolute', top: topInset + 4, left: 12, right: 12, zIndex: 10, borderRadius: 12 } as const : {}),
        flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: theme.colors.groupped.background }}>
        {!failed ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : null}
        <Text style={{ flex: 1, color: theme.colors.textSecondary }}>{t(failed ? 'codelyncLoading.failed' : older ? 'codelyncLoading.older' : 'codelyncLoading.messages')}</Text>
        {failed ? <Pressable onPress={() => sync.onSessionVisible(sessionId)} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: theme.colors.text }}>{t('common.retry')}</Text></Pressable> : null}
    </View>;
}
