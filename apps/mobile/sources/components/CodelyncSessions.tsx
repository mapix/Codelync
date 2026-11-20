import React, { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAllMachines, useAllSessions, useSocketStatus } from '@/sync/storage';
import { useIsFocused } from '@react-navigation/native';
import { buildCodelyncBrowserRows, codelyncProjectKey, isCodelyncConversation, isCodelyncNativeSession, type CodelyncBrowserRow } from '@/utils/codelyncSessionBrowser';
import { formatSessionListTimestamp } from '@/utils/sessionListTimestamp';
import { t } from '@/text';
import { navigateToSession } from '@/hooks/useNavigateToSession';
import { useCodelyncDiscoveryProgress } from '@/sync/codelyncLoadingProgress';
import { useCodelyncProjectActivities } from '@/hooks/useCodelyncProjectActivity';
import { codelyncProjectActivityStore, type CodelyncProjectDescriptor } from '@/sync/codelyncProjectActivity';
import { CodelyncProjectStatus } from './CodelyncProjectStatus';
import { CodelyncSessionStatus } from './CodelyncSessionStatus';
import { CodelyncBottomNavigation } from './CodelyncBottomNavigation';
import { Typography } from '@/constants/Typography';
import { codelyncSourceLabel } from '@/utils/codelyncSourceScope';
import { getCurrentLanguage } from '@/text';
import { codelyncSubagentKindLabels, codelyncSubagentLabels } from '@/text/codelyncSubagentLabels';
import { PeerChannelControl } from './PeerChannelControl';

type VisibleSessionToken = { id: string; nativeId: string; projectId: string };

function sameVisibleSessions(previous: VisibleSessionToken[], next: VisibleSessionToken[]): boolean {
    if (previous.length !== next.length) return false;
    for (let i = 0; i < previous.length; i++) {
        if (
            previous[i].id !== next[i].id
            || previous[i].nativeId !== next[i].nativeId
            || previous[i].projectId !== next[i].projectId
        ) {
            return false;
        }
    }
    return true;
}

export const CodelyncSessions = React.memo(function CodelyncSessions() {
    const catalog = useAllSessions(), machines = useAllMachines({ includeOffline: true }), router = useRouter(), insets = useSafeAreaInsets(), focused = useIsFocused();
    const sessions = useMemo(() => catalog.filter(isCodelyncNativeSession), [catalog]);
    const conversationCount = useMemo(() => sessions.filter(isCodelyncConversation).length, [sessions]);
    const { theme } = useUnistyles();
    const progress = useCodelyncDiscoveryProgress();
    const socketStatus = useSocketStatus().status;
    const [query, setQuery] = useState(''), [projects, setProjects] = useState(new Set<string>()), [parents, setParents] = useState(new Set<string>());
    const deferredQuery = useDeferredValue(query);
    const searching = deferredQuery.trim().length > 0;
    const rows = useMemo(() => buildCodelyncBrowserRows(sessions, deferredQuery, projects, parents), [sessions, deferredQuery, projects, parents]);
    const [visibleProjects, setVisibleProjects] = useState<string[]>([]);
    const [visibleSessions, setVisibleSessions] = useState<VisibleSessionToken[]>([]);
    const descriptors = useMemo(() => {
        if (!focused) return [];
        const byId = new Map<string, CodelyncProjectDescriptor>();
        const machineIndex = new Map(machines.map(machine => [machine.id, machine]));
        const visible = new Set(visibleProjects);
        const sessionsByProject = new Map<string, Array<{ id: string; nativeId: string }>>();
        for (const row of visibleSessions) {
            const list = sessionsByProject.get(row.projectId);
            if (list) list.push({ id: row.id, nativeId: row.nativeId });
            else sessionsByProject.set(row.projectId, [{ id: row.id, nativeId: row.nativeId }]);
        }
        // 查询只带项目身份；状态更新不会使大目录重新分组，也不会为统计下载聊天历史。
        for (const session of sessions) {
            if (!isCodelyncConversation(session)) continue;
            const metadata = session.metadata;
            const machineId = metadata?.machineId, id = codelyncProjectKey(session);
            if (!machineId || byId.has(id) || !visible.has(id)) continue;
            const machine = machineIndex.get(machineId);
            if (!machine?.active || machine.metadata?.codelync?.projectActivityVersion !== 1) continue;
            byId.set(id, { id, machineId, hostId: metadata?.bridge?.source.hostId ?? 'local', projectKey: metadata?.nativeSession?.projectKey || metadata?.path || '/',
                app: metadata?.bridge?.source.app === 'antigravity' ? 'antigravity' : metadata?.bridge?.source.app === 'claude-desktop' ? 'claude-desktop' : 'codex',
                sessions: sessionsByProject.get(id) ?? [] });
        }
        return [...byId.values()];
    }, [focused, machines, sessions, visibleProjects, visibleSessions]);
    useCodelyncProjectActivities(descriptors);
    React.useEffect(() => {
        if (!focused) return;
        const enabled = new Set(descriptors.map(project => project.id));
        const initialSyncPending = machines.length === 0 && (progress.phase === 'loading' || progress.phase === 'idle') && socketStatus !== 'error';
        const fallbackStatus = initialSyncPending ? 'refreshing' : 'unavailable';
        codelyncProjectActivityStore.mark(visibleProjects.filter(id => !enabled.has(id)), fallbackStatus);
        codelyncProjectActivityStore.markSessions(visibleSessions.filter(row => !enabled.has(row.projectId)).map(row => row.id), fallbackStatus);
    }, [focused, descriptors, visibleProjects, visibleSessions, machines.length, progress.phase, socketStatus]);
    const viewability = useRef({ itemVisiblePercentThreshold: 1, minimumViewTime: 200 }).current;
    const viewableChanged = useCallback(({ viewableItems }: { viewableItems: Array<{ item: CodelyncBrowserRow }> }) => {
        const nextSessions = viewableItems.flatMap(token => token.item.kind === 'session' && token.item.session.metadata?.bridge?.source.id
            ? [{ id: token.item.session.id, nativeId: token.item.session.metadata.bridge.source.id, projectId: token.item.projectId }] : []).slice(0, 64);
        const next = [...new Set([...viewableItems.filter(token => token.item.kind === 'project').map(token => token.item.key), ...nextSessions.map(row => row.projectId)])].slice(0, 16);
        setVisibleProjects(previous => previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next);
        setVisibleSessions(previous => sameVisibleSessions(previous, nextSessions) ? previous : nextSessions);
    }, []);
    const toggle = (value: string, previous: Set<string>) => { const next = new Set(previous); if (next.has(value)) next.delete(value); else next.add(value); return next; };
    const render = ({ item }: { item: CodelyncBrowserRow }) => item.kind === 'project' ? <Pressable testID={'codelync-project:' + item.key} accessibilityRole="button" accessibilityState={{ expanded: projects.has(item.key) || searching }} style={styles.project} onPress={() => setProjects(previous => toggle(item.key, previous))}>
        <Ionicons name={projects.has(item.key) || searching ? 'chevron-down' : 'chevron-forward'} size={17} color={theme.colors.textSecondary} />
        <View style={styles.rowBody}><Text style={styles.projectTitle} numberOfLines={2}>{item.sourceLabel} · {item.label}</Text><Text style={styles.path} numberOfLines={1}>{item.path}</Text><CodelyncProjectStatus projectId={item.key} /></View><Text style={styles.count}>{item.count}</Text>
    </Pressable> : <View style={[styles.row, item.child && styles.child]}>
        <Pressable testID={(item.session.metadata?.nativeSession?.isSubagent ? 'codelync-subagent-session:' : 'codelync-session:') + item.session.id} accessibilityRole="button" accessibilityLabel={`${item.session.metadata?.nativeSession?.isSubagent ? codelyncSubagentKindLabels[getCurrentLanguage()] + ' · ' : ''}${codelyncSourceLabel(item.session.metadata?.bridge?.source)} · ${item.title}`} style={styles.rowBody} onPress={() => navigateToSession(router, item.session.id)}>
            <Text style={styles.title} numberOfLines={2}>{item.session.metadata?.nativeSession?.isSubagent ? codelyncSubagentKindLabels[getCurrentLanguage()] + ' · ' : ''}{item.title}</Text>
            <CodelyncSessionStatus sessionId={item.session.id} />
            <Text style={styles.detail} numberOfLines={1}>{item.session.metadata?.nativeSession?.preview || item.session.metadata?.bridge?.source.id?.slice(0, 8)}</Text>
            <Text style={styles.time}>{formatSessionListTimestamp(item.at)}</Text>
        </Pressable>
        {item.children ? <Pressable testID={'codelync-branch:' + item.session.id} accessibilityRole="button" accessibilityLabel={codelyncSubagentLabels[getCurrentLanguage()]?.title ?? codelyncSubagentKindLabels[getCurrentLanguage()]} accessibilityState={{ expanded: parents.has(item.session.id) }} hitSlop={8} style={styles.branch} onPress={() => setParents(previous => toggle(item.session.id, previous))}><Ionicons name="git-branch-outline" size={18} color={theme.colors.textSecondary} /><Text style={styles.count}>{item.children}</Text></Pressable> : null}
    </View>;
    const showInitialLoading = !searching && conversationCount === 0 && (progress.phase === 'loading' || progress.phase === 'idle') && socketStatus !== 'error';
    return <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}><Text accessibilityRole="header" style={styles.heading}>{t('tabs.sessions')}</Text>{conversationCount > 0 || progress.phase === 'complete' && socketStatus === 'connected' ? <Text style={styles.count}>{conversationCount}</Text> : null}
            <View style={{ flex: 1 }} /><PeerChannelControl presentation="header" directory />
        </View>
        <View style={styles.search}><Ionicons name="search-outline" size={19} color={theme.colors.textSecondary} /><TextInput testID="codelync-session-search" accessibilityLabel={t('tools.names.search')} returnKeyType="search" style={styles.input} value={query} onChangeText={setQuery} placeholder={t('tools.names.search')} placeholderTextColor={theme.colors.textSecondary} autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" /></View>
        <FlatList data={rows} keyExtractor={row => row.key} renderItem={render} viewabilityConfig={viewability} onViewableItemsChanged={viewableChanged} keyboardShouldPersistTaps="handled" initialNumToRender={18} maxToRenderPerBatch={20} windowSize={7} contentContainerStyle={{ paddingBottom: 16 }}
            ListEmptyComponent={showInitialLoading ? <View testID="codelync-sessions-loading" style={styles.emptyLoading}><ActivityIndicator size="small" color={theme.colors.textSecondary} /><Text style={styles.emptyLoadingText}>{progress.found > 0 ? t('codelyncLoading.discovered', { count: progress.found }) : t('codelyncLoading.titles')}</Text></View> : progress.phase === 'complete' || searching ? <Text style={[styles.count, { padding: 20 }]}>{t('codelyncLoading.empty')}</Text> : null} />
        <CodelyncBottomNavigation active="sessions" />
    </View>;
});
const styles = StyleSheet.create(theme => ({
    root: { flex: 1, backgroundColor: theme.colors.groupped.background }, header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, gap: 12 },
    heading: { fontSize: 28, color: theme.colors.text, ...Typography.default('semiBold') }, count: { fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() },
    search: { marginHorizontal: 20, marginBottom: 14, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, backgroundColor: theme.colors.surface }, input: { flex: 1, height: 42, color: theme.colors.text, ...Typography.default() },
    rowBody: { flex: 1, minWidth: 0 },
    emptyLoading: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 20 },
    emptyLoadingText: { flex: 1, fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() },
    project: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider }, projectTitle: { fontSize: 17, color: theme.colors.text, ...Typography.default('semiBold') }, path: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 4, ...Typography.default() },
    row: { padding: 18, marginHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, flexDirection: 'row', alignItems: 'center', gap: 14 }, child: { marginLeft: 36 }, title: { fontSize: 16, color: theme.colors.text, ...Typography.default('semiBold') }, detail: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 5, ...Typography.default() }, time: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 6, ...Typography.default() }, branch: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', gap: 4, padding: 8 },
}));
