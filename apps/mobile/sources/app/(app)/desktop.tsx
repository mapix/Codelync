import * as React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { useAuth } from '@/auth/AuthContext';
import { CodelyncScanScreen } from '@/components/onboarding/CodelyncScanScreen';
import { RemoteDesktopView } from '@/components/RemoteDesktopView';
import { useLocalSetting } from '@/sync/storage';

export default function DesktopScreen() {
    const auth = useAuth(), focused = useIsFocused();
    const enabled = useLocalSetting('remoteDesktopEnabled');
    if (!enabled) return <><Stack.Screen options={{ headerShown: false, statusBarHidden: false, orientation: 'portrait' }} /><Redirect href="/settings" /></>;
    const paired = auth.isAuthenticated && !!auth.credentials?.peer;
    // Native navigation owns orientation; leaving the page restores portrait
    // without introducing an independent orientation lock or replacing video.
    return <><Stack.Screen options={{ headerShown: false, statusBarHidden: paired && focused, orientation: paired && focused ? 'landscape' : 'portrait',
        gestureEnabled: false, fullScreenGestureEnabled: false }} />
        {paired ? <RemoteDesktopView /> : <CodelyncScanScreen />}
    </>;
}
