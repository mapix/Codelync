import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';

const state = vi.hoisted(() => ({
    os: 'android' as 'android' | 'ios' | 'web',
    noninvasiveLocal: true,
    projectId: 'fixture-project-id' as string | null,
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
    getDevicePushTokenAsync: vi.fn(),
    openSettings: vi.fn(async () => {}),
    syncCodelyncPushToken: vi.fn(),
    loadRegisteredPushToken: vi.fn((): string | null => null),
    saveRegisteredPushToken: vi.fn(),
    clearRegisteredPushToken: vi.fn(),
    registerPushToken: vi.fn(async () => {}),
    unregisterPushToken: vi.fn(async () => {}),
}));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return state.os;
        },
    },
    Linking: {
        openSettings: state.openSettings,
    },
}));

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: state.getPermissionsAsync,
    requestPermissionsAsync: state.requestPermissionsAsync,
    getExpoPushTokenAsync: state.getExpoPushTokenAsync,
    getDevicePushTokenAsync: state.getDevicePushTokenAsync,
}));

vi.mock('expo-application', () => ({
    nativeApplicationVersion: '1.0.1',
    nativeBuildVersion: '2026111801',
}));

vi.mock('expo-constants', () => ({
    default: {
        get expoConfig() {
            return state.projectId ? { extra: { eas: { projectId: state.projectId } } } : {};
        },
        easConfig: null,
    },
}));

vi.mock('expo-device', () => ({
    deviceName: 'Pixel 7',
    modelName: 'Pixel 7',
    osName: 'Android',
    osVersion: '14',
    isDevice: true,
}));

vi.mock('@/config', () => ({
    config: {
        get noninvasiveLocal() {
            return state.noninvasiveLocal;
        },
    },
}));

vi.mock('./codelyncNotifications', () => ({
    syncCodelyncPushToken: state.syncCodelyncPushToken,
}));

vi.mock('./persistence', () => ({
    loadRegisteredPushToken: state.loadRegisteredPushToken,
    saveRegisteredPushToken: state.saveRegisteredPushToken,
    clearRegisteredPushToken: state.clearRegisteredPushToken,
}));

vi.mock('./apiPush', () => ({
    registerPushToken: state.registerPushToken,
    unregisterPushToken: state.unregisterPushToken,
}));

import {
    getCurrentExpoPushToken,
    getPushPermissionInfo,
    requestPushPermissionOrOpenSettings,
    syncCurrentPushToken,
} from './pushRegistration';

const credentials: AuthCredentials = {
    token: 'fixture-token',
    secret: 'fixture-secret',
    serverUrl: 'http://192.168.1.10:50256',
    peer: {
        id: 'f'.repeat(64),
        key: 'a'.repeat(43),
        channels: [{ id: 'local', kind: 'local', url: 'http://192.168.1.10:50256' }],
        device: { publicKey: 'b'.repeat(43), secretKey: 'c'.repeat(43) },
        automatic: true,
        selectedChannel: 'local',
    },
};

beforeEach(() => {
    vi.clearAllMocks();
    state.os = 'android';
    state.noninvasiveLocal = true;
    state.projectId = 'fixture-project-id';
    state.loadRegisteredPushToken.mockReturnValue(null);
});

describe('pushRegistration on push-free Codelync Android', () => {
    it('short-circuits syncCurrentPushToken with status unsupported and zero notification or device calls', async () => {
        const result = await syncCurrentPushToken(credentials);

        expect(result).toEqual({
            registered: false,
            token: null,
            permission: {
                status: 'unsupported',
                granted: false,
                canAskAgain: false,
            },
        });
        expect(state.getPermissionsAsync).not.toHaveBeenCalled();
        expect(state.requestPermissionsAsync).not.toHaveBeenCalled();
        expect(state.getExpoPushTokenAsync).not.toHaveBeenCalled();
        expect(state.getDevicePushTokenAsync).not.toHaveBeenCalled();
        expect(state.openSettings).not.toHaveBeenCalled();
        expect(state.syncCodelyncPushToken).not.toHaveBeenCalled();
        expect(state.registerPushToken).not.toHaveBeenCalled();
    });

    it('short-circuits getPushPermissionInfo, requestPushPermissionOrOpenSettings, and getCurrentExpoPushToken with zero native calls', async () => {
        await expect(getPushPermissionInfo()).resolves.toEqual({
            status: 'unsupported',
            granted: false,
            canAskAgain: false,
        });
        await expect(requestPushPermissionOrOpenSettings()).resolves.toEqual({
            granted: false,
            openedSettings: false,
            permission: {
                status: 'unsupported',
                granted: false,
                canAskAgain: false,
            },
        });
        await expect(getCurrentExpoPushToken()).resolves.toBeNull();

        expect(state.getPermissionsAsync).not.toHaveBeenCalled();
        expect(state.requestPermissionsAsync).not.toHaveBeenCalled();
        expect(state.getExpoPushTokenAsync).not.toHaveBeenCalled();
        expect(state.openSettings).not.toHaveBeenCalled();
        expect(state.loadRegisteredPushToken).not.toHaveBeenCalled();
    });
});

describe('pushRegistration on iOS and web', () => {
    it('preserves iOS Codelync APNs permission prompt and syncCodelyncPushToken registration', async () => {
        state.os = 'ios';
        state.noninvasiveLocal = true;
        state.getPermissionsAsync.mockResolvedValueOnce({
            status: 'undetermined',
            granted: false,
            canAskAgain: true,
        });
        state.requestPermissionsAsync.mockResolvedValueOnce({
            status: 'granted',
            granted: true,
            canAskAgain: true,
        });
        state.syncCodelyncPushToken.mockResolvedValueOnce('d'.repeat(64));

        const result = await syncCurrentPushToken(credentials);

        expect(state.getPermissionsAsync).toHaveBeenCalledOnce();
        expect(state.requestPermissionsAsync).toHaveBeenCalledOnce();
        expect(state.syncCodelyncPushToken).toHaveBeenCalledExactlyOnceWith(credentials, true);
        expect(result).toEqual({
            registered: true,
            token: 'd'.repeat(64),
            permission: {
                status: 'granted',
                granted: true,
                canAskAgain: true,
            },
        });
    });

    it('preserves iOS denied-permission device clearing through syncCodelyncPushToken(credentials, false)', async () => {
        state.os = 'ios';
        state.noninvasiveLocal = true;
        state.getPermissionsAsync.mockResolvedValueOnce({
            status: 'denied',
            granted: false,
            canAskAgain: false,
        });
        state.syncCodelyncPushToken.mockResolvedValueOnce(null);

        const result = await syncCurrentPushToken(credentials);

        expect(state.requestPermissionsAsync).not.toHaveBeenCalled();
        expect(state.syncCodelyncPushToken).toHaveBeenCalledExactlyOnceWith(credentials, false);
        expect(result).toEqual({
            registered: false,
            token: null,
            permission: {
                status: 'denied',
                granted: false,
                canAskAgain: false,
            },
        });
    });

    it('continues returning unsupported on web across all push helpers', async () => {
        state.os = 'web';
        state.noninvasiveLocal = false;

        await expect(syncCurrentPushToken(credentials)).resolves.toEqual({
            registered: false,
            token: null,
            permission: {
                status: 'unsupported',
                granted: false,
                canAskAgain: false,
            },
        });
        await expect(getPushPermissionInfo()).resolves.toEqual({
            status: 'unsupported',
            granted: false,
            canAskAgain: false,
        });
        await expect(requestPushPermissionOrOpenSettings()).resolves.toEqual({
            granted: false,
            openedSettings: false,
            permission: {
                status: 'unsupported',
                granted: false,
                canAskAgain: false,
            },
        });
        await expect(getCurrentExpoPushToken()).resolves.toBeNull();
        expect(state.getPermissionsAsync).not.toHaveBeenCalled();
    });
});
