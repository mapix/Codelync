import * as React from 'react';
import { Stack } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useAuth } from '@/auth/AuthContext';
import { CodeLightScanScreen } from '@/components/onboarding/CodeLightScanScreen';
import { RemoteDesktopView } from '@/components/RemoteDesktopView';

export default function DesktopScreen() {
    const auth = useAuth(), focused = useIsFocused();
    const paired = auth.isAuthenticated && !!auth.credentials?.peer;
    // Native navigation owns orientation; leaving the page restores portrait
    // without introducing an independent orientation lock or replacing video.
    return <><Stack.Screen options={{ headerShown: false, statusBarHidden: paired && focused, orientation: paired && focused ? 'landscape' : 'portrait',
        gestureEnabled: false, fullScreenGestureEnabled: false }} />
        {paired ? <RemoteDesktopView /> : <CodeLightScanScreen />}
    </>;
}
