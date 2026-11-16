import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { selectConnection } from '@/sync/codeLightConnection';
import { PeerChannelControlView } from './PeerChannelControlView';
import { useCodeLightConnectionState } from '@/hooks/useCodeLightConnectionState';
import { useSession } from '@/sync/storage';
import { useCodeLightMessageProgress, useCodeLightDiscoveryProgress } from '@/sync/codeLightLoadingProgress';
import { nativeSessionReadNotice } from '@/utils/nativeSessionReadNotice';
import { nativeSessionAvailabilityLabels } from '@/text/nativeSessionAvailabilityLabels';
import { nativeReadRecoveryLabels } from '@/text/nativeReadRecoveryLabels';
import { getCurrentLanguage, t } from '@/text';
import { useRouter } from 'expo-router';
import { sync } from '@/sync/sync';
import { useCodeLightSelectionState } from '@/sync/codeLightSessionSelection';

export { PeerChannelControlView, type PeerChannelSnapshot } from './PeerChannelControlView';

/** Shared peer selection owner; UI state cannot replace its authenticated route. */
export const PeerChannelControl = React.memo(function PeerChannelControl({ style, presentation, showDivider, sessionId, directory = false }: { style?: StyleProp<ViewStyle>; presentation?: 'compact' | 'settings' | 'header'; showDivider?: boolean; sessionId?: string; directory?: boolean }) {
    const { snapshot, state } = useCodeLightConnectionState(), router = useRouter();
    const session = useSession(sessionId ?? ''), progress = useCodeLightMessageProgress(sessionId ?? '');
    const selection = useCodeLightSelectionState(sessionId ?? '');
    const notice = sessionId ? nativeSessionReadNotice(session, progress, selection) : null;
    const discovery = useCodeLightDiscoveryProgress();
    const labels = nativeSessionAvailabilityLabels[getCurrentLanguage()], cachedLabels = nativeReadRecoveryLabels[getCurrentLanguage()];
    const message = notice === 'checking' ? cachedLabels.checking : notice === 'read-failed' ? progress.revalidationFailed ? cachedLabels.failed : labels.readFailed
        : notice === 'source-unavailable' ? session?.metadata?.bridge?.sourceStatus === 'locked' ? labels.locked : session?.metadata?.bridge?.sourceStatus === 'permission-required' ? labels.permissionRequired : labels.sourceUnavailable : null;
    const directoryMessage = discovery.phase === 'error' ? t('codeLightLoading.failed') : discovery.phase === 'loading' || discovery.phase === 'idle' ? t('codeLightLoading.titles') : null;
    const details = directory && directoryMessage ? { scope: 'directory', message: directoryMessage, failed: discovery.phase === 'error', retry: discovery.phase === 'error' ? () => sync.refreshSessions() : undefined }
        : message ? { scope: sessionId, message, failed: notice !== 'checking', retry: sessionId && notice !== 'checking' ? () => sync.retryCodeLightSession(sessionId) : undefined } : undefined;
    return <PeerChannelControlView snapshot={snapshot} connectionState={state} onSelect={selectConnection} style={style} presentation={presentation} showDivider={showDivider}
        sourceNotice={details}
        onScan={() => router.push('/pair')} />;
});
