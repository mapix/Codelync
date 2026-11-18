import React from 'react';
import { Image, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { OnboardingScreen } from './OnboardingScreen';
import { OnboardingHeader } from './OnboardingHeader';
import { HappyEngineeringWordmark } from './HappyEngineeringWordmark';
import { RoundButton } from '../RoundButton';
import { useCodelyncPairing } from '@/auth/CodelyncPairingProvider';
import { Modal } from '@/modal';
import { t } from '@/text';

export const CodelyncScanScreen = React.memo(function CodelyncScanScreen() {
    const pairing = useCodelyncPairing();
    return <OnboardingScreen reserveContent={false} header={<OnboardingHeader />} content={<View style={styles.content}>
        <HappyEngineeringWordmark height={84} />
        <Image accessible={false} source={require('@/assets/images/codelync-connection.png')} resizeMode="contain" style={styles.connectionImage} />
        <Text accessibilityRole="header" style={styles.title}>{t('onboarding.linkTitle')}</Text>
        <Text style={styles.body}>{t('onboarding.openBody')}</Text>
        {pairing.error ? <Text style={styles.error} accessibilityLiveRegion="polite">{pairing.error}</Text> : null}
    </View>} primary={<RoundButton title={t('onboarding.scanButton')} loadingTitle={t('onboarding.linking')}
        loading={pairing.busy} disabled={pairing.busy} onPress={() => { void pairing.scan(); }} />}
        secondary={{ title: t('onboarding.pasteLink'), disabled: pairing.busy, action: async () => {
            const link = await Modal.prompt(t('onboarding.pasteLinkTitle'), t('onboarding.pasteLinkMessage'), { placeholder: 'codelync://pair?...', confirmText: t('onboarding.pasteLinkConfirm') });
            if (link?.trim()) await pairing.connect(link.trim()).catch(() => {});
        } }} />;
});
const styles = StyleSheet.create(theme => ({
    content: { width: '100%', minWidth: 0 },
    connectionImage: { width: 260, height: 98, maxWidth: '100%', marginTop: 18, borderRadius: 16, overflow: 'hidden' },
    title: { fontSize: 28, lineHeight: 34, fontWeight: '600', color: theme.colors.text, marginTop: 24 },
    body: { fontSize: 17, lineHeight: 24, color: theme.colors.textSecondary, marginTop: 12 },
    error: { fontSize: 15, color: theme.colors.warningCritical, marginTop: 16 },
}));
