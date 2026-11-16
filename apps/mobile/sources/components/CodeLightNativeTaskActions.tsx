import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getCurrentAppState, apiSocket } from '@/sync/apiSocket';
import { storage, useSocketStatus } from '@/sync/storage';
import { nativeWriteConnectionBlocked } from '@/utils/nativeWriteConnection';
import { getServerUrl } from '@/sync/serverConfig';
import { nativeTaskReader } from '@/sync/nativeTasksRpc';
import { NativeTaskOutputSchema, type NativeTask, type NativeTasks, type NativeTaskScope, type NativeTaskOutput } from '@/sync/nativeTasks';
import { createNativeTaskActions, nativeTaskActionAllowed } from '@/utils/nativeTaskActions';
import { captureCurrentNativeTaskScope, nativeTaskScopesEqual } from '@/utils/codeLightNativeTasks';
import { getCurrentLanguage, t } from '@/text';
import { nativeTaskActionLabels } from '@/text/nativeTaskActionLabels';
import { codeLightTaskLabels } from '@/text/codeLightTaskLabels';

export function CodeLightNativeTaskActions({ sessionId, native, scope, task, active }: {
    sessionId: string; native: NativeTasks | null; scope: NativeTaskScope | null; task: NativeTask; active: boolean;
}) {
    const socketConnected = useSocketStatus().status === 'connected';
    const latest = React.useRef({ native, active }); latest.current = { native, active };
    const view = () => ({ session: storage.getState().sessions[sessionId], native: latest.current.native,
        active: latest.current.active && getCurrentAppState() === 'active' });
    const controller = React.useMemo(() => createNativeTaskActions({
        current: () => view(), authority: () => apiSocket.peerIdentity() ?? getServerUrl(),
        output: (id, captured, taskId) => nativeTaskReader.output(id, captured, taskId),
        journal: async (id, method, params) => {
            const authority = apiSocket.peerIdentity() ?? getServerUrl();
            const { runNoninvasiveRpc } = await import('@/sync/noninvasiveRpc');
            if (authority !== (apiSocket.peerIdentity() ?? getServerUrl())
                || nativeWriteConnectionBlocked(view().session?.metadata, apiSocket.peerConnected())
                || !nativeTaskActionAllowed(view(), params.scope as NativeTaskScope, params.taskId as string, 'stop')) throw Error('Native task action unavailable');
            return runNoninvasiveRpc(id, method, params);
        },
    }), [sessionId]);
    const key = JSON.stringify([sessionId, scope, task.nativeTaskId]);
    const [output, setOutput] = React.useState<{ key: string; scope: NativeTaskScope; page: NativeTaskOutput | null; failed: boolean } | null>(null);
    const [stop, setStop] = React.useState<{ key: string; state: 'pending' | 'requested' | 'unknown' | 'failed'; scope?: NativeTaskScope; authority?: string; commandId?: string; checking?: boolean } | null>(null);
    const busy = React.useRef(new Set<string>()), epoch = React.useRef(0);
    const outputEpoch = React.useRef(0);
    React.useEffect(() => { epoch.current++; setOutput(null); return () => { epoch.current++; }; }, [key, active]);
    const language = getCurrentLanguage(), labels = nativeTaskActionLabels[language], common = codeLightTaskLabels[language], { theme } = useUnistyles();
    const canOutput = !!scope && nativeTaskActionAllowed(view(), scope, task.nativeTaskId, 'output');
    React.useEffect(() => { if (!canOutput) setOutput(null); }, [canOutput]);
    const canStop = !!scope && !nativeWriteConnectionBlocked(view().session?.metadata, socketConnected) && nativeTaskActionAllowed(view(), scope, task.nativeTaskId, 'stop') && stop?.key !== key;
    const currentOutput = output?.key === key && scope && nativeTaskScopesEqual(output.scope, scope) && canOutput ? output : null;
    const readOutput = async () => {
        if (!scope || !canOutput || busy.current.has(key + ':output')) return;
        const captured = { ...scope }, version = epoch.current, request = ++outputEpoch.current;
        busy.current.add(key + ':output'); setOutput({ key, scope: captured, page: null, failed: false });
        try {
            const value = NativeTaskOutputSchema.parse(await controller.output(sessionId, captured, task.nativeTaskId));
            if (epoch.current === version && outputEpoch.current === request) setOutput({ key, scope: captured, page: value, failed: false });
        } catch { if (epoch.current === version && outputEpoch.current === request) setOutput({ key, scope: captured, page: null, failed: true }); }
        finally { busy.current.delete(key + ':output'); }
    };
    const stopTask = async () => {
        if (!scope || !canStop || nativeWriteConnectionBlocked(view().session?.metadata, apiSocket.peerConnected()) || busy.current.has(key + ':stop')) return;
        const captured = { ...scope }, version = epoch.current, authority = apiSocket.peerIdentity() ?? getServerUrl();
        busy.current.add(key + ':stop'); setStop({ key, state: 'pending' });
        try {
            const { Modal: Confirm } = await import('@/modal');
            const accepted = await Confirm.confirm(labels.confirm, task.name, { destructive: true, confirmText: labels.stop });
            if (!accepted) { if (epoch.current === version) setStop(null); return; }
            if (epoch.current !== version) return;
            if (nativeWriteConnectionBlocked(view().session?.metadata, apiSocket.peerConnected()) || !nativeTaskActionAllowed(view(), captured, task.nativeTaskId, 'stop')) { setStop(null); return; }
            await controller.stop(sessionId, captured, task.nativeTaskId);
            if (epoch.current === version) setStop({ key, state: 'requested' });
        } catch (error) { if (epoch.current === version) {
            const id = (error as { commandId?: unknown })?.commandId;
            setStop({ key, state: 'unknown', scope: captured, authority, ...(typeof id === 'string' && id.trim() && id.length <= 512 ? { commandId: id } : {}) });
        } }
        finally { busy.current.delete(key + ':stop'); }
    };
    const closeOutput = () => { outputEpoch.current++; setOutput(null); };
    const checkAllowed = () => {
        const current = captureCurrentNativeTaskScope(view().session);
        return !!stop?.commandId && stop.key === key && view().active
            && stop.authority === (apiSocket.peerIdentity() ?? getServerUrl()) && !!stop.scope && !!current
            && nativeTaskScopesEqual(current, stop.scope);
    };
    const checkStop = async () => {
        if (!stop?.scope || !stop.commandId || !checkAllowed() || busy.current.has(key + ':receipt')) return;
        const original = stop, version = epoch.current;
        busy.current.add(key + ':receipt'); setStop({ ...original, checking: true });
        try {
            const { recoverNoninvasiveRpcDetailed } = await import('@/sync/noninvasiveRpc');
            if (!checkAllowed() || epoch.current !== version) return;
            const result = await recoverNoninvasiveRpcDetailed(sessionId, 'native-task-stop', { scope: original.scope, taskId: task.nativeTaskId }, original.commandId!);
            if (epoch.current === version && checkAllowed()) setStop({ ...original, state: result.confirmed && result.pending?.commandId === original.commandId
                ? result.failed ? 'failed' : 'requested' : 'unknown', checking: false });
        } catch { if (epoch.current === version) setStop({ ...original, checking: false }); }
        finally { busy.current.delete(key + ':receipt'); if (epoch.current === version) setStop(previous => previous?.key === key ? { ...previous, checking: false } : previous); }
    };
    const outputLoading = !!currentOutput && !currentOutput.failed && !currentOutput.page;
    return <View>
        <View style={styles.actions}>
            <Pressable testID={'codelight-native-task-output:' + task.nativeTaskId} accessibilityRole="button" accessibilityLabel={`${labels.output} · ${task.name}`}
                accessibilityState={{ disabled: !canOutput || outputLoading }} disabled={!canOutput || outputLoading} style={styles.action} onPress={() => void readOutput()}>
                <Ionicons name="terminal-outline" size={17} color={theme.colors.textSecondary} /></Pressable>
            <Pressable testID={'codelight-native-task-stop:' + task.nativeTaskId} accessibilityRole="button" accessibilityLabel={`${labels.stop} · ${task.name}`}
                accessibilityState={{ disabled: !canStop }} disabled={!canStop} style={styles.action} onPress={() => void stopTask()}>
                <Ionicons name="stop-circle-outline" size={17} color={theme.colors.textSecondary} /></Pressable>
        </View>
        {stop?.key === key && stop.state !== 'pending' ? <View><Text accessibilityLiveRegion="polite" style={styles.detail}>{stop.checking ? labels.checking : stop.state === 'requested' ? labels.requested : stop.state === 'failed' ? labels.stopFailed : !stop.commandId ? labels.unconfirmedInApp : labels.unknown}</Text>
            {stop.state === 'unknown' && stop.commandId ? <Pressable testID="codelight-native-task-check-result" accessibilityRole="button" disabled={stop.checking || !checkAllowed()} style={styles.action} onPress={() => void checkStop()}><Text style={styles.detail}>{labels.check}</Text></Pressable> : null}</View> : null}
        {currentOutput ? <Modal visible transparent animationType="fade" onRequestClose={closeOutput}>
            <View style={styles.overlay}><Pressable style={styles.backdrop} accessibilityRole="button" accessibilityLabel={common.close} onPress={closeOutput} />
                <View testID="codelight-native-task-output-panel" style={styles.sheet}>
                    <View style={styles.header}><Text style={styles.heading}>{labels.output}</Text><Pressable testID="codelight-native-task-output-close" style={styles.close}
                        accessibilityRole="button" accessibilityLabel={common.close} onPress={closeOutput}><Text style={styles.link}>{common.close}</Text></Pressable></View>
                    {currentOutput.failed ? <View><Text style={styles.detail}>{labels.outputFailed}</Text><Pressable testID="codelight-native-task-output-retry" accessibilityRole="button" disabled={!canOutput} style={styles.action} onPress={() => void readOutput()}><Text style={styles.link}>{t('common.retry')}</Text></Pressable></View> : currentOutput.page ? <ScrollView>
                        <Text selectable style={styles.body}>{currentOutput.page.output || labels.empty}</Text>
                        {currentOutput.page.truncated ? <Text testID="codelight-native-task-output-truncated" style={styles.detail}>{labels.truncated}</Text> : null}
                    </ScrollView> : <View style={styles.loading}><ActivityIndicator size="small" /><Text style={styles.detail}>{labels.loading}</Text></View>}
                </View></View></Modal> : null}
    </View>;
}

const styles = StyleSheet.create(theme => ({
    actions: { flexDirection: 'row' }, action: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
    detail: { fontSize: 11, color: theme.colors.textSecondary, paddingHorizontal: 12, paddingVertical: 6 },
    overlay: { flex: 1, justifyContent: 'center', paddingHorizontal: 20 }, backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.25)' },
    sheet: { maxHeight: '70%', borderRadius: 16, overflow: 'hidden', backgroundColor: theme.colors.surface },
    header: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingLeft: 14 }, heading: { flex: 1, color: theme.colors.text, fontSize: 14 },
    close: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 12 }, link: { color: theme.colors.textLink, fontSize: 13 },
    body: { color: theme.colors.text, paddingHorizontal: 14, paddingVertical: 12 }, loading: { flexDirection: 'row', alignItems: 'center', padding: 14 },
}));
