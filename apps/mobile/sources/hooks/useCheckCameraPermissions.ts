import * as React from 'react';
import { Camera } from 'expo-camera';
import { Platform } from 'react-native';

export async function checkScannerPermissionsAsync(): Promise<boolean> {
    if (Platform.OS === 'web') {
        return false;
    }

    const current = await Camera.getCameraPermissionsAsync();
    if (current.granted) {
        return true;
    }

    if (current.canAskAgain !== false) {
        const requested = await Camera.requestCameraPermissionsAsync();
        return Boolean(requested?.granted);
    }

    return false;
}

export function useCheckScannerPermissions(): () => Promise<boolean> {
    return React.useCallback(checkScannerPermissionsAsync, []);
}
