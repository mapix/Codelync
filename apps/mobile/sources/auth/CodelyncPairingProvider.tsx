import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { CameraView } from 'expo-camera';
import * as SecureStore from 'expo-secure-store';
import { getRandomBytes, digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { peerMaterial } from '@codelync/wire/codelync';
import { reloadAppAsync } from 'expo';
import axios from 'axios';
import { useAuth } from './AuthContext';
import { TokenStorage } from './tokenStorage';
import { generateAuthKeyPair } from './authQRStart';
import { CodelyncPairingController, CodelyncPairingError, type PendingCodelyncPairing } from './codelyncPairing';
import sodium from '@/encryption/libsodium.lib';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { getServerUrl, setServerUrl } from '@/sync/serverConfig';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';
import { config } from '@/config';
import { t, getCurrentLanguage } from '@/text';
import { bootstrapMacDiagnostics } from '@/sync/bootstrapMacDiagnostics';
import { sameLocatorOwner } from '@/sync/startupMacLocatorCore';
import DeviceInfo from 'react-native-device-info';

const PENDING_KEY = 'codelync_pending_scan_v1';
const DEVICE_KEY = 'codelync_device_box_key_v1';
type PairingContext = { busy: boolean; error: string | null; scan: () => Promise<void>; connect: (url: string) => Promise<void> };
const Context = createContext<PairingContext | null>(null);
export function CodelyncPairingProvider({ children }: { children: React.ReactNode }) {
    const auth = useAuth(), authRef = useRef(auth); authRef.current = auth;
    const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
    const checkCamera = useCheckScannerPermissions();
    const controller = useRef<CodelyncPairingController | null>(null);
    if (!controller.current) controller.current = new CodelyncPairingController({
        load: async () => {
            const value = Platform.OS === 'web' ? localStorage.getItem(PENDING_KEY) : await SecureStore.getItemAsync(PENDING_KEY);
            return value ? JSON.parse(value) as PendingCodelyncPairing : null;
        },
        save: async pending => {
            const value = JSON.stringify(pending);
            if (Platform.OS === 'web') localStorage.setItem(PENDING_KEY, value); else await SecureStore.setItemAsync(PENDING_KEY, value);
        },
        clear: async () => { if (Platform.OS === 'web') localStorage.removeItem(PENDING_KEY); else await SecureStore.deleteItemAsync(PENDING_KEY); },
        generateKey: async () => {
            const saved = Platform.OS === 'web' ? localStorage.getItem(DEVICE_KEY) : await SecureStore.getItemAsync(DEVICE_KEY);
            if (saved) return JSON.parse(saved);
            const key = generateAuthKeyPair(), value = { publicKey: encodeBase64(key.publicKey, 'base64url'), secretKey: encodeBase64(key.secretKey, 'base64url'), name: DeviceInfo.getModel() };
            if (Platform.OS === 'web') localStorage.setItem(DEVICE_KEY, JSON.stringify(value)); else await SecureStore.setItemAsync(DEVICE_KEY, JSON.stringify(value));
            return value;
        },
        encrypt: (code, device) => {
            const nonce = getRandomBytes(24), plain = new TextEncoder().encode(JSON.stringify({ version: code.version ?? 1, invite: code.invite, origin: code.origin, deviceName: device.name ?? 'Phone' }));
            const ciphertext = sodium.crypto_box_easy(plain, nonce, decodeBase64(code.key, 'base64url'), decodeBase64(device.secretKey, 'base64url'));
            return { publicKey: device.publicKey, nonce: encodeBase64(nonce, 'base64url'), ciphertext: encodeBase64(ciphertext, 'base64url') };
        },
        exchange: async (origin, packet) => (await axios.post(origin + '/codelync/pairing/exchange', packet, { timeout: 15000 })).data,
        decrypt: (code, device, value) => {
            const reply = value as { version?: number; macKey?: string; nonce: string; ciphertext: string };
            if (reply?.version !== (code.version ?? 1) || reply.macKey !== code.key) throw new CodelyncPairingError('identity', 'Wrong Mac pairing key.');
            const plain = sodium.crypto_box_open_easy(decodeBase64(reply.ciphertext, 'base64url'), decodeBase64(reply.nonce, 'base64url'),
                decodeBase64(code.key, 'base64url'), decodeBase64(device.secretKey, 'base64url'));
            return JSON.parse(new TextDecoder().decode(plain));
        },
        currentOrigin: getServerUrl, selectOrigin: setServerUrl,
        validatePeer: async (id, key, secret) => id === await digestStringAsync(CryptoDigestAlgorithm.SHA256, peerMaterial(key, secret)),
        recoverPeerLocation: async (code, owner) => {
            const current = await TokenStorage.getCredentials();
            if (!current || !sameLocatorOwner(owner, current)) throw new CodelyncPairingError('location', 'The saved Mac changed.');
            await bootstrapMacDiagnostics(code.channels?.map(channel => channel.url), { expectedPeerId: owner.peer!.id });
            if (!sameLocatorOwner(owner, await TokenStorage.getCredentials())) throw new CodelyncPairingError('location', 'The saved Mac changed.');
        },
        credentials: () => { const value = authRef.current.credentials; return value ? { ...value, serverUrl: value.serverUrl ?? getServerUrl() } : null; },
        saveCredentials: async credentials => { if (!await TokenStorage.setCredentials(credentials)) throw new CodelyncPairingError('storage', 'Could not save this Mac.'); },
        login: credentials => authRef.current.login(credentials.token, credentials.secret, credentials.serverUrl),
        reload: async () => { if (Platform.OS === 'web') window.location.reload(); else await reloadAppAsync(); },
    });
    const run = useCallback(async (operation: () => Promise<void>) => {
        setBusy(true); setError(null);
        try { await operation(); } catch (failure) {
            const code = failure instanceof CodelyncPairingError ? failure.code : 'network';
            setError(code === 'location' ? getCurrentLanguage().startsWith('zh') ? '这台 Mac 的位置验证失败，请检查网络后重新扫描。' : 'Could not verify this Mac’s location. Check the network and scan again.'
                : code === 'expired' || code === 'used' ? t('codelyncPairing.refresh') : code === 'storage' ? t('codelyncPairing.storage') : code === 'invalid' || code === 'identity' ? t('codelyncPairing.invalid') : t('codelyncPairing.network'));
            throw failure;
        }
        finally { setBusy(false); }
    }, []);
    const connect = useCallback((url: string) => run(() => controller.current!.connect(url)), [run]);
    const scan = useCallback(async () => {
        if (busy) return;
        if (!await checkCamera()) { setError(t('modals.cameraPermissionsRequiredToScanQr')); return; }
        try { await CameraView.launchScanner({ barcodeTypes: ['qr'] }); } catch { setError(t('onboarding.linkFailed')); }
    }, [busy, checkCamera]);
    useEffect(() => {
        if (!config.noninvasiveLocal) return;
        void run(() => controller.current!.resume()).catch(() => {});
        if (!CameraView.isModernBarcodeScannerAvailable) return;
        const subscription = CameraView.onModernBarcodeScanned(async event => {
            if (!event.data.startsWith('codelync://pair?')) return;
            if (Platform.OS === 'ios') await CameraView.dismissScanner().catch(() => {});
            await connect(event.data).catch(() => {});
        });
        return () => subscription.remove();
    }, [connect, run]);
    return <Context.Provider value={{ busy, error, scan, connect }}>{children}</Context.Provider>;
}
export function useCodelyncPairing() {
    const value = useContext(Context); if (!value) throw Error('CodelyncPairingProvider is missing'); return value;
}
