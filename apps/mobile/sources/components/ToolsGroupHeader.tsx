import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import type { ToolsGroupItem } from '@/hooks/useGroupedMessages';
import type { Metadata } from '@/sync/storageTypes';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { getCurrentLanguage } from '@/text';
import { codeLightToolGroupLabels, formatToolGroupTimestamp } from '@/text/codeLightToolGroupLabels';
import { layout } from './layout';

/** Native observation/index times never stand in for the original tool time. */
export function latestToolGroupTimestamp(messages: readonly ToolCallMessage[], nativeSession: boolean): number | null {
    let latest: number | null = null;
    for (const message of messages) {
        const native = nativeSession || !!message.meta?.nativeRow || message.meta?.nativeTimestamp !== undefined;
        const values = native ? [message.meta?.nativeTimestamp] : [message.tool.completedAt, message.tool.startedAt, message.tool.createdAt, message.createdAt];
        for (const value of values) {
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isFinite(new Date(value).getTime())) latest = Math.max(latest ?? value, value);
        }
    }
    return latest;
}

/** Summary only. Detail messages are separate virtualized ChatList rows. */
export const ToolsGroupHeader = React.memo((props: {
    group: ToolsGroupItem;
    metadata: Metadata | null;
    expanded: boolean;
    onToggle: () => void;
    placement?: 'leading' | 'trailing';
}) => {
    const { theme } = useUnistyles();
    const language = getCurrentLanguage();
    const label = codeLightToolGroupLabels[language](props.group.messages.length);
    const nativeSession = props.metadata?.client?.id === 'noninvasive-bridge';
    const time = formatToolGroupTimestamp(latestToolGroupTimestamp(props.group.messages, nativeSession), language);
    return (
        <View style={styles.outer}>
            <View style={styles.inner}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${label}, ${time}`}
                    accessibilityState={{ expanded: props.expanded }}
                    testID={`codelight-tools-group:${props.group.id}`}
                    onPress={props.onToggle}
                    style={({ pressed }) => [styles.header, pressed && styles.pressed]}
                >
                    <Text numberOfLines={1} style={styles.count}>{label}</Text>
                    <Text numberOfLines={1} style={styles.time}>{time}</Text>
                    <Ionicons name={props.expanded ? 'chevron-up' : 'chevron-forward'} size={13} color={theme.colors.textSecondary} />
                </Pressable>
            </View>
        </View>
    );
});

const styles = StyleSheet.create(theme => ({
    outer: { flexDirection: 'row', justifyContent: 'center' },
    inner: { flexGrow: 1, flexBasis: 0, minWidth: 0, maxWidth: layout.maxWidth, marginVertical: 4 },
    header: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 8, marginHorizontal: 16,
        paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.divider },
    count: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 20, color: theme.colors.textSecondary },
    time: { flexShrink: 1, fontSize: 12, lineHeight: 20, color: theme.colors.textSecondary, fontVariant: ['tabular-nums'] },
    pressed: { opacity: 0.6 },
}));
