import React, { useEffect, useMemo } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCodeLightPairing } from '@/auth/CodeLightPairingProvider';
import { CodeLightScanScreen } from '@/components/onboarding/CodeLightScanScreen';
import { useAuth } from '@/auth/AuthContext';
import { useSocketStatus } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { isCodeLightPairingRouteComplete } from '@/auth/codeLightPairingRoute';

export default function PairMac() {
    const params = useLocalSearchParams(), pairing = useCodeLightPairing(), router = useRouter();
    const auth = useAuth(), socketStatus = useSocketStatus().status;
    const raw = JSON.stringify(params);
    const url = useMemo(() => {
        const parsed = JSON.parse(raw), value = new URL('codelight://pair');
        for (const [key, input] of Object.entries(parsed)) {
            if (typeof input === 'string') value.searchParams.append(key, input);
            else if (Array.isArray(input)) for (const item of input) value.searchParams.append(key, String(item));
        }
        return value.toString();
    }, [raw]);
    const complete = isCodeLightPairingRouteComplete(url, auth.credentials, socketStatus, apiSocket.peerIdentity());
    useEffect(() => {
        if (complete) { router.replace('/'); return; }
        void pairing.connect(url).then(() => router.replace('/')).catch(() => {});
    }, [complete, pairing.connect, router, url]);
    return <CodeLightScanScreen />;
}
