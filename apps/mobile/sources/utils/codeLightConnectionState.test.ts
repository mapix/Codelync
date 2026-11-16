import { expect, it } from 'vitest';
import { codeLightConnectionState } from './codeLightConnectionState';
import type { ConnectionSnapshot } from '@/sync/codeLightConnection';
const snapshot: ConnectionSnapshot = { peerId: 'paired', selectedId: 'local', automatic: true, connecting: false,
    channels: [{ id: 'local', kind: 'local', url: 'http://192.0.2.1', state: 'available' }] };
const input = { status: 'error' as const, snapshot, error: null, canReconnect: true };
it('terminal socket failure remains a failure even if HTTP and cached channel flags look healthy', () => {
    expect(codeLightConnectionState({ ...input, snapshot: { ...snapshot, channels: snapshot.channels.map(c => ({ ...c, state: 'connected' })) } })).toMatchObject({ kind: 'failed', busy: false, canRetry: true });
});
it('a currently proved HTTP route is realtime recovery and never a connected write socket',()=>{
 expect(codeLightConnectionState({...input,snapshot:{...snapshot,readable:true,realtimeRecovering:true}})).toMatchObject({kind:'connecting',busy:false});
 expect(codeLightConnectionState({...input,error:{code:'device-revoked'},snapshot:{...snapshot,readable:true,realtimeRecovering:true}})).toMatchObject({kind:'access-ended',canRetry:false});
});
it('a proven live connection wins over an obsolete error and failed source metadata', () => {
    expect(codeLightConnectionState({ ...input, status: 'connected', error: { code: 'transport-error', httpStatus: 403 },
        snapshot: { ...snapshot, failureCode: 'connection-failed' } }).kind).toBe('connected');
});
it('actual connection probing keeps saved choices inspectable', () => {
    expect(codeLightConnectionState({ ...input, snapshot: { ...snapshot, connecting: true } })).toMatchObject({ kind: 'connecting', canInspect: true, busy: true });
});
it('a failed attempt cannot leave an obsolete connecting socket as a permanent spinner', () => {
    expect(codeLightConnectionState({ ...input, status: 'connecting', snapshot: { ...snapshot, failureCode: 'connection-failed' } })).toMatchObject({ kind: 'failed', busy: false });
});
it.each([{ code: 'device-revoked' }, { code: 'transport-error', httpStatus: 403 }])('access refusal offers explicit pairing rather than automatic retry', error => {
    expect(codeLightConnectionState({ ...input, error })).toMatchObject({ kind: 'access-ended', canRetry: false, busy: false });
});
it('a socket connected to another Mac cannot prove the saved Mac connected', () => {
    expect(codeLightConnectionState({ ...input, status: 'connected', peerIdentity: 'peer:other' })).toMatchObject({ kind: 'failed', canRetry: false });
});
it('no configured pairing belongs to onboarding rather than an invented Mac failure', () => {
    expect(codeLightConnectionState({ ...input, snapshot: { ...snapshot, peerId: null } }).kind).toBe('hidden');
});
it('a manual choice without a selected target cannot silently retry through automatic selection', () => {
    expect(codeLightConnectionState({ ...input, snapshot: { ...snapshot, automatic: false, selectedId: null } }).canRetry).toBe(false);
});
