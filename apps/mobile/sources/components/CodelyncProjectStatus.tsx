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

function StatusGlyph({ shape, filled, color }: { shape: 'circle' | 'square'; filled: boolean; color: string }) {
    return (
        <View
            accessible={false}
            importantForAccessibility="no"
            style={{
                width: 6,
                height: 6,
                borderRadius: shape === 'circle' ? 3 : 1.5,
                backgroundColor: filled ? color : 'transparent',
                borderWidth: filled ? 0 : 1.25,
                borderColor: color,
            }}
        />
    );
}

export const CodelyncProjectStatusView = React.memo(({ activity }: { activity: CodelyncProjectActivity }) => {
    const { theme } = useUnistyles();
    const color = theme.colors.textSecondary;
    if (activity.status !== 'ready' && !(activity.status === 'refreshing' && activity.observedAt > 0 && activity.total > 0)) {
        const label = activity.status === 'refreshing' ? t('codelyncProjects.refreshing') : activity.status === 'stale' ? t('codelyncProjects.stale') : t('codelyncProjects.unavailable');
        const indicatorColor = activity.status === 'refreshing' ? theme.colors.textLink : color;
        return (
            <View
                accessible
                accessibilityRole="text"
                accessibilityLabel={label}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 }}
            >
                <StatusGlyph shape={activity.status === 'stale' ? 'square' : 'circle'} filled={false} color={indicatorColor} />
                <Text style={{ fontSize: 12, color, flexShrink: 1 }}>{label}</Text>
            </View>
        );
    }
    const activeLabel = t('codelyncProjects.active', { count: activity.active });
    const waitingLabel = t('codelyncProjects.waiting', { count: activity.waiting });
    const unknownLabel = activity.unknown > 0 ? t('codelyncProjects.unknown', { count: activity.unknown }) : null;
    const refreshingLabel = activity.status === 'refreshing' ? t('codelyncProjects.refreshing') : null;
    const summaryLabel = [activeLabel, waitingLabel, unknownLabel, refreshingLabel].filter(Boolean).join(', ');
    const activeAccent = theme.colors.success ?? theme.colors.text;

    return <View
        style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 5 }}
        testID="codelync-project-status"
        accessible
        accessibilityRole="text"
        accessibilityLabel={summaryLabel}
    >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <StatusGlyph shape="circle" filled={activity.active > 0} color={activity.active > 0 ? activeAccent : color} />
            <Text style={{ fontSize: 12, color: activity.active > 0 ? theme.colors.text : color, fontWeight: activity.active > 0 ? '600' : '400' }}>{activeLabel}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <StatusGlyph shape="square" filled={activity.waiting > 0} color={activity.waiting > 0 ? theme.colors.textLink : color} />
            <Text style={{ fontSize: 12, color: activity.waiting ? theme.colors.textLink : color, fontWeight: activity.waiting ? '600' : '400' }}>{waitingLabel}</Text>
        </View>
        {unknownLabel ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <StatusGlyph shape="circle" filled={false} color={color} />
            <Text style={{ fontSize: 12, color }}>{unknownLabel}</Text>
        </View> : null}
        {refreshingLabel ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <StatusGlyph shape="circle" filled={false} color={theme.colors.textLink} />
            <Text style={{ fontSize: 12, color }}>{refreshingLabel}</Text>
        </View> : null}
    </View>;
});
