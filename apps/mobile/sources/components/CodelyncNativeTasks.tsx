import * as React from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { Session } from '@/sync/storageTypes';
import { storage } from '@/sync/storage';
import type { NativeTaskLogPage, NativeTaskScope } from '@/sync/nativeTasks';
import { nativeTaskReader } from '@/sync/nativeTasksRpc';
import { captureCurrentNativeTaskScope, nativeTaskScopesEqual, projectCodelyncNativeTasks } from '@/utils/codelyncNativeTasks';
import { getCurrentLanguage, t } from '@/text';
import { codelyncTaskLabels, nativeTaskEventLabel, nativeTaskStatusLabel } from '@/text/codelyncTaskLabels';
import { codelyncSubagentLabels } from '@/text/codelyncSubagentLabels';
import { Typography } from '@/constants/Typography';
import { useCodelyncNativeTaskData } from '@/hooks/useCodelyncNativeTaskData';
import { CodelyncNativeTaskActions } from './CodelyncNativeTaskActions';

/** SDK tasks stay parent activity; controls require explicit per-type owner capabilities. */
export const CodelyncNativeTasks = React.memo(({ session, active = true }: { session: Session; active?: boolean }) => {
    const [expanded, setExpanded] = React.useState(false), data = useCodelyncNativeTaskData(session, expanded, active);
    const view = projectCodelyncNativeTasks(session, data.native);
    const language = getCurrentLanguage(), labels = codelyncTaskLabels[language], common = codelyncSubagentLabels[language];
    const { theme } = useUnistyles();
    React.useEffect(() => setExpanded(false), [session.id]);
    if (!view.present) return null;
    return <View testID="codelync-native-tasks" style={styles.panel}>
        <Pressable testID="codelync-native-tasks-toggle" accessibilityRole="button" accessibilityState={{ expanded }}
            style={styles.header} onPress={() => setExpanded(value => !value)}>
            <Text style={styles.heading}>{labels.title}</Text>
            {!data.failed && view.count ? <Text style={styles.detail}>{view.count}{!view.countComplete ? ' · ' + common.partial : ''}</Text>
                : data.failed || !view.countComplete ? <Text style={styles.detail}>{common.status.unknown}</Text> : null}
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.colors.textSecondary} />
        </Pressable>
        {expanded ? <TaskRows session={session} data={data} active={active} /> : null}
    </View>;
});

function TaskRows({ session, data, active }: { session: Session; data: ReturnType<typeof useCodelyncNativeTaskData>; active: boolean }) {
    const scope = captureCurrentNativeTaskScope(session);
    const [selected, setSelected] = React.useState<{ scope: NativeTaskScope; taskId: string } | null>(null);
    const language = getCurrentLanguage(), labels = codelyncTaskLabels[language], common = codelyncSubagentLabels[language];
    const { theme } = useUnistyles();
    const canLog = active && !!scope && session.metadata?.capabilities?.rpcMethods?.includes('native-task-log-read') === true;
    const view = projectCodelyncNativeTasks(session, data.native);
    const openLogs = (taskId: string) => {
        const current = storage.getState().sessions[session.id], captured = captureCurrentNativeTaskScope(current);
        if (canLog && scope && captured && nativeTaskScopesEqual(scope, captured)
            && view.rows.some(row => row.nativeTaskId === taskId)) setSelected({ scope: { ...captured }, taskId });
    };
    const currentSelection = active && selected && scope && nativeTaskScopesEqual(selected.scope, scope) ? selected : null;
    return <>
        {data.failed && !data.loading ? <View style={styles.readError}><Text style={[styles.detail, { flex: 1 }]}>{labels.unavailable}</Text>
            <Pressable testID="codelync-native-task-retry" accessibilityRole="button" accessibilityLabel={t('common.retry')} accessibilityState={{ disabled: data.loading }} style={[styles.action, data.loading && styles.actionDisabled]} disabled={data.loading} onPress={() => { if (!data.loading) data.retry(); }}><Text style={styles.link}>{t('common.retry')}</Text></Pressable></View> : null}
        <FlatList testID="codelync-native-task-list" data={view.rows} keyExtractor={row => row.nativeTaskId} style={styles.list}
            initialNumToRender={6} maxToRenderPerBatch={8} windowSize={3} nestedScrollEnabled renderItem={({ item }) => <View style={styles.row}>
                <View style={styles.identity}><Text style={styles.name} numberOfLines={2}>{item.name}</Text>
                    <Text style={styles.detail}>{labels.kinds[item.kind]}{item.isBackgrounded === true ? ' · ' + labels.background : ''}</Text></View>
                <Text testID={'codelync-native-task-status:' + item.nativeTaskId} style={styles.status}>{nativeTaskStatusLabel(language, data.failed ? 'unknown' : item.status)}</Text>
                <Pressable testID={'codelync-native-task-log:' + item.nativeTaskId} accessibilityRole="button" accessibilityLabel={`${labels.logs} · ${item.name}`}
                    accessibilityState={{ disabled: !canLog }} disabled={!canLog} style={[styles.action, !canLog && styles.actionDisabled]} onPress={() => openLogs(item.nativeTaskId)}>
                    <Ionicons name="document-text-outline" size={17} color={theme.colors.textSecondary} /></Pressable>
                <CodelyncNativeTaskActions sessionId={session.id} native={data.native} scope={scope} task={item} active={active} />
            </View>} ListEmptyComponent={data.loading ? <ActivityIndicator size="small" /> : data.failed ? null : <Text style={styles.empty}>{view.complete ? labels.empty : labels.unavailable}</Text>}
            ListFooterComponent={view.rows.length && !view.complete ? <Text style={styles.empty}>{common.partial}</Text> : null} />
        {currentSelection ? <TaskLogPanel sessionId={session.id} selection={currentSelection} onClose={() => setSelected(null)} /> : null}
    </>;
}

function TaskLogPanel({ sessionId, selection, onClose }: { sessionId: string; selection: { scope: NativeTaskScope; taskId: string }; onClose(): void }) {
    const key = JSON.stringify([sessionId, selection]), [snapshot, setSnapshot] = React.useState<{ key: string; page: NativeTaskLogPage | null; failed: boolean; failedBefore?: string | null } | null>(null);
    const [busy, setBusy] = React.useState(false), busyRef = React.useRef(false), epoch = React.useRef(0);
    const retained = React.useRef<NativeTaskLogPage | null>(null);
    const language = getCurrentLanguage(), labels = codelyncTaskLabels[language], { theme } = useUnistyles();
    const current = snapshot?.key === key ? snapshot : null;
    const load = React.useCallback(async (before: string | null = null) => {
        if (busyRef.current || before !== null && (retained.current?.logs.length ?? 0) >= 512) return;
        busyRef.current = true; setBusy(true); const captured = epoch.current;
        setSnapshot(previous => previous?.key === key ? { ...previous, failed: false } : previous);
        try {
            const page = await nativeTaskReader.logs(sessionId, selection.scope, { taskId: selection.taskId, before, limit: 12 });
            if (epoch.current !== captured) return;
            if (!page.available) throw Error('Unavailable task log');
            const previous = before ? retained.current : null;
            const logs = [...page.logs, ...(previous?.logs ?? [])].filter((row, index, rows) => rows.findIndex(other => other.id === row.id) === index);
            const capped = logs.length >= 512;
            const next = { ...page, logs: logs.slice(-512), truncated: page.truncated === true || previous?.truncated === true || logs.length > 512 || capped && page.hasMore === true,
                hasMore: capped ? false : page.hasMore, nextCursor: capped ? null : page.nextCursor };
            retained.current = next; setSnapshot({ key, page: next, failed: false });
        } catch { if (epoch.current === captured) setSnapshot(previous => ({ key, page: previous?.key === key ? previous.page : null, failed: true, failedBefore: before })); }
        finally { if (epoch.current === captured) { busyRef.current = false; setBusy(false); } }
    }, [key]);
    React.useEffect(() => { epoch.current++; busyRef.current = false; retained.current = null; void load(); return () => { epoch.current++; }; }, [key]);
    return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <View style={styles.overlay}><Pressable accessibilityRole="button" accessibilityLabel={labels.close} style={styles.backdrop} onPress={onClose} />
            <View testID="codelync-native-task-log-panel" style={styles.sheet}>
                <View style={styles.header}><Text style={styles.heading}>{labels.logs}</Text><Pressable testID="codelync-native-task-log-close" accessibilityRole="button" accessibilityLabel={labels.close} style={styles.close} onPress={onClose}><Text style={styles.link}>{labels.close}</Text></Pressable></View>
                {current?.failed && !busy ? <View style={styles.readError}><Text style={[styles.detail, { flex: 1 }]}>{labels.activityUnavailable}</Text><Pressable testID="codelync-native-task-log-retry" accessibilityRole="button" accessibilityLabel={t('common.retry')} accessibilityState={{ disabled: busy }} style={[styles.action, busy && styles.actionDisabled]} disabled={busy} onPress={() => { void load(current.failedBefore ?? null); }}><Text style={styles.link}>{t('common.retry')}</Text></Pressable></View> : null}
                {!current?.page && busy ? <View style={styles.readError}><ActivityIndicator size="small" color={theme.colors.textSecondary} /><Text style={styles.detail}>{labels.loading}</Text></View> : null}
                {current?.page ? <FlatList testID="codelync-native-task-log-list" data={current.page.logs} keyExtractor={row => row.id} initialNumToRender={8} windowSize={3} maintainVisibleContentPosition={{ minIndexForVisible: 0 }} contentContainerStyle={styles.logContent}
                    renderItem={({ item }) => <View style={styles.logRow}><Text style={styles.name}>{labels.kinds[item.kind]} · {nativeTaskStatusLabel(language, item.status)}</Text>
                        <Text style={styles.detail}>{nativeTaskEventLabel(language, item.subtype)}</Text>{item.timestamp ? <Text style={styles.detail}>{item.timestamp}</Text> : null}</View>}
                    ListEmptyComponent={<Text style={styles.empty}>{labels.emptyLogs}</Text>}
                    ListFooterComponent={<>{current.page.truncated ? <Text testID="codelync-native-task-log-truncated" style={styles.empty}>{labels.truncated}</Text> : null}
                        {current.page.hasMore && current.page.nextCursor && current.page.logs.length < 512 ? <Pressable testID="codelync-native-task-log-more" accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} style={[styles.more, busy && styles.actionDisabled]} onPress={() => { if (current.page?.nextCursor) void load(current.page.nextCursor); }}><Text style={styles.link}>{labels.more}</Text></Pressable> : null}</>} /> : null}
            </View></View>
    </Modal>;
}

const styles = StyleSheet.create(theme => ({
    panel: { backgroundColor: theme.colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    header: { minHeight: 44, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }, heading: { flex: 1, fontSize: 14, color: theme.colors.text, ...Typography.default('semiBold') },
    list: { maxHeight: 240, flexGrow: 0 }, row: { minHeight: 60, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', gap: 8, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    identity: { flex: 1, gap: 4 }, name: { fontSize: 14, color: theme.colors.text, ...Typography.default() }, detail: { fontSize: 11, color: theme.colors.textSecondary },
    status: { maxWidth: 100, flexShrink: 1, fontSize: 12, color: theme.colors.textSecondary }, action: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' }, actionDisabled: { opacity: 0.45 },
    empty: { paddingHorizontal: 14, paddingVertical: 10, fontSize: 12, color: theme.colors.textSecondary }, link: { fontSize: 13, color: theme.colors.textLink },
    overlay: { flex: 1, justifyContent: 'center', paddingHorizontal: 20, paddingTop: 48, paddingBottom: 36 }, backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.dark ? 'rgba(0,0,0,0.56)' : 'rgba(0,0,0,0.28)' },
    sheet: { maxHeight: '70%', borderRadius: 16, overflow: 'hidden', backgroundColor: theme.colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider }, close: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
    readError: { paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 8 }, logRow: { paddingHorizontal: 14, paddingVertical: 10, gap: 5, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    logContent: { paddingBottom: 14 },
    more: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center' },
}));
