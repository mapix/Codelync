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
    const url = useMemo(() => {
        const parsed = JSON.parse(raw), value = new URL('codelync://pair');
        for (const [key, input] of Object.entries(parsed)) {
            if (typeof input === 'string') value.searchParams.append(key, input);
            else if (Array.isArray(input)) for (const item of input) value.searchParams.append(key, String(item));
        }
        return value.toString();
    }, [raw]);
    const complete = isCodelyncPairingRouteComplete(url, auth.credentials, socketStatus, apiSocket.peerIdentity());
    useEffect(() => {
        if (complete) { router.replace('/'); return; }
        void pairing.connect(url).then(() => router.replace('/')).catch(() => {});
    }, [complete, pairing.connect, router, url]);
    return <CodelyncScanScreen />;
}
