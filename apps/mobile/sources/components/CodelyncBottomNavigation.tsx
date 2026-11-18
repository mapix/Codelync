import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Text } from './StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { remoteDesktopLabels } from '@/text/remoteDesktopLabels';
import { useLocalSetting } from '@/sync/storage';

export type CodelyncTopLevelPage = 'sessions' | 'desktop' | 'settings';
export function codelyncTopLevelRoute(page: CodelyncTopLevelPage) { return page === 'sessions' ? '/' : page === 'desktop' ? '/desktop' : '/settings'; }
export function CodelyncBottomNavigationView({ active, onNavigate, remoteDesktopEnabled = false }: { active: CodelyncTopLevelPage; onNavigate: (page: CodelyncTopLevelPage) => void; remoteDesktopEnabled?: boolean }) {
    const { theme } = useUnistyles(), insets = useSafeAreaInsets();
    const desktopTitle = remoteDesktopLabels().title;
    return <View accessibilityRole="tablist" style={[styles.root, {
        paddingLeft: Math.max(8, insets.left ?? 0),
        paddingRight: Math.max(8, insets.right ?? 0),
        paddingBottom: Math.max(8, insets.bottom ?? 0),
    }]}>
        {(remoteDesktopEnabled ? ['sessions', 'desktop', 'settings'] as const : ['sessions', 'settings'] as const).map(page => {
            const label = page === 'desktop' ? desktopTitle : t(`tabs.${page}`);
            return <Pressable key={page} testID={`codelync-tab-${page}`} accessibilityRole="tab"
                accessibilityState={{ selected: active === page }} accessibilityLabel={label}
                onPress={() => { if (page !== active) onNavigate(page); }} style={({ pressed }) => [styles.tab, pressed && styles.pressed]}>
                <Ionicons name={page === 'sessions' ? (active === page ? 'chatbubbles' : 'chatbubbles-outline') : page === 'desktop' ? (active === page ? 'desktop' : 'desktop-outline') : (active === page ? 'settings' : 'settings-outline')}
                    size={23} color={active === page ? theme.colors.textLink : theme.colors.textSecondary} />
                <Text numberOfLines={1} ellipsizeMode="tail" adjustsFontSizeToFit minimumFontScale={0.85}
                    style={[styles.label, { color: active === page ? theme.colors.textLink : theme.colors.textSecondary }]}>{label}</Text>
            </Pressable>;
        })}
    </View>;
}

export const CodelyncBottomNavigation = React.memo(function CodelyncBottomNavigation({ active }: { active: CodelyncTopLevelPage }) {
    const router = useRouter();
    const remoteDesktopEnabled = useLocalSetting('remoteDesktopEnabled');
    // 复用已有顶层页面，不能用 replace 重建会话列表而丢掉搜索、展开和滚动位置。
    return <CodelyncBottomNavigationView active={active} remoteDesktopEnabled={remoteDesktopEnabled} onNavigate={page => router.navigate(codelyncTopLevelRoute(page))} />;
});

const styles = StyleSheet.create(theme => ({
    root: { flexDirection: 'row', justifyContent: 'center', paddingTop: 6, backgroundColor: theme.colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
    tab: { flex: 1, minWidth: 0, maxWidth: 240, minHeight: 52, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 10 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    label: { fontSize: 12, lineHeight: 16, textAlign: 'center', ...Typography.default('semiBold') },
}));
