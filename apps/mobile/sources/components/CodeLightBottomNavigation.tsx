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

export type CodeLightTopLevelPage = 'sessions' | 'desktop' | 'settings';
export function codeLightTopLevelRoute(page: CodeLightTopLevelPage) { return page === 'sessions' ? '/' : page === 'desktop' ? '/desktop' : '/settings'; }
export function CodeLightBottomNavigationView({ active, onNavigate }: { active: CodeLightTopLevelPage; onNavigate: (page: CodeLightTopLevelPage) => void }) {
    const { theme } = useUnistyles(), insets = useSafeAreaInsets();
    return <View accessibilityRole="tablist" style={[styles.root, { paddingBottom: Math.max(8, insets.bottom) }]}>
        {(['sessions', 'desktop', 'settings'] as const).map(page => <Pressable key={page} testID={`codelight-tab-${page}`} accessibilityRole="tab"
            accessibilityState={{ selected: active === page }} accessibilityLabel={page === 'desktop' ? remoteDesktopLabels().title : t(`tabs.${page}`)}
            onPress={() => { if (page !== active) onNavigate(page); }} style={({ pressed }) => [styles.tab, pressed && styles.pressed]}>
            <Ionicons name={page === 'sessions' ? (active === page ? 'chatbubbles' : 'chatbubbles-outline') : page === 'desktop' ? (active === page ? 'desktop' : 'desktop-outline') : (active === page ? 'settings' : 'settings-outline')}
                size={23} color={active === page ? theme.colors.textLink : theme.colors.textSecondary} />
            <Text style={[styles.label, { color: active === page ? theme.colors.textLink : theme.colors.textSecondary }]}>{page === 'desktop' ? remoteDesktopLabels().title : t(`tabs.${page}`)}</Text>
        </Pressable>)}
    </View>;
}

export const CodeLightBottomNavigation = React.memo(function CodeLightBottomNavigation({ active }: { active: CodeLightTopLevelPage }) {
    const router = useRouter();
    // 复用已有顶层页面，不能用 replace 重建会话列表而丢掉搜索、展开和滚动位置。
    return <CodeLightBottomNavigationView active={active} onNavigate={page => router.navigate(codeLightTopLevelRoute(page))} />;
});

const styles = StyleSheet.create(theme => ({
    root: { flexDirection: 'row', justifyContent: 'center', paddingTop: 6, backgroundColor: theme.colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
    tab: { flex: 1, maxWidth: 240, minHeight: 52, alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 10 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    label: { fontSize: 12, lineHeight: 16, ...Typography.default('semiBold') },
}));
