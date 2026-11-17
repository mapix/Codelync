import * as React from 'react';
import { ActivityIndicator, FlatList, Keyboard, Modal, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { Session } from '@/sync/storageTypes';
import { readNoninvasiveOperationLogs, subscribeNoninvasiveOperationLogs } from '@/sync/noninvasiveRpc';
import { codelyncOperationSource, projectCodelyncOperationLog, type CodelyncOperationRow } from '@/utils/codelyncOperationLog';
import { consumeCodelyncSubagentActivity, getCodelyncSubagentActivity, requestCodelyncLatestViewport, subscribeCodelyncSubagentActivity } from '@/utils/codelyncSubagentActivityIntent';
import { codelyncSourceAppName } from '@/utils/codelyncSourceScope';
import { getCurrentLanguage, t } from '@/text';
import { codelyncActivityLabels } from '@/text/codelyncActivityLabels';
import { useSessionMessages } from '@/sync/storage';
import { nativeMessageDeliveryLog } from '@/utils/nativeMessageDeliveryLog';
import { codelyncSubagentLabels } from '@/text/codelyncSubagentLabels';

/** Reads local receipts only. Messages/tools remain the selected child's existing lazy chat. */
export function CodelyncSubagentActivity({ session }: { session: Session }) {
    const source = codelyncOperationSource(session), key = JSON.stringify(source);
    const intent = React.useSyncExternalStore(subscribeCodelyncSubagentActivity, () => getCodelyncSubagentActivity(session.id));
    const [open, setOpen] = React.useState(false), [retry, setRetry] = React.useState(0);
    const [snapshot, setSnapshot] = React.useState<{ key: string; rows: CodelyncOperationRow[] | null; failed: boolean } | null>(null);
    const rows = snapshot?.key === key ? snapshot.rows : null;
    const failed = snapshot?.key === key && snapshot.failed;
    const { theme } = useUnistyles(), labels = codelyncActivityLabels[getCurrentLanguage()];
    React.useEffect(() => { setOpen(false); }, [session.id]);
    React.useEffect(() => { if (source && intent && consumeCodelyncSubagentActivity(source, intent)) { Keyboard.dismiss(); setOpen(true); } }, [key, intent]);
    React.useEffect(() => {
        if (!open || !source) return;
        let current = true, busy = false, again = false;
        setSnapshot(previous => ({ key, rows: previous?.key === key ? previous.rows : null, failed: false }));
        const load = async () => {
            if (busy) { again = true; return; }
            busy = true;
            try { const events = await readNoninvasiveOperationLogs(source.sessionId); if (current) setSnapshot({ key, rows: projectCodelyncOperationLog(events, source), failed: false }); }
            catch { if (current) setSnapshot(previous => ({ key, rows: previous?.key === key ? previous.rows : null, failed: true })); }
            finally { busy = false; if (again && current) { again = false; void load(); } }
        };
        const stop = subscribeNoninvasiveOperationLogs(source.sessionId, () => { void load(); });
        void load();
        return () => { current = false; stop(); };
    }, [open, key, retry]);
    if (!source) return null;
    return <>
        <Pressable testID="codelync-subagent-activity" accessibilityRole="button" accessibilityLabel={labels.title} style={styles.action} onPress={() => { Keyboard.dismiss(); setOpen(true); }}>
            <Ionicons name="document-text-outline" size={17} color={theme.colors.textSecondary} />
        </Pressable>
        <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
            <View style={styles.overlay}>
                <Pressable accessibilityRole="button" accessibilityLabel={labels.close} style={styles.backdrop} onPress={() => setOpen(false)} />
                <View testID="codelync-subagent-activity-panel" style={styles.sheet}>
                    <View style={styles.header}><Text style={styles.heading}>{labels.title}</Text><Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={styles.close}><Text style={styles.label}>{labels.close}</Text></Pressable></View>
                    <Text style={styles.identity} numberOfLines={1}>{codelyncSourceAppName(source.app)} · {source.nativeConversationId}</Text>
                    <Text style={styles.identity} numberOfLines={1} accessibilityLabel={`${labels.owner} ${source.ownerGeneration}`}>{labels.owner} · {source.ownerGeneration.slice(-12)}</Text>
                    <Pressable testID="codelync-subagent-message-log" accessibilityRole="button" style={styles.messageLink} onPress={() => { setOpen(false); requestCodelyncLatestViewport(source.sessionId); }}><Text style={styles.label}>{labels.messages}</Text><Ionicons name="arrow-forward" size={15} color={theme.colors.textSecondary} /></Pressable>
                    {failed ? <View style={styles.readError}><Text style={styles.label}>{labels.unavailable}</Text><Pressable testID="codelync-retry-operation-log" accessibilityRole="button" style={styles.readRetry} onPress={() => setRetry(value => value + 1)}><Text style={styles.label}>{t('common.retry')}</Text></Pressable></View> : null}
                    {rows === null ? failed ? null : <View style={styles.loading}><ActivityIndicator size="small" color={theme.colors.textSecondary} /><Text style={styles.label}>{labels.loading}</Text></View> :
                        <FlatList testID="codelync-subagent-operation-log" data={rows} keyExtractor={row => row.commandId} initialNumToRender={6} maxToRenderPerBatch={8} windowSize={3}
                            ListHeaderComponent={open ? <MessageDeliveries session={session} /> : null}
                            renderItem={({ item }) => <View style={styles.row}>
                                <Text style={styles.label}>{item.method} · {labels.status[item.status]}</Text>
                                <Text style={styles.detail} numberOfLines={1}>{item.commandId}</Text>
                                <Text style={styles.detail}>{new Date(item.at).toLocaleTimeString()}{item.historicalOwner ? ` · ${labels.previousOwner}` : ''}</Text>
                            </View>} ListEmptyComponent={<Text style={styles.empty}>{labels.empty}</Text>} />}
                </View>
            </View>
        </Modal>
    </>;
}

function MessageDeliveries({ session }: { session: Session }) {
    const { messages } = useSessionMessages(session.id), language = getCurrentLanguage(), labels = codelyncActivityLabels[language];
    const rows = React.useMemo(() => nativeMessageDeliveryLog(messages, session), [messages, session]);
    return <>{rows.map(row => <View key={row.id} testID={'codelync-message-delivery:' + row.id} style={styles.row}>
        <Text style={styles.label}>{labels.messages} · {labels.status[row.status]}</Text>
        <Text numberOfLines={1} style={styles.detail}>{row.id}</Text>
        <Text numberOfLines={1} style={styles.detail}>{labels.owner} · {row.context?.ownerGeneration ?? codelyncSubagentLabels[language].status.unknown}</Text>
    </View>)}</>;
}

const styles = StyleSheet.create(theme => ({
    action: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    overlay: { flex: 1, justifyContent: 'center', paddingHorizontal: 20 }, backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.25)' },
    sheet: { maxHeight: '70%', borderRadius: 16, overflow: 'hidden', backgroundColor: theme.colors.surface },
    header: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider }, heading: { flex: 1, fontSize: 17, color: theme.colors.text }, close: { padding: 16 },
    identity: { paddingHorizontal: 16, paddingTop: 8, fontSize: 11, color: theme.colors.textSecondary }, label: { fontSize: 13, color: theme.colors.text }, detail: { fontSize: 11, color: theme.colors.textSecondary },
    messageLink: { minHeight: 44, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }, row: { gap: 5, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    empty: { padding: 16, fontSize: 12, color: theme.colors.textSecondary }, loading: { padding: 16, flexDirection: 'row', gap: 8, alignItems: 'center' },
    readError: { paddingHorizontal: 16, paddingTop: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }, readRetry: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
}));
