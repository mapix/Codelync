import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as FileSystem from 'expo-file-system/legacy';
import { TokenStorage } from '@/auth/tokenStorage';
import { bootstrapMacDiagnostics } from './bootstrapMacDiagnostics';
import { consumeStartupMacLocator, STARTUP_MAC_LOCATOR_MAX_BYTES } from './startupMacLocatorCore';

/** A fixed sandbox file, consumed once by the existing startup owner. */
export async function consumeNativeStartupMacLocator(): Promise<boolean> {
    const eligible = (Platform.OS === 'ios' || Platform.OS === 'android') && Application.applicationId === 'com.learnings.codelync';
    if (!eligible || !FileSystem.documentDirectory) return false;
    const path = FileSystem.documentDirectory + 'codelync-mac-locator.json';
    return consumeStartupMacLocator({ eligible, now: Date.now, credentials: () => TokenStorage.getCredentials(),
        read: async () => {
            const file = await FileSystem.getInfoAsync(path);
            if (!file.exists || file.isDirectory || file.size > STARTUP_MAC_LOCATOR_MAX_BYTES) return null;
            return FileSystem.readAsStringAsync(path);
        }, remove: () => FileSystem.deleteAsync(path, { idempotent: true }),
        bootstrap: (origins, expectedPeerId) => bootstrapMacDiagnostics(origins, { expectedPeerId }) });
}
