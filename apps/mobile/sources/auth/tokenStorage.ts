import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';
import { getServerUrl } from '@/sync/serverConfig';
import { config } from '@/config';
import { clearCodeLightBackgroundCache } from '@/sync/codeLightBackgroundCache';
import type { PeerCredentials } from '@slopus/happy-wire/codelight';

const AUTH_KEY = 'auth_credentials';

// Cache for synchronous access
let credentialsCache: string | null = null;
let backgroundAccessibilityMigrated = false;

export interface AuthCredentials {
    token: string;
    secret: string;
    serverUrl?: string;
    peer?: PeerCredentials;
}

export type CredentialRead = { status: 'available'; credentials: AuthCredentials }
    | { status: 'missing' | 'unavailable'; credentials: null };

export const TokenStorage = {
    async readCredentials(): Promise<CredentialRead> {
      try {
        if (Platform.OS === 'web') {
            const value = localStorage.getItem(AUTH_KEY);
            if (!value) return { status: 'missing', credentials: null };
            const credentials = JSON.parse(value) as AuthCredentials;
            if (credentials.serverUrl && credentials.serverUrl !== getServerUrl() && !credentials.peer?.channels.some(channel => channel.url === getServerUrl())) return { status: 'missing', credentials: null };
            return { status: 'available', credentials: { ...credentials, serverUrl: getServerUrl() } };
        }
            const stored = await SecureStore.getItemAsync(AUTH_KEY);
            if (!stored) return { status: 'missing', credentials: null };
            credentialsCache = stored; // Update cache
            const credentials = JSON.parse(stored) as AuthCredentials;
            if (credentials.serverUrl && credentials.serverUrl !== getServerUrl() && !credentials.peer?.channels.some(channel => channel.url === getServerUrl())) return { status: 'missing', credentials: null };
            if (config.noninvasiveLocal && Platform.OS === 'ios' && !backgroundAccessibilityMigrated && AppState.currentState === 'active') {
                // iOS 锁屏后台刷新仍需要鉴权；仅设备本地、首次解锁后可读，不将 secret 写入普通缓存。
                await SecureStore.setItemAsync(AUTH_KEY, stored, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
                backgroundAccessibilityMigrated = true;
            }
            return { status: 'available', credentials: { ...credentials, serverUrl: getServerUrl() } };
      } catch {
            // No credential values or native storage error payloads are logged.
            return { status: 'unavailable', credentials: null };
      }
    },

    async getCredentials(): Promise<AuthCredentials | null> {
        return (await TokenStorage.readCredentials()).credentials;
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        const scoped = { ...credentials, serverUrl: credentials.serverUrl ?? getServerUrl() };
        if (Platform.OS === 'web') {
            localStorage.setItem(AUTH_KEY, JSON.stringify(scoped));
            return true;
        }
        try {
            const json = JSON.stringify(scoped);
            await SecureStore.setItemAsync(AUTH_KEY, json, config.noninvasiveLocal ? { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY } : undefined);
            credentialsCache = json; // Update cache
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(): Promise<boolean> {
        if (config.noninvasiveLocal) clearCodeLightBackgroundCache();
        if (Platform.OS === 'web') {    
            localStorage.removeItem(AUTH_KEY);
            return true;
        }
        try {
            await SecureStore.deleteItemAsync(AUTH_KEY);
            credentialsCache = null; // Clear cache
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    },
};
