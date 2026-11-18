import * as React from 'react';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    platformOS: 'ios' as 'ios' | 'android' | 'web',
    getCameraPermissionsAsync: vi.fn(),
    requestCameraPermissionsAsync: vi.fn(),
    alert: vi.fn(),
    openSettings: vi.fn(async () => {}),
    modalAlert: vi.fn(),
    modalPrompt: vi.fn(async (): Promise<string | null> => null),
    secureGetItem: vi.fn(async (): Promise<string | null> => null),
    secureSetItem: vi.fn(async () => {}),
    secureDeleteItem: vi.fn(async () => {}),
    axiosPost: vi.fn(async () => ({})),
    routerReplace: vi.fn(),
    searchParams: {} as Record<string, string | string[]>,
    hapticsLight: vi.fn(),
    backHandlerRemove: vi.fn(),
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
        addEventListener: vi.fn(() => ({ remove: mocks.backHandlerRemove })),
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
    getItemAsync: mocks.secureGetItem,
    setItemAsync: mocks.secureSetItem,
    deleteItemAsync: mocks.secureDeleteItem,
}));

vi.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    getRandomBytes: (len: number) => new Uint8Array(len),
    digestStringAsync: async () => '0'.repeat(64),
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
    generateAuthKeyPair: () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }),
}));

vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        crypto_box_easy: () => new Uint8Array(16),
        crypto_box_open_easy: () => new TextEncoder().encode('{}'),
    },
}));

vi.mock('@/sync/serverConfig', () => ({
    getServerUrl: () => 'https://example.invalid',
    setServerUrl: vi.fn(),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: mocks.modalAlert,
        prompt: mocks.modalPrompt,
    },
}));

vi.mock('@/config', () => ({
    config: { noninvasiveLocal: true },
}));

vi.mock('@/text', () => ({
    getCurrentLanguage: () => 'en',
    t: (key: string) => key,
}));

vi.mock('@/sync/bootstrapMacDiagnostics', () => ({
    bootstrapMacDiagnostics: vi.fn(async () => {}),
}));

vi.mock('@/sync/startupMacLocatorCore', () => ({
    sameLocatorOwner: () => true,
}));

vi.mock('react-native-device-info', () => ({
    default: { getModel: () => 'iPhone 14' },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/haptics', () => ({
    hapticsLight: mocks.hapticsLight,
}));

const stableRouter = { replace: mocks.routerReplace };

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => mocks.searchParams,
    useRouter: () => stableRouter,
}));

vi.mock('@/sync/storage', () => ({
    useSocketStatus: () => ({ status: 'disconnected' }),
}));

vi.mock('@/sync/apiSocket', () => ({
    apiSocket: { peerIdentity: () => null },
}));

vi.mock('@/components/onboarding/CodelyncScanScreen', () => ({
    CodelyncScanScreen: () => React.createElement('CodelyncScanScreen'),
}));

import { checkScannerPermissionsAsync } from '@/hooks/useCheckCameraPermissions';
import { CodelyncPairingProvider, useCodelyncPairing } from './CodelyncPairingProvider';
import { CodelyncPairingController } from './codelyncPairing';
import PairMac from '@/app/(app)/pair';

let latestPairing: ReturnType<typeof useCodelyncPairing> | null = null;
function Harness() {
    latestPairing = useCodelyncPairing();
    return React.createElement('Harness');
}

beforeEach(() => {
    mocks.platformOS = 'ios';
    mocks.searchParams = {};
    latestPairing = null;
    vi.clearAllMocks();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('checkScannerPermissionsAsync', () => {
    it('returns true immediately when camera permission is already granted', async () => {
        mocks.getCameraPermissionsAsync.mockResolvedValueOnce({ granted: true, canAskAgain: true });
        await expect(checkScannerPermissionsAsync()).resolves.toBe(true);
        expect(mocks.requestCameraPermissionsAsync).not.toHaveBeenCalled();
    });

    it('requests permission when undetermined and returns the granted result', async () => {
        mocks.getCameraPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: true });
        mocks.requestCameraPermissionsAsync.mockResolvedValueOnce({ granted: true, canAskAgain: true });
        await expect(checkScannerPermissionsAsync()).resolves.toBe(true);
        expect(mocks.requestCameraPermissionsAsync).toHaveBeenCalledOnce();
    });

    it('returns false without prompting when canAskAgain is false', async () => {
        mocks.getCameraPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: false });
        await expect(checkScannerPermissionsAsync()).resolves.toBe(false);
        expect(mocks.requestCameraPermissionsAsync).not.toHaveBeenCalled();
    });
});

describe('CodelyncPairingProvider QR scanner', () => {
    it('opens the in-app AVFoundation scanner even while background resume is pending, rejects non-pair QR codes inline, and connects valid QR payloads', async () => {
        mocks.getCameraPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
        let resolvePendingResume!: () => void;
        const pendingResumePromise = new Promise<void>(resolve => {
            resolvePendingResume = resolve;
        });
        const resumeSpy = vi.spyOn(CodelyncPairingController.prototype, 'resume').mockImplementation(() => pendingResumePromise);
        const connectSpy = vi.spyOn(CodelyncPairingController.prototype, 'connect').mockResolvedValue(undefined);

        let renderer!: ReturnType<typeof create>;
        await act(async () => {
            renderer = create(
                React.createElement(CodelyncPairingProvider, null, React.createElement(Harness)),
            );
        });

        expect(resumeSpy).toHaveBeenCalledOnce();
        expect(renderer.root.findAll((node: any) => node.props?.testID === 'codelync-qr-scanner-modal')).toHaveLength(0);

        await act(async () => {
            await latestPairing!.scan();
        });

        const modalNodes = renderer.root.findAll((node: any) => node.props?.testID === 'codelync-qr-scanner-modal');
        expect(modalNodes).toHaveLength(1);
        const camera = renderer.root.findAll((node: any) => node.props?.testID === 'codelync-qr-camera-view')[0];
        expect(camera.props.facing).toBe('back');
        expect(camera.props.barcodeScannerSettings).toEqual({ barcodeTypes: ['qr'] });

        await act(async () => {
            camera.props.onBarcodeScanned({ data: 'https://example.com', type: 'qr' });
        });
        expect(connectSpy).not.toHaveBeenCalled();
        expect(renderer.root.findAll((node: any) => node.props?.testID === 'codelync-qr-scanner-modal')).toHaveLength(1);
        const textValues = renderer.root.findAllByType('Text').map((node: any) => node.props.children);
        expect(textValues).toContain('codelyncPairing.invalid');

        const validUrl = 'codelync://pair?v=2&origin=https%3A%2F%2Fmac.example&invite=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&key=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB&expires=9999999999999&channels=W10';
        await act(async () => {
            camera.props.onBarcodeScanned({ data: validUrl, type: 'qr' });
        });

        expect(mocks.hapticsLight).toHaveBeenCalledOnce();
        expect(connectSpy).toHaveBeenCalledExactlyOnceWith(validUrl);
        expect(renderer.root.findAll((node: any) => node.props?.testID === 'codelync-qr-scanner-modal')).toHaveLength(0);

        resolvePendingResume();
        act(() => renderer.unmount());
    });

    it('shows an actionable alert with an Open Settings button when camera permission is denied', async () => {
        mocks.getCameraPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: false });
        vi.spyOn(CodelyncPairingController.prototype, 'resume').mockResolvedValue(undefined);

        let renderer!: ReturnType<typeof create>;
        await act(async () => {
            renderer = create(
                React.createElement(CodelyncPairingProvider, null, React.createElement(Harness)),
            );
        });

        await act(async () => {
            await latestPairing!.scan();
        });

        expect(renderer.root.findAll((node: any) => node.props?.testID === 'codelync-qr-scanner-modal')).toHaveLength(0);
        expect(latestPairing!.error).toBe('modals.cameraPermissionsRequiredToScanQr');
        expect(mocks.alert).toHaveBeenCalledOnce();
        const [_title, message, buttons] = mocks.alert.mock.calls[0];
        expect(message).toBe('modals.cameraPermissionsRequiredToScanQr');
        expect(buttons).toHaveLength(2);
        buttons[1].onPress();
        expect(mocks.openSettings).toHaveBeenCalledOnce();

        act(() => renderer.unmount());
    });
});

describe('PairMac route (/pair)', () => {
    it('renders CodelyncScanScreen without calling connect when opened with empty params', async () => {
        mocks.searchParams = {};
        vi.spyOn(CodelyncPairingController.prototype, 'resume').mockResolvedValue(undefined);
        const connectSpy = vi.spyOn(CodelyncPairingController.prototype, 'connect').mockResolvedValue(undefined);

        let renderer!: ReturnType<typeof create>;
        await act(async () => {
            renderer = create(
                React.createElement(CodelyncPairingProvider, null, React.createElement(PairMac)),
            );
        });

        expect(renderer.root.findAllByType('CodelyncScanScreen')).toHaveLength(1);
        expect(connectSpy).not.toHaveBeenCalled();

        act(() => renderer.unmount());
    });

    it('calls connect automatically when opened with pairing query params', async () => {
        mocks.searchParams = {
            v: '1',
            origin: 'https://mac.example',
            invite: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            key: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            expires: '9999999999999',
        };
        vi.spyOn(CodelyncPairingController.prototype, 'resume').mockResolvedValue(undefined);
        const connectSpy = vi.spyOn(CodelyncPairingController.prototype, 'connect').mockResolvedValue(undefined);

        let renderer!: ReturnType<typeof create>;
        await act(async () => {
            renderer = create(
                React.createElement(CodelyncPairingProvider, null, React.createElement(PairMac)),
            );
        });

        expect(connectSpy).toHaveBeenCalledOnce();
        expect(connectSpy.mock.calls[0][0]).toContain('codelync://pair?');
        expect(mocks.routerReplace).toHaveBeenCalledWith('/');

        act(() => renderer.unmount());
    });
});
