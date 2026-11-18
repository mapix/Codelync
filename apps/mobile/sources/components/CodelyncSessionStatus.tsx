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

function SessionStatusGlyph({ shape, filled, color }: { shape: 'circle' | 'square'; filled: boolean; color: string }) {
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

export const CodelyncSessionStatusView = React.memo(({ activity }: { activity: CodelyncSessionActivity }) => {
    const { theme } = useUnistyles();
    const color = theme.colors.textSecondary;
    if (!activity.known || activity.status !== 'ready') {
        const unknownLabel = t('codelyncSessionStatus.unknown');
        return (
            <View
                accessible
                accessibilityRole="text"
                accessibilityLabel={unknownLabel}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 }}
            >
                <SessionStatusGlyph shape="circle" filled={false} color={color} />
                <Text style={{ fontSize: 12, color, flexShrink: 1 }}>{unknownLabel}</Text>
            </View>
        );
    }
    const activeLabel = activity.active ? t('codelyncSessionStatus.active') : null;
    const waitingLabel = activity.waiting ? t('codelyncSessionStatus.waiting') : null;
    const idleLabel = !activity.active && !activity.waiting ? t('codelyncSessionStatus.idle') : null;
    const summaryLabel = [activeLabel, waitingLabel, idleLabel].filter(Boolean).join(', ');
    const activeAccent = theme.colors.success ?? theme.colors.text;

    return <View
        style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 5 }}
        testID="codelync-session-status"
        accessible
        accessibilityRole="text"
        accessibilityLabel={summaryLabel}
    >
        {activeLabel ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <SessionStatusGlyph shape="circle" filled color={activeAccent} />
            <Text style={{ fontSize: 12, color: theme.colors.text, fontWeight: '600' }}>{activeLabel}</Text>
        </View> : null}
        {waitingLabel ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <SessionStatusGlyph shape="square" filled color={theme.colors.textLink} />
            <Text style={{ fontSize: 12, color: theme.colors.textLink, fontWeight: '600' }}>{waitingLabel}</Text>
        </View> : null}
        {idleLabel ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <SessionStatusGlyph shape="circle" filled={false} color={color} />
            <Text style={{ fontSize: 12, color }}>{idleLabel}</Text>
        </View> : null}
    </View>;
});
