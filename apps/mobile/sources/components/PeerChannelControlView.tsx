import * as React from 'react';
import { ActivityIndicator, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PeerChannel } from '@codelync/wire/codelync';
import { Text } from './StyledText';
import { Typography } from '@/constants/Typography';
import { PickerSheet, PickerSheetOption } from './PickerSheet';
import { t, getCurrentLanguage } from '@/text';
import { codelyncChannelLabels } from '@/text/codelyncChannelLabels';
import type { CodelyncConnectionState } from '@/utils/codelyncConnectionState';

export interface PeerChannelSnapshot {
    peerId: string | null;
    channels: Array<PeerChannel & { state: 'connected' | 'available' | 'probing' | 'failed'; latencyMs?: number }>;
    selectedId: string | null;
    activeId?: string | null;
    desiredKind?: PeerChannel['kind'] | null;
    writable?: boolean;
    automatic: boolean;
    connecting: boolean;
    failureCode?: 'connection-failed' | 'access-ended' | 'preference-not-saved' | null;
}

function channelName(kind: PeerChannel['kind']) { return t(`codelyncChannels.${kind}`); }
function channelHost(channel: PeerChannel) {
    try { return new URL(channel.url).host; } catch { return ''; }
}

/** The connection service owns selection and probes; the view owns only its open sheet. */
export function PeerChannelControlView({ snapshot, onSelect, style, presentation = 'compact', showDivider = false, connectionState, sourceNotice, onScan, onRetry }: {
    snapshot: PeerChannelSnapshot;
    onSelect: (id: string | 'auto') => Promise<void>;
    style?: StyleProp<ViewStyle>;
    presentation?: 'compact' | 'settings' | 'header';
    showDivider?: boolean;
    connectionState?: CodelyncConnectionState;
    sourceNotice?: { scope?: string; message: string; failed: boolean; retry?: () => Promise<void> };
    onScan?: () => void;
    onRetry?: () => Promise<void>;
}) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [open, setOpen] = React.useState(false);
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState(false);
    const generation = React.useRef(0), busy = React.useRef(false);
    const choice = React.useRef<string | null>(null);
    const selected = snapshot.channels.find(channel => channel.id === snapshot.selectedId);
    const actual = snapshot.channels.find(channel => channel.id === (snapshot.activeId ?? snapshot.selectedId));
    const copy = codelyncChannelLabels[getCurrentLanguage()] ?? codelyncChannelLabels.en;
    const triggerScan = React.useCallback(() => {
        if (!onScan) return;
        setOpen(false);
        onScan();
    }, [onScan]);
    const scope = JSON.stringify([snapshot.peerId, snapshot.selectedId, snapshot.automatic, selected?.url ?? null, sourceNotice?.scope ?? null]);
    const currentScope = React.useRef(scope); currentScope.current = scope;
    const healthy = !snapshot.connecting && snapshot.writable !== false && actual?.state === 'connected';
    React.useEffect(() => { setError(false); }, [scope]);
    React.useEffect(() => {
        generation.current++; busy.current = false; setSubmitting(false);
    }, [sourceNotice?.scope]);
    React.useEffect(() => {
        if (healthy && !snapshot.failureCode) setError(false);
    }, [healthy, snapshot]);
    React.useEffect(() => {
        generation.current++;
        busy.current = false; setSubmitting(false); setOpen(false); setError(false);
        return () => { generation.current++; };
    }, [snapshot.peerId]);

    const choose = React.useCallback(async (id: string) => {
        if (busy.current && choice.current === id) return;
        choice.current = id;
        busy.current = true; setSubmitting(true); setError(false);
        const current = ++generation.current;
        try {
            await onSelect(id);
            if (generation.current === current) setOpen(false);
        } catch {
            if (generation.current === current) setError(true);
        } finally {
            if (generation.current === current) { busy.current = false; setSubmitting(false); }
        }
    }, [onSelect]);
    const retryRead = () => {
        if (busy.current || !sourceNotice?.retry) return;
        const current = generation.current, owner = currentScope.current;
        busy.current = true; setSubmitting(true);
        const read = sourceNotice.retry;
        void Promise.resolve().then(() => {
            if (generation.current === current && currentScope.current === owner) return read();
        }).catch(() => {}).finally(() => {
            if (generation.current === current && currentScope.current === owner) { busy.current = false; setSubmitting(false); }
        });
    };

    const hasRoutes = !!snapshot.peerId && snapshot.channels.length > 0;
    if (!hasRoutes && presentation !== 'header') return null;
    const failed = error || !!snapshot.failureCode || connectionState?.kind === 'failed' || connectionState?.kind === 'access-ended' || sourceNotice?.failed;
    const recovering = !failed && (snapshot.connecting || submitting || connectionState?.kind === 'connecting' || !!sourceNotice && !sourceNotice.failed);
    const routeIcon = actual?.kind === 'local' ? 'wifi-outline' : actual?.kind === 'relay' ? 'swap-horizontal-outline' : 'cloud-outline';
    const headerIcon = failed || !hasRoutes ? 'alert-circle-outline' : recovering ? 'sync-outline' : routeIcon;
    const differs = !snapshot.automatic && snapshot.selectedId !== actual?.id;
    const label = differs ? `${copy.desired}: ${channelName(snapshot.desiredKind ?? selected?.kind ?? 'local')} · ${copy.current}: ${actual ? channelName(actual.kind) : t('codelyncChannels.notConnected')}`
        : selected ? [snapshot.connecting ? t('codelyncChannels.switching') : selected.state !== 'connected' ? t(`codelyncChannels.${selected.state}`) : '', snapshot.automatic ? t('codelyncChannels.automatic') : '', channelName(selected.kind)].filter(Boolean).join(' · ')
        : t(snapshot.connecting ? 'codelyncChannels.switching' : 'codelyncChannels.notConnected');
    return (
        <View testID={presentation === 'header' ? 'codelync-channel-header-slot' : undefined} style={[presentation === 'header' ? styles.headerContainer : presentation === 'settings' ? styles.settingsContainer : styles.container, style]}>
            <Pressable testID="codelync-channel-open" accessibilityRole="button" accessibilityLabel={`${t('codelyncChannels.title')}: ${presentation === 'header' && failed ? t('codelyncChannels.failedTitle') : presentation === 'header' && recovering ? t('codelyncChannels.connectingTitle') : label}`}
                accessibilityState={{ expanded: open, busy: submitting }}
                onPress={() => { setError(false); setOpen(true); }} style={presentation === 'header' ? styles.headerTrigger : presentation === 'settings' ? styles.settingsTrigger : styles.trigger}>
                {presentation === 'header' ? <Ionicons testID="codelync-channel-status-icon" name={headerIcon} size={21} color={failed ? theme.colors.textDestructive : theme.colors.textSecondary} /> : snapshot.connecting || submitting ? <ActivityIndicator style={styles.triggerIcon} size="small" color={theme.colors.textSecondary} />
                    : <Ionicons style={styles.triggerIcon} name={selected?.kind === 'local' ? 'wifi-outline' : selected?.kind === 'relay' ? 'swap-horizontal-outline' : 'cloud-outline'} size={presentation === 'settings' ? 25 : 16} color={theme.colors.textSecondary} />}
                {presentation === 'header' ? null : presentation === 'settings' ? <View style={styles.settingsCopy}>
                    <Text style={styles.settingsTitle}>{t('codelyncChannels.title')}</Text>
                    <Text style={styles.settingsDescription} numberOfLines={2}>{label}</Text>
                </View> : <Text style={styles.triggerText} numberOfLines={2}>{label}</Text>}
                {presentation !== 'header' ? <Ionicons style={styles.triggerIcon} name={presentation === 'settings' ? 'chevron-forward' : 'chevron-down'} size={presentation === 'settings' ? 18 : 14} color={theme.colors.textSecondary} /> : null}
            </Pressable>
            {presentation === 'settings' && showDivider ? <View style={styles.settingsDivider} /> : null}
            <PickerSheet visible={open} title={t('codelyncChannels.title')} onClose={() => setOpen(false)}>
                {open && (connectionState?.kind === 'failed' || connectionState?.kind === 'access-ended') ? <Text testID="codelync-channel-connection-error" accessibilityLiveRegion="polite" style={styles.error}>{t(connectionState.kind === 'access-ended' ? 'codelyncChannels.accessEndedHelp' : 'codelyncChannels.failedHelp')}</Text> : null}
                {open && sourceNotice ? <View style={styles.readNotice}><Text testID="codelync-channel-source-notice" accessibilityLiveRegion="polite" style={styles.error}>{sourceNotice.message}</Text>
                    {sourceNotice.retry ? <PickerSheetOption testID="codelync-channel-read-retry" label={t('common.retry')} selected={false} action disabled={submitting}
                        onPress={retryRead} /> : null}
                </View> : null}
                {hasRoutes ? <PickerSheetOption testID="codelync-channel-auto" label={t('codelyncChannels.automatic')} description={t('codelyncChannels.automaticDetail')}
                    selected={snapshot.automatic} onPress={() => void choose('auto')} />
                    : onScan ? <PickerSheetOption testID="codelync-channel-scan" label={t('codelyncChannels.scanMac')} selected={false} action onPress={triggerScan} /> : null}
                {snapshot.channels.map(channel => {
                    const latency = typeof channel.latencyMs === 'number' && Number.isFinite(channel.latencyMs) && channel.latencyMs >= 0
                        ? t('codelyncChannels.latency', { ms: Math.round(channel.latencyMs) }) : t('codelyncChannels.latencyUnknown');
                    const status = [t(`codelyncChannels.${channel.state}`), latency,
                        channel.id === (snapshot.activeId ?? snapshot.selectedId) ? t('codelyncChannels.current') : ''].filter(Boolean).join(' · ');
                    const description = [status, channelHost(channel)].filter(Boolean).join('\n');
                    return <PickerSheetOption key={channel.id} testID={`codelync-channel-${channel.id}`} label={channelName(channel.kind)} description={description}
                        selected={!snapshot.automatic && channel.id === snapshot.selectedId}
                        labelIcon={<Ionicons name={channel.kind === 'local' ? 'wifi-outline' : channel.kind === 'relay' ? 'swap-horizontal-outline' : 'cloud-outline'} size={16} color={theme.colors.textSecondary} />}
                        onPress={() => void choose(channel.id)} />;
                })}
                {open && (error || snapshot.failureCode === 'connection-failed' || snapshot.failureCode === 'preference-not-saved') ? <Text testID="codelync-channel-error" accessibilityLiveRegion="polite" style={styles.error}>{snapshot.failureCode === 'preference-not-saved' ? copy.unsaved : copy.failed}</Text> : null}
                {open && snapshot.failureCode === 'connection-failed' ? <View><Text style={styles.error}>{copy.locate}</Text>
                    {onRetry ? <PickerSheetOption testID="codelync-channel-retry" label={t('codelyncChannels.retryConnection')} selected={false} action disabled={submitting}
                        onPress={() => { void onRetry().catch(() => {}); }} /> : null}
                    {onScan ? <PickerSheetOption testID="codelync-channel-location-scan" label={t('codelyncChannels.scanMac')} selected={false} action onPress={triggerScan} /> : null}
                </View> : null}
                {open && connectionState?.kind === 'access-ended' && onScan ? <PickerSheetOption testID="codelync-channel-scan" label={t('codelyncChannels.scanMac')} selected={false} action onPress={triggerScan} /> : null}
            </PickerSheet>
        </View>
    );
}

const stylesheet = StyleSheet.create(theme => ({
    container: { alignSelf: 'flex-start', maxWidth: '100%' },
    headerContainer: { alignSelf: 'center', width: 44, height: 44 },
    headerTrigger: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    readNotice: { paddingTop: 4 },
    settingsContainer: { alignSelf: 'stretch' },
    settingsTrigger: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 16, paddingVertical: 12 },
    settingsCopy: { flex: 1, minWidth: 0, gap: 3 },
    settingsTitle: { color: theme.colors.text, fontSize: 17, ...Typography.default() },
    settingsDescription: { color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() },
    settingsDivider: { marginLeft: 54, height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider },
    trigger: { minHeight: 44, maxWidth: 300, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 22,
        backgroundColor: theme.colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    triggerIcon: { flexShrink: 0 },
    triggerText: { flexShrink: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: theme.colors.text, ...Typography.default() },
    error: { marginHorizontal: 24, marginVertical: 12, color: theme.colors.textDestructive ?? theme.colors.textSecondary, fontSize: 13, ...Typography.default() },
}));
