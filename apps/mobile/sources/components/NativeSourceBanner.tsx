import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import { Typography } from '@/constants/Typography';
import { getCurrentLanguage, t } from '@/text';
import { useCodelyncSelectionState } from '@/sync/codelyncSessionSelection';
import { useCodelyncMessageProgress } from '@/sync/codelyncLoadingProgress';
import { sync } from '@/sync/sync';
import { nativeParentControl } from '@/utils/nativeParentControl';
import { NativeParentControl } from './NativeParentControl';
import { codelyncSavedHistory } from '@/utils/nativeSavedHistory';
import { NativeSavedHistoryBanner } from './NativeSavedHistoryBanner';
import { nativeSessionAvailabilityLabels } from '@/text/nativeSessionAvailabilityLabels';
import { nativeReadRecoveryLabels } from '@/text/nativeReadRecoveryLabels';
import { nativeSessionReadNotice } from '@/utils/nativeSessionReadNotice';

export function NativeSourceBanner({ sessionId, topInset = 0 }: { sessionId: string; topInset?: number }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId), state = useCodelyncSelectionState(sessionId);
    const progress = useCodelyncMessageProgress(sessionId);
    const sourceStatus = session?.metadata?.bridge?.sourceStatus;
    const notice = nativeSessionReadNotice(session, progress, state);
    const sourceUnavailable = notice === 'source-unavailable';
    const [retrying, setRetrying] = React.useState(false), retryFlight = React.useRef<symbol | null>(null);
    const currentSession = React.useRef(sessionId); currentSession.current = sessionId;
    React.useEffect(() => { retryFlight.current = null; setRetrying(false); }, [sessionId]);
    const labels = nativeSessionAvailabilityLabels[getCurrentLanguage()];
    // 缓存的 disconnected 不是这次读取失败；新鲜验证期间只展示同步，错误必须来自当前尝试。
    const failed = !retrying && (notice === 'source-unavailable' || notice === 'read-failed');
    const loading = retrying || !failed && notice === 'checking';
    const retry = () => {
        if (retryFlight.current || currentSession.current !== sessionId) return;
        const flight = Symbol('message-read'); retryFlight.current = flight; setRetrying(true);
        let read: unknown;
        try { read = sync.retryCodelyncSession(sessionId); } catch { /* The current read remains actionable. */ }
        return Promise.resolve(read).catch(() => {}).finally(() => { if (retryFlight.current === flight) { retryFlight.current = null; if (currentSession.current === sessionId) setRetrying(false); } });
    };
    const failureText = sourceUnavailable ? sourceStatus === 'locked' ? labels.locked : sourceStatus === 'permission-required' ? labels.permissionRequired : labels.sourceUnavailable
        : labels.readFailed;
    if (session && codelyncSavedHistory(session)) return <NativeSavedHistoryBanner session={session} topInset={topInset} />;
    if (session && nativeParentControl(session)) return <NativeParentControl sessionId={sessionId} topInset={topInset} />;
    if (!notice) return null;
    if (progress.revalidating || progress.revalidationFailed) {
        const cachedLabels = nativeReadRecoveryLabels[getCurrentLanguage()];
        return <View testID="codelync-cached-session-check" style={{ padding: 14, paddingTop: topInset + 14, gap: 8, backgroundColor: theme.colors.groupped.background }}>
            <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{progress.revalidating ? cachedLabels.checking : cachedLabels.failed}</Text>
            {progress.revalidationFailed ? <Pressable accessibilityRole="button" testID="codelync-retry-session-sync" onPress={() => { void retry(); }} style={{ minHeight: 44, justifyContent: 'center' }}>
                <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>{t('common.retry')}</Text>
            </Pressable> : null}
        </View>;
    }
    // The fresh HTTP read confirms messages independently of desktop navigation.
    if (progress.phase === 'complete' && sourceStatus === 'connected') return null;
    // 预加载也会挂载 banner；不能在 mount 时额外切换桌面，点击导航是唯一发起者。
    return <View testID="codelync-auto-session-sync" style={{ padding: 14, paddingTop: topInset + 14, gap: 8, backgroundColor: theme.colors.groupped.background }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {loading ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : null}
            <Text accessibilityLiveRegion="polite" style={{ flex: 1, color: theme.colors.textSecondary, ...Typography.default() }}>{failed ? failureText : t('codelyncLoading.messages')}</Text>
        </View>
        {failed ? <Pressable accessibilityRole="button" onPress={() => { void retry(); }} testID="codelync-retry-session-sync" style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: theme.colors.text, ...Typography.default('semiBold') }}>{t('common.retry')}</Text>
        </Pressable> : null}
    </View>;
}
