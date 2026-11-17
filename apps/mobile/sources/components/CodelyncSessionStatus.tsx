import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useCodelyncSessionActivity } from '@/hooks/useCodelyncProjectActivity';
import type { CodelyncSessionActivity } from '@/sync/codelyncProjectActivity';
import { t } from '@/text';

export const CodelyncSessionStatus = React.memo(({ sessionId }: { sessionId: string }) => {
    const activity = useCodelyncSessionActivity(sessionId);
    return <CodelyncSessionStatusView activity={activity} />;
});

export const CodelyncSessionStatusView = React.memo(({ activity }: { activity: CodelyncSessionActivity }) => {
    const { theme } = useUnistyles();
    const color = theme.colors.textSecondary;
    if (!activity.known || activity.status !== 'ready') return <Text style={{ fontSize: 12, color, marginTop: 5 }}>{t('codelyncSessionStatus.unknown')}</Text>;
    return <View style={{ flexDirection: 'row', gap: 10, marginTop: 5 }} testID="codelync-session-status">
        {activity.active ? <Text style={{ fontSize: 12, color: theme.colors.text }}>{t('codelyncSessionStatus.active')}</Text> : null}
        {activity.waiting ? <Text style={{ fontSize: 12, color: theme.colors.textLink }}>{t('codelyncSessionStatus.waiting')}</Text> : null}
        {!activity.active && !activity.waiting ? <Text style={{ fontSize: 12, color }}>{t('codelyncSessionStatus.idle')}</Text> : null}
    </View>;
});
