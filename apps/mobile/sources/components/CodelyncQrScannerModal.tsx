import * as React from 'react';
import { BackHandler, Platform, Pressable, StatusBar, StyleSheet as RNStyleSheet, Text, View } from 'react-native';
import { CameraView, type BarcodeScanningResult } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { hapticsLight } from './haptics';

export interface CodelyncQrScannerModalProps {
    visible: boolean;
    onClose: () => void;
    onScanned: (url: string) => void;
    onPasteLink: () => void;
}

const FRAME_SIZE = 240;

export const CodelyncQrScannerModal = React.memo(function CodelyncQrScannerModal({
    visible,
    onClose,
    onScanned,
    onPasteLink,
}: CodelyncQrScannerModalProps) {
    const insets = useSafeAreaInsets();
    const handledRef = React.useRef(false);
    const invalidTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const [mountFailed, setMountFailed] = React.useState(false);
    const [invalidHint, setInvalidHint] = React.useState(false);

    const clearInvalidTimer = React.useCallback(() => {
        if (invalidTimerRef.current) {
            clearTimeout(invalidTimerRef.current);
            invalidTimerRef.current = null;
        }
    }, []);

    React.useEffect(() => {
        if (!visible) {
            clearInvalidTimer();
            handledRef.current = false;
            return;
        }
        handledRef.current = false;
        setMountFailed(false);
        setInvalidHint(false);
        return clearInvalidTimer;
    }, [clearInvalidTimer, visible]);

    React.useEffect(() => {
        if (!visible || Platform.OS === 'web') return;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => subscription.remove();
    }, [onClose, visible]);

    const handleBarcodeScanned = React.useCallback((event: BarcodeScanningResult) => {
        if (handledRef.current) return;
        const value = typeof event?.data === 'string' ? event.data.trim() : '';
        if (!value) return;
        if (!value.startsWith('codelync://pair?')) {
            setInvalidHint(true);
            clearInvalidTimer();
            invalidTimerRef.current = setTimeout(() => {
                invalidTimerRef.current = null;
                setInvalidHint(false);
            }, 2500);
            return;
        }
        handledRef.current = true;
        clearInvalidTimer();
        setInvalidHint(false);
        if (Platform.OS !== 'web') {
            void hapticsLight();
        }
        onScanned(value);
    }, [clearInvalidTimer, onScanned]);

    if (!visible) {
        return null;
    }

    const hintText = mountFailed || Platform.OS === 'web'
        ? t('onboarding.pasteLinkMessage')
        : invalidHint
            ? t('codelyncPairing.invalid')
            : t('onboarding.openBody');

    return (
        <View testID="codelync-qr-scanner-modal" accessibilityViewIsModal style={styles.overlay}>
            <StatusBar barStyle="light-content" />
            {Platform.OS !== 'web' && !mountFailed ? (
                <CameraView
                    testID="codelync-qr-camera-view"
                    style={RNStyleSheet.absoluteFillObject}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={handleBarcodeScanned}
                    onMountError={() => setMountFailed(true)}
                />
            ) : null}
            <View pointerEvents="box-none" style={styles.backdrop}>
                <View style={[styles.header, { paddingTop: (insets.top ?? 0) + 12 }]}>
                    <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>
                        {t('onboarding.scanStep')}
                    </Text>
                    <Pressable
                        testID="codelync-qr-scanner-close"
                        accessibilityRole="button"
                        accessibilityLabel={t('common.cancel')}
                        hitSlop={8}
                        onPress={onClose}
                        style={({ pressed }) => [styles.closeButton, pressed && styles.buttonPressed]}
                    >
                        <Ionicons name="close" size={24} color="#FFFFFF" />
                    </Pressable>
                </View>

                <View pointerEvents="none" style={styles.center}>
                    <View style={[styles.frame, invalidHint && styles.frameError]} />
                    <Text accessibilityLiveRegion="polite" style={[styles.hint, invalidHint && styles.hintError]}>
                        {hintText}
                    </Text>
                </View>

                <View style={[styles.footer, { paddingBottom: (insets.bottom || 16) + 16 }]}>
                    <Pressable
                        testID="codelync-qr-scanner-paste"
                        accessibilityRole="button"
                        accessibilityLabel={t('onboarding.pasteLink')}
                        onPress={onPasteLink}
                        style={({ pressed }) => [styles.pasteButton, pressed && styles.buttonPressed]}
                    >
                        <Ionicons name="link-outline" size={18} color="#FFFFFF" />
                        <Text style={styles.pasteText} numberOfLines={1}>
                            {t('onboarding.pasteLink')}
                        </Text>
                    </Pressable>
                </View>
            </View>
        </View>
    );
});

const styles = RNStyleSheet.create({
    overlay: {
        ...RNStyleSheet.absoluteFillObject,
        zIndex: 9999,
        elevation: 9999,
        backgroundColor: '#000000',
    },
    backdrop: {
        flex: 1,
        justifyContent: 'space-between',
        backgroundColor: 'rgba(0, 0, 0, 0.28)',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        gap: 12,
    },
    title: {
        flex: 1,
        minWidth: 0,
        fontSize: 20,
        lineHeight: 26,
        color: '#FFFFFF',
        ...Typography.default('semiBold'),
    },
    closeButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.52)',
    },
    center: {
        alignItems: 'center',
        paddingHorizontal: 32,
        gap: 24,
    },
    frame: {
        width: FRAME_SIZE,
        height: FRAME_SIZE,
        borderRadius: 24,
        borderWidth: 2,
        borderColor: 'rgba(255, 255, 255, 0.85)',
        backgroundColor: 'transparent',
    },
    frameError: {
        borderColor: '#FF6B6B',
    },
    hint: {
        maxWidth: 320,
        textAlign: 'center',
        fontSize: 15,
        lineHeight: 21,
        color: '#FFFFFF',
        textShadowColor: 'rgba(0, 0, 0, 0.6)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
        ...Typography.default(),
    },
    hintError: {
        color: '#FFD1D1',
    },
    footer: {
        alignItems: 'center',
        paddingHorizontal: 24,
    },
    pasteButton: {
        minHeight: 48,
        paddingHorizontal: 20,
        borderRadius: 24,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: 'rgba(0, 0, 0, 0.62)',
        borderWidth: RNStyleSheet.hairlineWidth,
        borderColor: 'rgba(255, 255, 255, 0.28)',
    },
    buttonPressed: {
        opacity: 0.72,
    },
    pasteText: {
        flexShrink: 1,
        fontSize: 15,
        lineHeight: 20,
        color: '#FFFFFF',
        ...Typography.default('semiBold'),
    },
});
