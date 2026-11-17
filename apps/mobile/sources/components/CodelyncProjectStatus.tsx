import * as React from 'react';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useCodelyncProjectActivity } from '@/hooks/useCodelyncProjectActivity';
import { t } from '@/text';
import type { CodelyncProjectActivity } from '@/sync/codelyncProjectActivity';

export const CodelyncProjectStatus = React.memo(({ projectId }: { projectId: string }) => {
    const activity = useCodelyncProjectActivity(projectId);
    return <CodelyncProjectStatusView activity={activity} />;
});

export const CodelyncProjectStatusView = React.memo(({ activity }: { activity: CodelyncProjectActivity }) => {
    const { theme } = useUnistyles();
    const color = theme.colors.textSecondary;
    if (activity.status !== 'ready' && !(activity.status === 'refreshing' && activity.observedAt > 0 && activity.total > 0)) {
        const label = activity.status === 'refreshing' ? t('codelyncProjects.refreshing') : activity.status === 'stale' ? t('codelyncProjects.stale') : t('codelyncProjects.unavailable');
        return <Text style={{ fontSize: 12, color, marginTop: 5 }}>{label}</Text>;
    }
    return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 5 }} testID="codelync-project-status">
        <Text style={{ fontSize: 12, color: theme.colors.text }}>{t('codelyncProjects.active', { count: activity.active })}</Text>
        <Text style={{ fontSize: 12, color: activity.waiting ? theme.colors.textLink : color }}>{t('codelyncProjects.waiting', { count: activity.waiting })}</Text>
        {activity.unknown > 0 ? <Text style={{ fontSize: 12, color }}>{t('codelyncProjects.unknown', { count: activity.unknown })}</Text> : null}
        {activity.status === 'refreshing' ? <Text style={{ fontSize: 12, color }}>{t('codelyncProjects.refreshing')}</Text> : null}
    </View>;
});
