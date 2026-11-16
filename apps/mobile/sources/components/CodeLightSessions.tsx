import React, { useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAllMachines, useAllSessions, useSocketStatus } from '@/sync/storage';
import { useIsFocused } from '@react-navigation/native';
import { buildCodeLightBrowserRows, codeLightProjectKey, isCodeLightConversation, isCodeLightNativeSession, type CodeLightBrowserRow } from '@/utils/codeLightSessionBrowser';
import { formatSessionListTimestamp } from '@/utils/sessionListTimestamp';
import { t } from '@/text';
import { navigateToSession } from '@/hooks/useNavigateToSession';
import { useCodeLightDiscoveryProgress } from '@/sync/codeLightLoadingProgress';
import { useCodeLightProjectActivities } from '@/hooks/useCodeLightProjectActivity';
import { codeLightProjectActivityStore, type CodeLightProjectDescriptor } from '@/sync/codeLightProjectActivity';
import { CodeLightProjectStatus } from './CodeLightProjectStatus';
import { CodeLightSessionStatus } from './CodeLightSessionStatus';
import { CodeLightBottomNavigation } from './CodeLightBottomNavigation';
import { Typography } from '@/constants/Typography';
import { codeLightSourceLabel } from '@/utils/codeLightSourceScope';
import { getCurrentLanguage } from '@/text';
import { codeLightSubagentKindLabels } from '@/text/codeLightSubagentLabels';
import { PeerChannelControl } from './PeerChannelControl';

export const CodeLightSessions = React.memo(function CodeLightSessions() {
    const catalog = useAllSessions(), machines = useAllMachines({ includeOffline: true }), router = useRouter(), insets = useSafeAreaInsets(), focused = useIsFocused();
    const sessions = useMemo(() => catalog.filter(isCodeLightNativeSession), [catalog]);
    const conversationCount = useMemo(() => sessions.filter(isCodeLightConversation).length, [sessions]);
    const { theme } = useUnistyles();
    const progress = useCodeLightDiscoveryProgress();
    const socketStatus = useSocketStatus().status;
    const [query, setQuery] = useState(''), [projects, setProjects] = useState(new Set<string>()), [parents, setParents] = useState(new Set<string>());
    const deferredQuery = useDeferredValue(query);
    const searching = deferredQuery.trim().length > 0;
    const rows = useMemo(() => buildCodeLightBrowserRows(sessions, deferredQuery, projects, parents), [sessions, deferredQuery, projects, parents]);
    const [visibleProjects, setVisibleProjects] = useState<string[]>([]);
    const [visibleSessions, setVisibleSessions] = useState<Array<{ id: string; nativeId: string; projectId: string }>>([]);
    const descriptors = useMemo(() => {
        if (!focused) return [];
        const byId = new Map<string, CodeLightProjectDescriptor>();
        const machineIndex = new Map(machines.map(machine => [machine.id, machine]));
        const visible = new Set(visibleProjects);
        // 查询只带项目身份；状态更新不会使大目录重新分组，也不会为统计下载聊天历史。
        for (const session of sessions) {
            if (!isCodeLightConversation(session)) continue;
            const metadata = session.metadata;
            const machineId = metadata?.machineId, id = codeLightProjectKey(session);
            if (!machineId || byId.has(id) || !visible.has(id)) continue;
            const machine = machineIndex.get(machineId);
            if (!machine?.active || machine.metadata?.codeLight?.projectActivityVersion !== 1) continue;
            byId.set(id, { id, machineId, hostId: metadata?.bridge?.source.hostId ?? 'local', projectKey: metadata?.nativeSession?.projectKey || metadata?.path || '/',
                app: metadata?.bridge?.source.app === 'antigravity' ? 'antigravity' : metadata?.bridge?.source.app === 'claude-desktop' ? 'claude-desktop' : 'codex',
                sessions: visibleSessions.filter(row => row.projectId === id).map(({ id, nativeId }) => ({ id, nativeId })) });
        }
        return [...byId.values()];
    }, [focused, machines, sessions, visibleProjects, visibleSessions]);
    useCodeLightProjectActivities(descriptors);
    React.useEffect(() => {
        if (!focused) return;
        const enabled = new Set(descriptors.map(project => project.id));
        codeLightProjectActivityStore.mark(visibleProjects.filter(id => !enabled.has(id)), 'unavailable');
        codeLightProjectActivityStore.markSessions(visibleSessions.filter(row => !enabled.has(row.projectId)).map(row => row.id), 'unavailable');
    }, [focused, descriptors, visibleProjects, visibleSessions]);
    const viewability = useRef({ itemVisiblePercentThreshold: 1, minimumViewTime: 200 }).current;
    const viewableChanged = useCallback(({ viewableItems }: { viewableItems: Array<{ item: CodeLightBrowserRow }> }) => {
        const rows = viewableItems.flatMap(token => token.item.kind === 'session' && token.item.session.metadata?.bridge?.source.id
            ? [{ id: token.item.session.id, nativeId: token.item.session.metadata.bridge.source.id, projectId: token.item.projectId }] : []).slice(0, 64);
        const next = [...new Set([...viewableItems.filter(token => token.item.kind === 'project').map(token => token.item.key), ...rows.map(row => row.projectId)])].slice(0, 16);
        setVisibleProjects(previous => previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next);
        setVisibleSessions(previous => JSON.stringify(previous) === JSON.stringify(rows) ? previous : rows);
    }, []);
    const toggle = (value: string, previous: Set<string>) => { const next = new Set(previous); if (next.has(value)) next.delete(value); else next.add(value); return next; };
    const render = ({ item }: { item: CodeLightBrowserRow }) => item.kind === 'project' ? <Pressable testID={'codelight-project:' + item.key} accessibilityRole="button" accessibilityState={{ expanded: projects.has(item.key) || searching }} style={styles.project} onPress={() => setProjects(previous => toggle(item.key, previous))}>
        <Ionicons name={projects.has(item.key) || searching ? 'chevron-down' : 'chevron-forward'} size={17} color={theme.colors.textSecondary} />
        <View style={{ flex: 1 }}><Text style={styles.projectTitle}>{item.sourceLabel} · {item.label}</Text><Text style={styles.path} numberOfLines={1}>{item.path}</Text><CodeLightProjectStatus projectId={item.key} /></View><Text style={styles.count}>{item.count}</Text>
    </Pressable> : <View style={[styles.row, item.child && styles.child]}>
        <Pressable testID={(item.session.metadata?.nativeSession?.isSubagent ? 'codelight-subagent-session:' : 'codelight-session:') + item.session.id} accessibilityRole="button" accessibilityLabel={`${item.session.metadata?.nativeSession?.isSubagent ? codeLightSubagentKindLabels[getCurrentLanguage()] + ' · ' : ''}${codeLightSourceLabel(item.session.metadata?.bridge?.source)} · ${item.title}`} style={{ flex: 1 }} onPress={() => navigateToSession(router, item.session.id)}>
            <Text style={styles.title} numberOfLines={2}>{item.session.metadata?.nativeSession?.isSubagent ? codeLightSubagentKindLabels[getCurrentLanguage()] + ' · ' : ''}{item.title}</Text>
            <CodeLightSessionStatus sessionId={item.session.id} />
            <Text style={styles.detail} numberOfLines={1}>{item.session.metadata?.nativeSession?.preview || item.session.metadata?.bridge?.source.id?.slice(0, 8)}</Text>
            <Text style={styles.time}>{formatSessionListTimestamp(item.at)}</Text>
        </Pressable>
        {item.children ? <Pressable style={styles.branch} onPress={() => setParents(previous => toggle(item.session.id, previous))}><Ionicons name="git-branch-outline" size={18} color={theme.colors.textSecondary} /><Text style={styles.count}>{item.children}</Text></Pressable> : null}
    </View>;
    return <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}><Text style={styles.heading}>{t('tabs.sessions')}</Text>{conversationCount > 0 || progress.phase === 'complete' && socketStatus === 'connected' ? <Text style={styles.count}>{conversationCount}</Text> : null}
            <View style={{ flex: 1 }} /><PeerChannelControl presentation="header" directory />
        </View>
        <View style={styles.search}><Ionicons name="search-outline" size={19} color={theme.colors.textSecondary} /><TextInput testID="codelight-session-search" style={styles.input} value={query} onChangeText={setQuery} placeholder={t('tools.names.search')} placeholderTextColor={theme.colors.textSecondary} autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" /></View>
        <FlatList data={rows} keyExtractor={row => row.key} renderItem={render} viewabilityConfig={viewability} onViewableItemsChanged={viewableChanged} keyboardShouldPersistTaps="handled" initialNumToRender={18} maxToRenderPerBatch={20} windowSize={7} contentContainerStyle={{ paddingBottom: 16 }}
            ListEmptyComponent={progress.phase === 'complete' ? <Text style={[styles.count, { padding: 20 }]}>{t('codeLightLoading.empty')}</Text> : null} />
        <CodeLightBottomNavigation active="sessions" />
    </View>;
});
const styles = StyleSheet.create(theme => ({
    root: { flex: 1, backgroundColor: theme.colors.groupped.background }, header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, gap: 12 },
    heading: { fontSize: 28, color: theme.colors.text, ...Typography.default('semiBold') }, count: { fontSize: 13, color: theme.colors.textSecondary },
    search: { marginHorizontal: 20, marginBottom: 14, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, backgroundColor: theme.colors.surface }, input: { flex: 1, height: 42, color: theme.colors.text },
    project: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider }, projectTitle: { fontSize: 17, fontWeight: '600', color: theme.colors.text }, path: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 4 },
    row: { padding: 18, marginHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, flexDirection: 'row', gap: 14 }, child: { marginLeft: 36 }, title: { fontSize: 16, fontWeight: '500', color: theme.colors.text }, detail: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 5 }, time: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 6 }, branch: { alignItems: 'center', justifyContent: 'center', gap: 4, padding: 8 },
}));
