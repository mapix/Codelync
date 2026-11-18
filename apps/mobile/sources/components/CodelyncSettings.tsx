import * as React from 'react';
import { useRouter } from 'expo-router';
import * as Application from 'expo-application';
import * as Localization from 'expo-localization';
import Constants from 'expo-constants';
import { useCodelyncPairing } from '@/auth/CodelyncPairingProvider';
import { useLocalSettingMutable, useSetting } from '@/sync/storage';
import { getConnectionSnapshot, subscribeConnection, selectConnection } from '@/sync/codelyncConnection';
import { applyAppThemePreference } from '@/utils/appThemePreference';
import { resolveLanguage, resolvePreferredLanguage } from '@/text/resolveLanguage';
import { getLanguageNativeName, t } from '@/text';
import { CodelyncSettingsView } from './CodelyncSettingsView';
import { codelyncTopLevelRoute } from './CodelyncBottomNavigation';

/** Global app preferences subscribe to existing owners; mounting this page never selects a route or chat. */
export const CodelyncSettings = React.memo(function CodelyncSettings() {
    const router = useRouter(), pairing = useCodelyncPairing();
    const snapshot = React.useSyncExternalStore(subscribeConnection, getConnectionSnapshot);
    const [themePreference, setThemePreference] = useLocalSettingMutable('themePreference');
    const [remoteDesktopEnabled, setRemoteDesktopEnabled] = useLocalSettingMutable('remoteDesktopEnabled');
    const preferredLanguage = useSetting('preferredLanguage');
    const language = resolvePreferredLanguage(preferredLanguage);
    const detectedLanguage = resolveLanguage(null, Localization.getLocales());
    const languageLabel = language ? getLanguageNativeName(language) : `${t('settingsLanguage.automatic')} · ${getLanguageNativeName(detectedLanguage)}`;
    const version = [Application.nativeApplicationVersion || Constants.expoConfig?.version, Application.nativeBuildVersion].filter(Boolean).join(' · ');
    return <CodelyncSettingsView snapshot={snapshot} themePreference={themePreference} languageLabel={languageLabel} version={version}
        remoteDesktopEnabled={remoteDesktopEnabled} onRemoteDesktopChange={setRemoteDesktopEnabled}
        scanBusy={Boolean(pairing.busy)}
        onSelectConnection={selectConnection} onScan={() => { void pairing.scan(); }} onLanguage={() => router.push('/settings/language')}
        onNavigate={page => router.navigate(codelyncTopLevelRoute(page))}
        onThemeChange={preference => { setThemePreference(preference); applyAppThemePreference(preference); }} />;
});
