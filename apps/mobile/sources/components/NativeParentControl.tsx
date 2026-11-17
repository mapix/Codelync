import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { storage, useAllSessions, useSession } from '@/sync/storage';
import { nativeParentControl, prepareNativeParentContinuation } from '@/utils/nativeParentControl';
import { codelyncSubagentParent } from '@/utils/codelyncSubagents';
import { navigateToSession } from '@/hooks/useNavigateToSession';
import { getCurrentLanguage, t } from '@/text';
import { nativeParentControlLabels } from '@/text/nativeParentControlLabels';
import { nativeSessionAvailabilityLabels } from '@/text/nativeSessionAvailabilityLabels';
import { sync } from '@/sync/sync';

export function NativeParentControl({ sessionId, topInset = 0 }: { sessionId: string; topInset?: number }) {
    const session = useSession(sessionId), catalog = useAllSessions(), router = useRouter(), { theme } = useUnistyles();
    const input = session && nativeParentControl(session), parent = session && codelyncSubagentParent(session, catalog);
    const labels = nativeParentControlLabels[getCurrentLanguage()];
    const [busy, setBusy] = React.useState(false), [failed, setFailed] = React.useState(false), flight = React.useRef(false);
    React.useEffect(() => { setFailed(false); }, [sessionId, parent?.id]);
    if (!session || !input) return null;
    return <View testID="codelync-parent-owned-control" style={{ paddingHorizontal: 14, paddingTop: topInset + 14, paddingBottom: 14, backgroundColor: theme.colors.groupped.background }}>
        <Text style={{ color: theme.colors.textSecondary }}>{labels.managed}</Text>
        {parent ? <Pressable testID="codelync-continue-in-parent" accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => {
            const state = storage.getState(), child = state.sessions[sessionId], target = state.sessions[parent.id];
            const draft = child && target ? prepareNativeParentContinuation(child, target) : null;
            if (draft !== null) { state.updateSessionDraft(parent.id, draft); navigateToSession(router, parent.id); }
        }}><Text style={{ color: theme.colors.text }}>{labels.continue}</Text></Pressable> : null}
        {!parent ? <><Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary }}>{failed ? nativeSessionAvailabilityLabels[getCurrentLanguage()].refreshFailed : labels.unavailable}</Text>
            <Pressable testID="codelync-parent-read-retry" accessibilityRole="button" disabled={busy} style={{ minHeight: 44, justifyContent: 'center' }} onPress={() => {
                if (flight.current) return; flight.current = true; setBusy(true); setFailed(false);
                void sync.refreshSessions().catch(() => setFailed(true)).finally(() => { flight.current = false; setBusy(false); });
            }}><Text style={{ color: theme.colors.text }}>{t('common.retry')}</Text></Pressable></> : null}
    </View>;
}
