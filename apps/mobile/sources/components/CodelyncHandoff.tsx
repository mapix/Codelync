import * as React from 'react';
import { Alert, FlatList, Modal, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { storage, useAllMachines, useAllSessions } from '@/sync/storage';
import type { Metadata, Session } from '@/sync/storageTypes';
import type { AgentTextMessage } from '@/sync/typesMessage';
import { navigateToSession } from '@/hooks/useNavigateToSession';
import { codelyncSourceLabel } from '@/utils/codelyncSourceScope';
import { createCodelyncHandoff, codelyncHandoffTargets, prepareCodelyncHandoffDraft, type CodelyncHandoff as Handoff } from '@/utils/codelyncHandoff';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** Catalog and machine subscriptions exist only while the target picker is open. */
export function CodelyncHandoff(props: { sessionId: string; metadata: Metadata | null; message: AgentTextMessage }) {
    const { theme } = useUnistyles();
    const [handoff, setHandoff] = React.useState<Handoff | null>(null);
    const currentSource = React.useCallback(() => storage.getState().sessions[props.sessionId]
        ?? { id: props.sessionId, metadata: props.metadata, updatedAt: 0 }, [props.sessionId, props.metadata]);
    const eligibilityKey = React.useCallback(() => {
        const value = createCodelyncHandoff(currentSource(), props.message);
        return value ? JSON.stringify([value.sourceApp, value.machineId, value.hostId, value.nativeConversationId, value.ownerGeneration]) : null;
    }, [currentSource, props.message]);
    const liveKey = React.useSyncExternalStore(storage.subscribe, eligibilityKey, eligibilityKey);
    const eligible = React.useMemo(() => createCodelyncHandoff(currentSource(), props.message), [currentSource, props.message, liveKey]);
    React.useEffect(() => {
        if (handoff && (!eligible || eligible.ownerGeneration !== handoff.ownerGeneration || eligible.hostId !== handoff.hostId)) setHandoff(null);
    }, [eligible?.ownerGeneration, eligible?.hostId, handoff]);
    if (!eligible) return null;
    return <>
        <Pressable testID="codelync-handoff" accessibilityRole="button" accessibilityLabel={t('codelyncHandoff.action')}
            hitSlop={4}
            onPress={() => {
                const session = storage.getState().sessions[props.sessionId];
                if (session) setHandoff(createCodelyncHandoff(session, props.message));
            }}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
            <Ionicons name="arrow-redo-outline" size={16} color={theme.colors.text} />
            <Text style={styles.actionLabel}>{t('codelyncHandoff.action')}</Text>
        </Pressable>
        {handoff ? <HandoffTargets handoff={handoff} onClose={() => setHandoff(null)} /> : null}
    </>;
}

function HandoffTargets({ handoff, onClose }: { handoff: Handoff; onClose: () => void }) {
    const sessions = useAllSessions(), machines = useAllMachines({ includeOffline: true }), router = useRouter();
    const online = machines.some(machine => machine.id === handoff.machineId && machine.active);
    const targets = React.useMemo(() => online ? codelyncHandoffTargets(handoff, sessions) : [], [handoff, online, sessions]);
    const select = (sessionId: string) => {
        const state = storage.getState(), source = state.sessions[handoff.sourceSessionId], target = state.sessions[sessionId];
        const currentMachine = state.machines[handoff.machineId];
        const draft = source && target && currentMachine?.active ? prepareCodelyncHandoffDraft(handoff, source, target) : null;
        onClose();
        if (draft === null) { Alert.alert(t('common.error'), t('codelyncHandoff.unavailable')); return; }
        state.updateSessionDraft(sessionId, draft);
        navigateToSession(router, sessionId);
    };
    const render = ({ item }: { item: Session }) => <Pressable testID={`codelync-handoff-target-${item.id}`} accessibilityRole="button"
        onPress={() => select(item.id)} style={({ pressed }) => [styles.target, pressed && styles.pressed]}>
        <Text style={styles.targetLabel} numberOfLines={2}>{codelyncSourceLabel(item.metadata?.bridge?.source)} · {item.metadata?.nativeSession?.title || item.metadata?.summary?.text || item.id.slice(0, 8)}</Text>
    </Pressable>;
    return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <View style={styles.overlay}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={onClose} style={styles.backdrop} />
            <View style={styles.sheet}>
                <View style={styles.header}><Text style={styles.heading} numberOfLines={1}>{t('codelyncHandoff.action')}</Text>
                    <Pressable accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={onClose} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}><Text style={styles.actionLabel}>{t('common.cancel')}</Text></Pressable>
                </View>
                <FlatList data={targets} renderItem={render} keyExtractor={item => item.id} keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{ paddingBottom: 4 }}
                    initialNumToRender={12} maxToRenderPerBatch={12} windowSize={3}
                    ListEmptyComponent={<Text style={styles.empty}>{t('codelyncHandoff.noTargets')}</Text>} />
            </View>
        </View>
    </Modal>;
}

const styles = StyleSheet.create(theme => ({
    action: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, minWidth: 44, paddingHorizontal: 10 },
    actionLabel: { color: theme.colors.text, fontSize: 13, ...Typography.default() },
    pressed: { opacity: 0.5 },
    overlay: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 24 },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000000', opacity: theme.dark ? 0.56 : 0.28 },
    sheet: { maxHeight: '60%', borderRadius: 18, overflow: 'hidden', backgroundColor: theme.colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    header: { flexDirection: 'row', alignItems: 'center', paddingLeft: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    heading: { flex: 1, minWidth: 0, fontSize: 17, color: theme.colors.text, ...Typography.default('semiBold') },
    cancel: { minHeight: 44, minWidth: 44, paddingHorizontal: 18, paddingVertical: 12, justifyContent: 'center', alignItems: 'center', flexShrink: 0 },
    target: { minHeight: 52, justifyContent: 'center', paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    targetLabel: { color: theme.colors.text, fontSize: 15, ...Typography.default() },
    empty: { color: theme.colors.textSecondary, fontSize: 15, padding: 18, ...Typography.default() },
}));
