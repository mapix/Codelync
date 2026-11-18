import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useCodelyncConnectionState } from '@/hooks/useCodelyncConnectionState';
import { getConnectionSnapshot, retryCodelyncConnection, selectConnection, type ConnectionSnapshot } from '@/sync/codelyncConnection';
import type { CodelyncConnectionState } from '@/utils/codelyncConnectionState';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { PeerChannelControlView } from './PeerChannelControlView';

export function CodelyncConnectionNotice({ topInset = 0, showPicker = true }: { topInset?: number; showPicker?: boolean }) {
    const { state, snapshot } = useCodelyncConnectionState(), router = useRouter();
    return <CodelyncConnectionNoticeView state={state} snapshot={snapshot} topInset={topInset} showPicker={showPicker}
        onRetry={() => {
            if (getConnectionSnapshot().peerId !== snapshot.peerId) return Promise.reject(Error('The saved Mac changed'));
            return retryCodelyncConnection();
        }} onSelect={selectConnection} onScan={() => router.push('/pair')} />;
}

export function CodelyncConnectionNoticeView({ state, snapshot, onRetry, onSelect, onScan, topInset = 0, showPicker = true }: {
    state: CodelyncConnectionState;
    snapshot: ConnectionSnapshot;
    onRetry: () => Promise<void>;
    onSelect: (id: string) => Promise<void>;
    onScan: () => void;
    topInset?: number;
    showPicker?: boolean;
}) {
    const { theme } = useUnistyles();
    const [retrying, setRetrying] = React.useState(false), [failed, setFailed] = React.useState(false);
    const busy = React.useRef(false), generation = React.useRef(0);
    React.useEffect(() => {
        generation.current++; busy.current = false; setRetrying(false); setFailed(false);
        return () => { generation.current++; };
    }, [snapshot.peerId, snapshot.selectedId, snapshot.automatic]);
    React.useEffect(() => { if (state.kind === 'connected') setFailed(false); }, [state.kind]);
    const retry = async () => {
        if (busy.current || state.busy || !state.canRetry) return;
        const current = generation.current;
        busy.current = true; setRetrying(true); setFailed(false);
        try { await onRetry(); }
        catch { if (current === generation.current) setFailed(true); }
        finally { if (current === generation.current) { busy.current = false; setRetrying(false); } }
    };
    if (state.kind === 'hidden' || state.kind === 'connected') return null;
    const connecting = !failed && state.kind === 'connecting';
    const ended = state.kind === 'access-ended';
    const retryDisabled = retrying || state.busy;
    return <View testID="codelync-mac-connection-notice" style={[styles.root, { paddingTop: topInset + 12 }]}>
        <View style={styles.heading}>
            {connecting ? <ActivityIndicator testID="codelync-mac-connecting" size="small" color={theme.colors.textSecondary} /> : null}
            <Text accessibilityLiveRegion="polite" style={styles.title}>{t(ended ? 'codelyncChannels.accessEndedTitle'
                : connecting ? 'codelyncChannels.connectingTitle' : 'codelyncChannels.failedTitle')}</Text>
        </View>
        {!connecting ? <Text style={styles.help}>{t(ended ? 'codelyncChannels.accessEndedHelp' : 'codelyncChannels.failedHelp')}</Text> : null}
        <View style={styles.actions}>
            {state.canRetry ? <Pressable testID="codelync-retry-mac-connection" accessibilityRole="button"
                accessibilityState={{ disabled: retryDisabled, busy: retrying }} disabled={retryDisabled}
                style={[styles.action, { opacity: retryDisabled ? 0.45 : 1 }]} onPress={() => void retry()}>
                <Text style={styles.actionText}>{t(retrying ? 'codelyncChannels.switching' : 'codelyncChannels.retryConnection')}</Text>
            </Pressable> : null}
            {state.canInspect && showPicker ? <PeerChannelControlView snapshot={snapshot} onSelect={onSelect} /> : null}
            {ended || !state.canInspect ? <Pressable testID="codelync-scan-current-mac" accessibilityRole="button"
                accessibilityLabel={t('codelyncChannels.scanMac')} style={styles.action} onPress={onScan}>
                <Text style={styles.actionText}>{t('codelyncChannels.scanMac')}</Text>
            </Pressable> : null}
        </View>
    </View>;
}

const styles = StyleSheet.create(theme => ({
    root: {
        paddingHorizontal: 20,
        paddingBottom: 12,
        gap: 8,
        backgroundColor: theme.colors.groupped.background,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
        zIndex: 1,
    },
    heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { flex: 1, minWidth: 0, color: theme.colors.text, ...Typography.default('semiBold') },
    help: { color: theme.colors.textSecondary, ...Typography.default() },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
    action: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 12 },
    actionText: { flexShrink: 1, color: theme.colors.text, ...Typography.default('semiBold') },
}));
