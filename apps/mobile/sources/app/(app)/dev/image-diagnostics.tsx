import * as React from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import { Text } from '@/components/StyledText';
import { apiSocket } from '@/sync/apiSocket';
import { sync } from '@/sync/sync';
import { loadNativeImageAttachment } from '@/sync/nativeImage';
import { downloadEncryptedAttachment } from '@/sync/apiAttachments';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decryptBlob } from '@/encryption/blob';
import { bootstrapMacDiagnostics } from '@/sync/bootstrapMacDiagnostics';
import { currentImageReadCredentials } from '@/sync/imageReadCredentials';
import { getServerUrl } from '@/sync/serverConfig';

/** Explicit private native read/decrypt/render diagnostic, never part of background synchronization. */
export default function ImageDiagnostics() {
    const params = useLocalSearchParams<{ thread?: string; image?: string; bootstrap?: string }>();
    const [report, setReport] = React.useState('Checking image…');
    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result: Record<string, unknown> = { at: Date.now(), phase: 'setup' };
            try {
                if (params.bootstrap) {
                    result.phase = 'authenticated-bootstrap';
                    await bootstrapMacDiagnostics(JSON.parse(new TextDecoder().decode(decodeBase64(params.bootstrap, 'base64url'))));
                    result.samePeerBootstrap = true;
                }
                const deadline = Date.now() + 15000;
                while (!apiSocket.peerConnected() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
                if (!apiSocket.peerConnected()) throw Error();
                result.phase = 'catalog';
                const catalog = await apiSocket.peerRequest('/api/peer/catalog?limit=200');
                const selected = (await catalog.json()).sessions?.find((entry: any) => entry.metadata?.bridge?.source?.id === params.thread);
                if (!selected || !params.image) throw Error();
                result.phase = 'recent';
                const recent = await apiSocket.peerRequest(`/api/peer/sessions/${selected.id}/recent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 50 }) });
                if (!recent.ok) throw Error();
                const window = await recent.json(), key = decodeBase64(window.session.sessionKey, 'base64');
                const prior = sync.encryption.getSessionDataKey(selected.id);
                result.keyMatchesPrior = prior ? prior.length === key.length && prior.every((value, index) => value === key[index]) : null;
                await sync.encryption.initializeSessions(new Map([[selected.id, key]]));
                result.phase = 'rpc'; const started = Date.now();
                const attachment = await loadNativeImageAttachment(selected.id, params.image);
                result.rpcMs = Date.now() - started; result.previewBytes = attachment.size;
                result.phase = 'download';
                const expected = sync.getCredentials(); if (!expected) throw Error();
                result.activeChannelInSyncCredentials = expected.peer?.channels.some(channel => channel.url === getServerUrl()) ?? null;
                const credentials = await currentImageReadCredentials(expected);
                result.activeChannelInFreshCredentials = credentials.peer?.channels.some(channel => channel.url === getServerUrl()) ?? null;
                const encrypted = await downloadEncryptedAttachment(credentials, selected.id, attachment.ref);
                result.encryptedBytes = encrypted.length;
                result.phase = 'decrypt';
                const blobKey = sync.encryption.getSessionBlobKey(selected.id); if (!blobKey) throw Error();
                const bytes = decryptBlob(encrypted, blobKey); if (!bytes) throw Error();
                result.decryptedBytes = bytes.length;
                result.phase = 'render';
                const image = await Image.loadAsync(`data:image/jpeg;base64,${encodeBase64(bytes)}`);
                result.width = image.width; result.height = image.height; image.release();
                result.phase = 'complete'; result.ok = true;
            } catch { result.ok = false; }
            result.finishedAt = Date.now();
            await AsyncStorage.setItem('codelync-native-image-probe-v1', JSON.stringify(result));
            if (!cancelled) setReport(JSON.stringify(result, null, 2));
        })();
        return () => { cancelled = true; };
    }, [params.thread, params.image, params.bootstrap]);
    return <ScrollView contentContainerStyle={{ padding: 24 }}><Stack.Screen options={{ headerTitle: 'Image diagnostics' }} /><Text>{report}</Text></ScrollView>;
}
