import * as React from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { getCurrentLanguage, t } from '@/text';
import type { Session } from '@/sync/storageTypes';
import { useSessionMessages } from '@/sync/storage';
import { loadSessionDrafts } from '@/sync/persistence';
import { nativeSessionAvailabilityLabels } from '@/text/nativeSessionAvailabilityLabels';
import { codelyncSourceAppName } from '@/utils/codelyncSourceScope';

/** Local retained content only. No session owner or native controls are manufactured. */
export function NativeSessionUnavailable({ sessionId, known, loading, topInset = 0, onRetry, onBack }: {
    sessionId: string; known: Session | null; loading: boolean; topInset?: number; onRetry: () => Promise<void>; onBack: () => void;
}) {
    const { theme } = useUnistyles(), labels = nativeSessionAvailabilityLabels[getCurrentLanguage()];
    const { messages } = useSessionMessages(sessionId);
    const draft = known?.draft ?? loadSessionDrafts()[sessionId] ?? '';
    const [busy, setBusy] = React.useState(false), [failed, setFailed] = React.useState(false);
    const flight = React.useRef<Promise<void> | null>(null);
    const rows = React.useMemo(() => {
        const result: Array<{ id: string; text: string }> = [];
        for (const message of messages) {
            if (message.kind === 'agent-text' && message.isThinking) continue;
            if (message.kind === 'user-text' || message.kind === 'agent-text') result.push({ id: message.id, text: message.text });
            else if (message.kind === 'tool-call') result.push({ id: message.id, text: message.tool.name });
            if (result.length === 12) break;
        }
        return result;
    }, [messages]);
    const source = known?.metadata?.bridge?.source;
    const retryDisabled = loading || busy;
    return <View testID="codelync-session-unavailable" style={{ flex: 1, paddingHorizontal: 20, paddingTop: topInset + 20, paddingBottom: 20, gap: 12, backgroundColor: theme.colors.groupped?.background ?? theme.colors.surface }}>
        <Text style={{ color: theme.colors.text, fontSize: 20 }}>{labels.title}</Text>
        {source ? <Text style={{ color: theme.colors.textSecondary }} numberOfLines={2}>{codelyncSourceAppName(source.app)} · {known?.metadata?.nativeSession?.title || source.id}</Text> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {retryDisabled ? <ActivityIndicator color={theme.colors.textSecondary} /> : null}
            <Text accessibilityLiveRegion="polite" style={{ flex: 1, color: theme.colors.textSecondary }}>{retryDisabled ? labels.loading : failed ? labels.refreshFailed : labels.unavailable}</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <Pressable testID="codelync-unavailable-retry" accessibilityRole="button" accessibilityLabel={t('common.retry')} accessibilityState={{ disabled: retryDisabled, busy: retryDisabled }}
                disabled={retryDisabled} style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center', opacity: retryDisabled ? 0.45 : 1 }} onPress={() => {
                if (flight.current || loading) return;
                setBusy(true); setFailed(false);
                flight.current = Promise.resolve().then(onRetry).catch(() => { setFailed(true); }).finally(() => { flight.current = null; setBusy(false); });
            }}><Text style={{ color: theme.colors.textLink ?? theme.colors.text, fontWeight: '600' }}>{t('common.retry')}</Text></Pressable>
            <Pressable testID="codelync-unavailable-back" accessibilityRole="button" accessibilityLabel={labels.back}
                style={{ minHeight: 44, minWidth: 44, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center' }} onPress={onBack}>
                <Text style={{ color: theme.colors.text }}>{labels.back}</Text>
            </Pressable>
        </View>
        {draft ? <View><Text style={{ color: theme.colors.textSecondary }}>{labels.draft}</Text><Text selectable style={{ color: theme.colors.text }} numberOfLines={6}>{draft}</Text></View> : null}
        {rows.length ? <FlatList data={rows} keyExtractor={row => row.id} contentContainerStyle={{ paddingBottom: 24 }} ListHeaderComponent={<Text style={{ color: theme.colors.textSecondary }}>{labels.saved}</Text>}
            renderItem={({ item }) => <Text selectable style={{ color: theme.colors.text, paddingVertical: 8 }} numberOfLines={8}>{item.text}</Text>} /> : null}
    </View>;
}
