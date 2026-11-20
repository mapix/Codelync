import React, { useEffect, useRef, useState } from 'react';
import * as ReactNative from 'react-native';
import {
    View,
    Modal,
    TouchableWithoutFeedback,
    Animated,
    StyleSheet,
    KeyboardAvoidingView,
    Platform
} from 'react-native';
import { AnimatedBlurBackdrop } from '@/components/AnimatedOverlay';

// On web, stop events from propagating to expo-router's modal overlay
// which intercepts clicks when it applies pointer-events: none to body
const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();
const webEventHandlers = Platform.OS === 'web'
    ? { onClick: stopPropagation, onPointerDown: stopPropagation, onTouchStart: stopPropagation }
    : {};

interface BaseModalProps {
    visible: boolean;
    onClose?: () => void;
    children: React.ReactNode;
    animationType?: 'fade' | 'slide' | 'none';
    transparent?: boolean;
    closeOnBackdrop?: boolean;
}

export function BaseModal({
    visible,
    onClose,
    children,
    animationType = 'fade',
    transparent = true,
    closeOnBackdrop = true
}: BaseModalProps) {
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const [androidImeHeight, setAndroidImeHeight] = useState(0);

    useEffect(() => {
        if (!visible || Platform.OS !== 'android') {
            setAndroidImeHeight(0);
            return;
        }
        const rn = ReactNative as Record<string, any>;
        const keyboard = rn.Keyboard;
        if (typeof keyboard?.addListener !== 'function') return;
        const onShow = keyboard.addListener('keyboardDidShow', (event: { endCoordinates?: { height?: number; screenY?: number } }) => {
            const height = Math.max(0, event?.endCoordinates?.height ?? 0);
            const screenHeight = rn.Dimensions?.get?.('screen')?.height;
            const screenY = event?.endCoordinates?.screenY;
            const overlap = typeof screenY === 'number' && typeof screenHeight === 'number' && screenHeight > 0 && screenY >= 0 && screenY <= screenHeight
                ? Math.max(height, screenHeight - screenY)
                : height;
            setAndroidImeHeight(overlap);
        });
        const onHide = keyboard.addListener('keyboardDidHide', () => {
            setAndroidImeHeight(0);
        });
        return () => {
            onShow?.remove?.();
            onHide?.remove?.();
        };
    }, [visible]);

    useEffect(() => {
        if (visible) {
            Animated.timing(fadeAnim, {
                toValue: 1,
                duration: 200,
                useNativeDriver: true
            }).start();
        } else {
            Animated.timing(fadeAnim, {
                toValue: 0,
                duration: 200,
                useNativeDriver: true
            }).start();
        }
    }, [visible, fadeAnim]);

    const handleBackdropPress = () => {
        if (closeOnBackdrop && onClose) {
            onClose();
        }
    };

    return (
        <Modal
            visible={visible}
            transparent={transparent}
            animationType={animationType}
            statusBarTranslucent
            navigationBarTranslucent
            onRequestClose={onClose}
        >
            <KeyboardAvoidingView
                style={[
                    styles.container,
                    Platform.OS === 'android' && androidImeHeight > 0 ? { paddingBottom: androidImeHeight } : null,
                ]}
                // Edge-to-edge Android modals use SOFT_INPUT_ADJUST_NOTHING under
                // KeyboardProvider, so pad explicitly for the active IME height.
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                {...webEventHandlers}
            >
                {Platform.OS === 'web' ? (
                    <TouchableWithoutFeedback onPress={handleBackdropPress}>
                        <Animated.View
                            style={[
                                styles.backdrop,
                                {
                                    opacity: fadeAnim.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [0, 0.5],
                                    }),
                                },
                            ]}
                        />
                    </TouchableWithoutFeedback>
                ) : (
                    <AnimatedBlurBackdrop
                        blurIntensity={44}
                        dimColor="rgba(0, 0, 0, 0.42)"
                        onPress={handleBackdropPress}
                    />
                )}
                
                <Animated.View
                    style={[
                        styles.content,
                        {
                            opacity: fadeAnim,
                            transform: [{
                                scale: fadeAnim.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0.9, 1]
                                })
                            }]
                        }
                    ]}
                >
                    {children}
                </Animated.View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        // On web, ensure modal can receive pointer events when body has pointer-events: none
        ...Platform.select({ web: { pointerEvents: 'auto' as const } })
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'black',
    },
    content: {
        zIndex: 1
    }
});
