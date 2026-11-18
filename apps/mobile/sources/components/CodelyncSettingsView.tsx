import * as React from 'react';
import { ScrollView, Switch, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './StyledText';
import { Item } from './Item';
import { ItemGroup } from './ItemGroup';
import { CodelyncMark } from './CodelyncMark';
import { PeerChannelControlView, type PeerChannelSnapshot } from './PeerChannelControlView';
import { PickerSheet, PickerSheetOption } from './PickerSheet';
import { CodelyncBottomNavigationView, type CodelyncTopLevelPage } from './CodelyncBottomNavigation';
import { Typography } from '@/constants/Typography';
import type { AppThemePreference } from '@/utils/appThemePreference';
import { t } from '@/text';
import { remoteDesktopLabels } from '@/text/remoteDesktopLabels';

export interface CodelyncSettingsViewProps {
    snapshot: PeerChannelSnapshot;
    themePreference: AppThemePreference;
    languageLabel: string;
    version: string;
    remoteDesktopEnabled: boolean;
    scanBusy?: boolean;
    onRemoteDesktopChange: (enabled: boolean) => void;
    onSelectConnection: (id: string) => Promise<void>;
    onThemeChange: (preference: AppThemePreference) => void;
    onLanguage: () => void;
    onScan: () => void;
    onNavigate: (page: CodelyncTopLevelPage) => void;
}

export const CodelyncSettingsView = React.memo(function CodelyncSettingsView(props: CodelyncSettingsViewProps) {
    const { theme } = useUnistyles(), insets = useSafeAreaInsets();
    const [themeOpen, setThemeOpen] = React.useState(false);
    const desktopTitle = remoteDesktopLabels().title;
    const horizontalSafeArea = { paddingLeft: insets.left ?? 0, paddingRight: insets.right ?? 0 };
    return <View testID="codelync-settings-page" style={[styles.root, { paddingTop: insets.top ?? 0 }]}>
        <View style={[styles.header, horizontalSafeArea]}><Text accessibilityRole="header" style={styles.heading}>{t('settings.title')}</Text></View>
        <ScrollView style={styles.content} contentContainerStyle={[styles.scrollContent, horizontalSafeArea]} keyboardShouldPersistTaps="handled">
            <ItemGroup title={t('codelyncChannels.title')} headerStyle={styles.firstGroup}>
                <PeerChannelControlView snapshot={props.snapshot} onSelect={props.onSelectConnection} presentation="settings" onScan={props.onScan} />
                <Item title={t('onboarding.scanButton')} icon={<Ionicons name="qr-code-outline" size={25} color={theme.colors.textSecondary} />}
                    loading={props.scanBusy} disabled={props.scanBusy} onPress={props.onScan} />
            </ItemGroup>
            <ItemGroup title={t('settingsAppearance.display')}>
                <Item title={t('settings.appearance')} detail={t(`settingsAppearance.themeOptions.${props.themePreference}`)}
                    icon={<Ionicons name="contrast-outline" size={25} color={theme.colors.textSecondary} />} onPress={() => setThemeOpen(true)} />
                <Item title={t('settingsLanguage.title')} detail={props.languageLabel}
                    icon={<Ionicons name="language-outline" size={25} color={theme.colors.textSecondary} />} onPress={props.onLanguage} />
            </ItemGroup>
            <ItemGroup>
                <Item title={desktopTitle} icon={<Ionicons name="desktop-outline" size={25} color={theme.colors.textSecondary} />}
                    showChevron={false} rightElement={<Switch testID="codelync-remote-desktop-feature" accessibilityLabel={desktopTitle}
                        value={props.remoteDesktopEnabled} onValueChange={props.onRemoteDesktopChange} />} />
            </ItemGroup>
            <ItemGroup title={t('settings.about')} footer={t('settings.aboutFooter')}>
                <Item title="Codelync" titleStyle={styles.brand} detail={props.version} detailStyle={styles.version}
                    icon={<CodelyncMark size={29} />} showChevron={false} copy={props.version} />
            </ItemGroup>
        </ScrollView>
        <CodelyncBottomNavigationView active="settings" onNavigate={props.onNavigate} remoteDesktopEnabled={props.remoteDesktopEnabled} />
        <PickerSheet visible={themeOpen} title={t('settingsAppearance.theme')} onClose={() => setThemeOpen(false)}>
            {(['adaptive', 'light', 'dark'] as const).map(preference => <PickerSheetOption key={preference} testID={`codelync-theme-${preference}`}
                label={t(`settingsAppearance.themeOptions.${preference}`)} description={t(`settingsAppearance.themeDescriptions.${preference}`)}
                selected={props.themePreference === preference} onPress={() => { props.onThemeChange(preference); setThemeOpen(false); }} />)}
        </PickerSheet>
    </View>;
});

const styles = StyleSheet.create(theme => ({
    root: { flex: 1, backgroundColor: theme.colors.groupped.background },
    header: { paddingHorizontal: 20, paddingVertical: 16 },
    heading: { fontSize: 28, color: theme.colors.text, ...Typography.default('semiBold') },
    content: { flex: 1 }, scrollContent: { paddingBottom: 16 },
    firstGroup: { paddingTop: 6 },
    brand: { fontSize: 20, ...Typography.logo() },
    version: { fontSize: 11, ...Typography.mono() },
}));
