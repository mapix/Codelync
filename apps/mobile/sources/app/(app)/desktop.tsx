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
    const [orientationMode, setOrientationMode] = React.useState<'portrait' | 'landscape'>('landscape');
    const paired = auth.isAuthenticated && !!auth.credentials?.peer;
    React.useEffect(() => {
        if (!enabled || !paired) setOrientationMode('landscape');
    }, [enabled, paired]);
    if (!enabled) return <><Stack.Screen options={{ headerShown: false, statusBarHidden: false, orientation: 'portrait' }} /><Redirect href="/settings" /></>;
    // Native navigation owns orientation; leaving the page restores portrait
    // without introducing an independent orientation lock or replacing video.
    return <><Stack.Screen options={{
        headerShown: false,
        statusBarHidden: paired && focused && orientationMode === 'landscape',
        orientation: paired && focused ? orientationMode : 'portrait',
        gestureEnabled: false,
        fullScreenGestureEnabled: false,
    }} />
        {paired ? <RemoteDesktopView focused={focused} onOrientationModeChange={setOrientationMode} /> : <CodelyncScanScreen />}
    </>;
}
