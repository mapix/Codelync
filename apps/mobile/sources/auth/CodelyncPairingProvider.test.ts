import * as React from 'react';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupportedLanguage } from '@/text';

const mocks = vi.hoisted(() => ({
    platformOS: 'android' as 'ios' | 'android' | 'web',
    language: 'en' as SupportedLanguage,
    model: 'Pixel 7' as string,
    getCameraPermissionsAsync: vi.fn(),
    requestCameraPermissionsAsync: vi.fn(),
    alert: vi.fn(),
    openSettings: vi.fn(async () => {}),
    modalAlert: vi.fn(),
    modalPrompt: vi.fn(async (): Promise<string | null> => null),
    secureStoreMap: new Map<string, string>(),
    axiosPost: vi.fn(),
    lastEncryptedPlaintext: null as Uint8Array | null,
    decryptedPayload: {} as unknown,
}));

vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return mocks.platformOS;
        },
    },
    Alert: {
        alert: mocks.alert,
    },
    Linking: {
        openSettings: mocks.openSettings,
    },
    BackHandler: {
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
    Pressable: 'Pressable',
    StatusBar: 'StatusBar',
    StyleSheet: {
        absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
        hairlineWidth: 1,
        create: <T,>(styles: T) => styles,
    },
    Text: 'Text',
    View: 'View',
}));

vi.mock('expo-camera', () => ({
    Camera: {
        getCameraPermissionsAsync: mocks.getCameraPermissionsAsync,
        requestCameraPermissionsAsync: mocks.requestCameraPermissionsAsync,
    },
    CameraView: 'CameraView',
}));

vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async (key: string) => mocks.secureStoreMap.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
        mocks.secureStoreMap.set(key, value);
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
        mocks.secureStoreMap.delete(key);
    }),
}));

vi.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    getRandomBytes: (len: number) => new Uint8Array(len),
    digestStringAsync: async () => 'f'.repeat(64),
}));

vi.mock('@codelync/wire/codelync', async () => {
    const actual = await vi.importActual<typeof import('@codelync/wire/codelync')>('@codelync/wire/codelync');
    return actual;
});

vi.mock('expo', () => ({
    reloadAppAsync: vi.fn(async () => {}),
}));

vi.mock('axios', () => ({
    default: {
        post: mocks.axiosPost,
    },
}));

vi.mock('./AuthContext', () => ({
    useAuth: () => ({ credentials: null, login: vi.fn(async () => {}) }),
}));

vi.mock('./tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(async () => null),
        setCredentials: vi.fn(async () => true),
    },
}));

vi.mock('./authQRStart', () => ({
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) }),
}));

vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        crypto_box_easy: (plain: Uint8Array) => {
            mocks.lastEncryptedPlaintext = plain;
            return new Uint8Array(16).fill(9);
        },
        crypto_box_open_easy: () => new TextEncoder().encode(JSON.stringify(mocks.decryptedPayload)),
    },
}));

vi.mock('@/sync/serverConfig', () => ({
    getServerUrl: () => 'http://192.168.1.20:50256',
    setServerUrl: vi.fn(),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: mocks.modalAlert,
        prompt: mocks.modalPrompt,
    },
}));

vi.mock('@/config', () => ({
    config: { noninvasiveLocal: false },
}));

vi.mock('@/text', () => ({
    getCurrentLanguage: () => mocks.language,
    t: (key: string) => key,
}));

vi.mock('@/sync/bootstrapMacDiagnostics', () => ({
    bootstrapMacDiagnostics: vi.fn(async () => {}),
}));

vi.mock('@/sync/startupMacLocatorCore', () => ({
    sameLocatorOwner: () => true,
}));

vi.mock('react-native-device-info', () => ({
    default: {
        getModel: () => mocks.model,
    },
}));

vi.mock('@/components/CodelyncQrScannerModal', () => ({
    CodelyncQrScannerModal: () => null,
}));

import { encodeBase64 } from '@/encryption/base64';
import { CodelyncPairingError } from './codelyncPairing';
import { CodelyncPairingProvider, formatPairingError, useCodelyncPairing } from './CodelyncPairingProvider';

let pairingApi: ReturnType<typeof useCodelyncPairing> | null = null;
function Consumer() {
    pairingApi = useCodelyncPairing();
    return React.createElement('Consumer');
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.platformOS = 'android';
    mocks.language = 'en';
    mocks.model = 'Pixel 7';
    mocks.secureStoreMap.clear();
    mocks.lastEncryptedPlaintext = null;
    pairingApi = null;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('formatPairingError 4-locale & error-code parity', () => {
    it('provides explicit distinct non-empty location recovery copy for en, zh-Hans, zh-Hant, and ja', () => {
        const failure = new CodelyncPairingError('location', 'Mac location mismatch');
        const en = formatPairingError(failure, 'en');
        const zhHans = formatPairingError(failure, 'zh-Hans');
        const zhHant = formatPairingError(failure, 'zh-Hant');
        const ja = formatPairingError(failure, 'ja');

        expect(en.length).toBeGreaterThan(0);
        expect(zhHans.length).toBeGreaterThan(0);
        expect(zhHant.length).toBeGreaterThan(0);
        expect(ja.length).toBeGreaterThan(0);

        expect(zhHant).not.toBe(zhHans);
        expect(ja).not.toBe(en);
        expect(new Set([en, zhHans, zhHant, ja]).size).toBe(4);
    });

    it('uses getCurrentLanguage() by default and falls back cleanly to English on secondary European locales', () => {
        const failure = new CodelyncPairingError('location', 'Mac location mismatch');
        mocks.language = 'zh-Hant';
        expect(formatPairingError(failure)).toBe(formatPairingError(failure, 'zh-Hant'));

        mocks.language = 'ja';
        expect(formatPairingError(failure)).toBe(formatPairingError(failure, 'ja'));

        expect(formatPairingError(failure, 'es')).toBe(formatPairingError(failure, 'en'));
    });

    it('maps expired, used, storage, invalid, identity, network, and unknown errors to their localized keys', () => {
        expect(formatPairingError(new CodelyncPairingError('expired', 'expired'))).toBe('codelyncPairing.refresh');
        expect(formatPairingError(new CodelyncPairingError('used', 'used'))).toBe('codelyncPairing.refresh');
        expect(formatPairingError(new CodelyncPairingError('storage', 'storage'))).toBe('codelyncPairing.storage');
        expect(formatPairingError(new CodelyncPairingError('invalid', 'invalid'))).toBe('codelyncPairing.invalid');
        expect(formatPairingError(new CodelyncPairingError('identity', 'identity'))).toBe('codelyncPairing.invalid');
        expect(formatPairingError(new CodelyncPairingError('network', 'network'))).toBe('codelyncPairing.network');
        expect(formatPairingError(new Error('unexpected'))).toBe('codelyncPairing.network');
    });
});

describe('CodelyncPairingProvider Android deviceName & permission handling', () => {
    it('normalizes empty or whitespace DeviceInfo.getModel() to Phone in saved key and encrypted exchange payload', async () => {
        mocks.model = '   ';
        const channels = [{ id: 'local', kind: 'local' as const, url: 'http://192.168.1.20:50256' }];
        const macKey = 'a'.repeat(43);
        const secret = 'b'.repeat(43);
        const invite = 'c'.repeat(43);
        mocks.decryptedPayload = {
            version: 2,
            origin: channels[0].url,
            macKey,
            credentials: { token: 'tok', secret, serverUrl: channels[0].url },
            peer: { id: 'f'.repeat(64), key: macKey, channels },
        };
        mocks.axiosPost.mockResolvedValueOnce({
            data: { version: 2, macKey, nonce: encodeBase64(new Uint8Array(24), 'base64url'), ciphertext: encodeBase64(new Uint8Array(16), 'base64url') },
        });

        const url = new URL('codelync://pair');
        url.searchParams.set('v', '2');
        url.searchParams.set('origin', channels[0].url);
        url.searchParams.set('key', macKey);
        url.searchParams.set('invite', invite);
        url.searchParams.set('expires', String(Date.now() + 60_000));
        url.searchParams.set('channels', encodeBase64(new TextEncoder().encode(JSON.stringify(channels)), 'base64url'));

        let renderer!: ReturnType<typeof create>;
        await act(async () => {
            renderer = create(React.createElement(CodelyncPairingProvider, null, React.createElement(Consumer)));
        });

        await act(async () => {
            await pairingApi!.connect(url.toString());
        });

        const storedDevice = JSON.parse(mocks.secureStoreMap.get('codelync_device_box_key_v1') ?? '{}');
        expect(storedDevice.name).toBe('Phone');

        const sentPayload = JSON.parse(new TextDecoder().decode(mocks.lastEncryptedPlaintext!));
        expect(sentPayload.deviceName).toBe('Phone');

        act(() => renderer.unmount());
    });

    it('shows Android camera permission denied alert with Settings redirect action', async () => {
        mocks.platformOS = 'android';
        mocks.getCameraPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: false });

        let renderer!: ReturnType<typeof create>;
        await act(async () => {
            renderer = create(React.createElement(CodelyncPairingProvider, null, React.createElement(Consumer)));
        });

        await act(async () => {
            await pairingApi!.scan();
        });

        expect(pairingApi!.error).toBe('modals.cameraPermissionsRequiredToScanQr');
        expect(mocks.alert).toHaveBeenCalledOnce();
        const [_title, _message, buttons] = mocks.alert.mock.calls[0];
        buttons[1].onPress();
        expect(mocks.openSettings).toHaveBeenCalledOnce();

        act(() => renderer.unmount());
    });
});
