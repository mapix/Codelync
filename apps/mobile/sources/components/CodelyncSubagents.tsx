import * as React from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { storage, useAllSessions } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { useCodelyncSubagents } from '@/hooks/useCodelyncSubagents';
import { navigateToObservedSession, navigateToSession } from '@/hooks/useNavigateToSession';
import { codelyncSubagentParent, filterCodelyncSubagents, projectCodelyncSubagents, type CodelyncSubagentFilter, type CodelyncSubagentRow, type CodelyncSubagentView } from '@/utils/codelyncSubagents';
import { codelyncSourceAppName } from '@/utils/codelyncSourceScope';
import { getCurrentLanguage, t } from '@/text';
import { codelyncSubagentInteractionLabels, codelyncSubagentLabels } from '@/text/codelyncSubagentLabels';
import { Typography } from '@/constants/Typography';
import type { SupportedLanguage } from '@/text/_all';
import { CodelyncSubagentActivity } from './CodelyncSubagentActivity';
import { codelyncActivityLabels } from '@/text/codelyncActivityLabels';
import { requestCodelyncSubagentActivity } from '@/utils/codelyncSubagentActivityIntent';
import { CodelyncNativeTasks } from './CodelyncNativeTasks';
import { currentNativeTasksSnapshot } from '@/sync/nativeTaskStore';

/** Small selected-parent projection. Expanding mounts only a catalog subscription. */
export const CodelyncSubagents = React.memo(({ session, active = true }: { session: Session | null; active?: boolean }) => {
    const [expanded, setExpanded] = React.useState(false);
    const view = useCodelyncSubagents(session, undefined, expanded, active);
    React.useEffect(() => { setExpanded(false); }, [session?.id]);
    const labels = codelyncSubagentLabels[getCurrentLanguage()];
    const count = view.failed ? null : view.count ?? null, countComplete = !view.failed && view.countComplete;
    const { theme } = useUnistyles();
    if (!view.present || !session) return null;
    return <><CodelyncNativeTasks session={session} active={active} /><View testID="codelync-subagents" style={styles.panel}>
        {session.metadata?.nativeSession?.parentId ? <SubagentParent session={session} /> : null}
        <View style={styles.header}><Pressable testID="codelync-subagents-toggle" accessibilityRole="button" accessibilityState={{ expanded }}
            onPress={() => setExpanded(value => !value)} style={styles.toggle}>
            <Text style={styles.heading}>{labels.title}</Text>
            {count ? <Text style={styles.detail} accessibilityLabel={`${count}${!countComplete ? ' · ' + labels.partial : ''}`}>{count}{!expanded && !countComplete ? ' · ' + labels.partial : ''}</Text> :
                !countComplete ? <Text style={styles.detail}>{labels.status.unknown}</Text> : null}
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.colors.textSecondary} />
        </Pressable><CodelyncSubagentActivity session={session} /></View>
        {expanded ? <SubagentRows key={session.id} session={session} active={active} onRetry={view.retry} /> : null}
    </View></>;
});

function SubagentRows({ session, active, onRetry }: { session: Session; active: boolean; onRetry: () => void }) {
    const catalog = useAllSessions(), router = useRouter();
    const view = useCodelyncSubagents(session, catalog, false, active);
    const onSelect = React.useCallback((id: string, expectedNativeId: string, openLogs = false) => {
        // Re-read both identities at tap time; a stale catalog match cannot route elsewhere.
        const state = storage.getState(), parent = state.sessions[session.id];
        const row = parent && projectCodelyncSubagents(parent, Object.values(state.sessions), undefined,
            parent.metadata?.bridge?.source.app === 'claude-desktop' ? currentNativeTasksSnapshot(parent) : undefined).rows.find(row => row.id === id);
        if (row?.targetSessionId && row.nativeConversationId === expectedNativeId) {
            if (openLogs && state.sessions[row.targetSessionId]) requestCodelyncSubagentActivity(state.sessions[row.targetSessionId]);
            navigateToObservedSession(router, row.targetSessionId);
        }
    }, [session.id, router]);
    return <CodelyncSubagentRowsView view={view} onSelect={onSelect} onRetry={onRetry} />;
}

function SubagentParent({ session }: { session: Session }) {
    const catalog = useAllSessions(), router = useRouter(), labels = codelyncSubagentInteractionLabels[getCurrentLanguage()];
    const parent = React.useMemo(() => codelyncSubagentParent(session, catalog, currentNativeTasksSnapshot), [session, catalog]);
    const { theme } = useUnistyles();
    if (!parent) return null;
    const title = parent.metadata?.nativeSession?.title || parent.id.slice(0, 8);
    return <Pressable accessible testID="codelync-subagent-parent" accessibilityRole="button"
        accessibilityLabel={`${labels.parent} · ${codelyncSourceAppName(parent.metadata?.bridge?.source.app)} · ${title}`} style={styles.parent} onPress={() => {
        const state = storage.getState(), current = state.sessions[session.id];
        const target = current && codelyncSubagentParent(current, Object.values(state.sessions), currentNativeTasksSnapshot);
        if (target?.id === parent.id) navigateToSession(router, target.id);
    }}>
        <Ionicons name="arrow-back" size={15} color={theme.colors.textSecondary} />
        <Text numberOfLines={2} style={styles.parentLabel}>{labels.parent} · {title}</Text>
    </Pressable>;
}

export function CodelyncSubagentRowsView({ view, onSelect, onRetry }: { view: CodelyncSubagentView; onSelect: (id: string, nativeConversationId: string, openLogs?: boolean) => void; onRetry?: () => void }) {
    const language = getCurrentLanguage(), labels = codelyncSubagentLabels[language], interactions = codelyncSubagentInteractionLabels[language];
    const [filter, setFilter] = React.useState<CodelyncSubagentFilter>('all');
    const rows = React.useMemo(() => filterCodelyncSubagents(view.failed ? view.rows.map(row => ({ ...row, status: 'unknown' as const })) : view.rows, filter), [view.rows, filter, view.failed]);
    const render = React.useCallback(({ item }: { item: CodelyncSubagentRow }) => <SubagentRow row={item} onSelect={onSelect} language={language} />, [onSelect, language]);
    return <>
        {view.failed && !view.loading ? <View style={styles.row}><Text style={styles.detail}>{labels.unavailable}</Text>{onRetry ? <Pressable testID="codelync-subagents-read-retry" accessibilityRole="button" accessibilityLabel={t('common.retry')} accessibilityState={{ disabled: view.loading }} style={[styles.logAction, view.loading && styles.actionDisabled]} disabled={view.loading} onPress={() => { if (!view.loading) onRetry(); }}><Text style={styles.filterLabel}>{t('common.retry')}</Text></Pressable> : null}</View> : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters} contentContainerStyle={styles.filterContent}>
            {(['all', 'in-progress', 'finished', 'unknown'] as const).map(key => <Pressable key={key} testID={'codelync-subagents-filter:' + key}
                accessibilityRole="button" accessibilityState={{ selected: filter === key }} onPress={() => setFilter(key)} style={[styles.filter, filter === key && styles.filterSelected]}>
                <Text style={styles.filterLabel}>{interactions.filters[key]}</Text>
            </Pressable>)}
        </ScrollView>
        <FlatList testID="codelync-subagents-list" data={rows} renderItem={render} keyExtractor={row => row.id} style={styles.list}
            contentContainerStyle={styles.listContent} nestedScrollEnabled initialNumToRender={8} maxToRenderPerBatch={12} windowSize={3}
            ListEmptyComponent={view.loading ? <ActivityIndicator size="small" /> : view.failed ? null : <Text style={styles.empty}>{view.rows.length ? interactions.noMatches : view.available && view.complete ? labels.empty : labels.unavailable}</Text>}
            ListFooterComponent={!view.complete && view.rows.length ? <Text style={styles.empty}>{labels.partial}</Text> : null} />
    </>;
}

const SubagentRow = React.memo(({ row, onSelect, language }: { row: CodelyncSubagentRow; onSelect: (id: string, nativeConversationId: string, openLogs?: boolean) => void; language: SupportedLanguage }) => {
    const { theme } = useUnistyles(), labels = codelyncSubagentLabels[language];
    const indent = Math.min(24, Math.max(0, (row.depth ?? 1) - 1) * 8);
    return <View style={[styles.row, indent ? { paddingLeft: 14 + indent } : undefined]}><Pressable accessible testID={'codelync-subagent:' + row.id} accessibilityRole={row.targetSessionId ? 'button' : 'text'}
            disabled={!row.targetSessionId} accessibilityState={{ disabled: !row.targetSessionId }}
            accessibilityLabel={`${row.name}, ${codelyncSourceAppName(row.app)}, ${labels.status[row.status]}, ${row.nativeConversationId}`}
            onPress={() => { if (row.targetSessionId) onSelect(row.id, row.nativeConversationId); }} style={styles.rowMain}>
            <View style={styles.identity}>
                <Text style={styles.name} numberOfLines={2}>{row.name}</Text>
                <Text style={styles.detail} numberOfLines={1}>{codelyncSourceAppName(row.app)} · {row.nativeConversationId}</Text>
            </View>
            {row.status === 'running' ? <ActivityIndicator size="small" color={theme.colors.textSecondary} /> : null}
            <Text testID={'codelync-subagent-status:' + row.id} numberOfLines={2} style={[styles.status, row.status === 'failed' && { color: theme.colors.textDestructive }, row.status === 'waiting' && { color: theme.colors.textLink }]}>{labels.status[row.status]}</Text>
            {row.targetSessionId ? <Ionicons name="chevron-forward" size={13} color={theme.colors.textSecondary} /> : null}
        </Pressable>
        <Pressable testID={'codelync-subagent-log:' + row.id} accessibilityRole="button" disabled={!row.targetSessionId} accessibilityState={{ disabled: !row.targetSessionId }}
            accessibilityLabel={`${codelyncActivityLabels[language].title} · ${row.name}`} style={[styles.logAction, !row.targetSessionId && styles.actionDisabled]} onPress={() => { if (row.targetSessionId) onSelect(row.id, row.nativeConversationId, true); }}>
            <Ionicons name="document-text-outline" size={17} color={theme.colors.textSecondary} />
        </Pressable></View>;
}, (a, b) => a.onSelect === b.onSelect && a.language === b.language && a.row.id === b.row.id && a.row.name === b.row.name && a.row.status === b.row.status
    && a.row.app === b.row.app && a.row.nativeConversationId === b.row.nativeConversationId && a.row.targetSessionId === b.row.targetSessionId
    && a.row.nativeParentConversationId === b.row.nativeParentConversationId && a.row.depth === b.row.depth
    && a.row.ownerGeneration === b.row.ownerGeneration && a.row.hostId === b.row.hostId && a.row.nativeCollection === b.row.nativeCollection
    && a.row.parentHostId === b.row.parentHostId && a.row.parentOwnerGeneration === b.row.parentOwnerGeneration && a.row.runtimeGeneration === b.row.runtimeGeneration);

const styles = StyleSheet.create(theme => ({
    panel: { backgroundColor: theme.colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    header: { minHeight: 44, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
    toggle: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 },
    heading: { flex: 1, fontSize: 14, color: theme.colors.text, ...Typography.default('semiBold') },
    parent: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 8 }, parentLabel: { flex: 1, fontSize: 13, color: theme.colors.textSecondary },
    filters: { flexGrow: 0 }, filterContent: { paddingHorizontal: 10, paddingBottom: 8, gap: 6 },
    filter: { minHeight: 44, paddingHorizontal: 12, borderRadius: 14, justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    filterSelected: { backgroundColor: theme.colors.groupped.background }, filterLabel: { fontSize: 12, color: theme.colors.text },
    list: { maxHeight: 240, flexGrow: 0 }, listContent: { flexGrow: 0, paddingBottom: 8 },
    row: { minHeight: 60, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    rowMain: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 }, logAction: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }, actionDisabled: { opacity: 0.45 },
    identity: { flex: 1, minWidth: 0, gap: 4 }, name: { fontSize: 14, color: theme.colors.text, ...Typography.default() },
    detail: { fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }, status: { maxWidth: 100, flexShrink: 1, fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() },
    empty: { paddingHorizontal: 14, paddingVertical: 10, color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() },
}));
