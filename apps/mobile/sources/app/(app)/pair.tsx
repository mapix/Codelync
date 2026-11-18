import React, { useEffect, useMemo } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCodelyncPairing } from '@/auth/CodelyncPairingProvider';
import { CodelyncScanScreen } from '@/components/onboarding/CodelyncScanScreen';
import { useAuth } from '@/auth/AuthContext';
import { useSocketStatus } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { isCodelyncPairingRouteComplete } from '@/auth/codelyncPairingRoute';

export default function PairMac() {
    const params = useLocalSearchParams(), pairing = useCodelyncPairing(), router = useRouter();
    const auth = useAuth(), socketStatus = useSocketStatus().status;
    const raw = JSON.stringify(params);
    const { url, hasParams } = useMemo(() => {
        const parsed = JSON.parse(raw), value = new URL('codelync://pair');
        let count = 0;
        for (const [key, input] of Object.entries(parsed)) {
            if (typeof input === 'string' && input.length > 0) { value.searchParams.append(key, input); count++; }
            else if (Array.isArray(input)) for (const item of input) if (String(item).length > 0) { value.searchParams.append(key, String(item)); count++; }
        }
        return { url: value.toString(), hasParams: count > 0 };
    }, [raw]);
    const complete = hasParams && isCodelyncPairingRouteComplete(url, auth.credentials, socketStatus, apiSocket.peerIdentity());
    useEffect(() => {
        if (!hasParams) return;
        if (complete) { router.replace('/'); return; }
        void pairing.connect(url).then(() => router.replace('/')).catch(() => {});
    }, [complete, hasParams, pairing.connect, router, url]);
    return <CodelyncScanScreen />;
}
