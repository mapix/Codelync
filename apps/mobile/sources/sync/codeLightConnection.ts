import { TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';
import { channelList, type PeerChannel } from '@slopus/happy-wire/codelight';
import { apiSocket } from './apiSocket';
import { commitPeerServerUrl } from './serverConfig';
import { peerAuthorization, decodePeerResponse } from './peerNetwork';
import { abortBudget } from './abortBudget';
import { sameLocatorOwner } from './startupMacLocatorCore';

export type ConnectionSnapshot = { peerId:string|null; channels:Array<PeerChannel & {state:'connected'|'available'|'probing'|'failed';latencyMs?:number}>; selectedId:string|null;automatic:boolean;connecting:boolean;
    readable?:boolean; realtimeRecovering?:boolean; failureCode?:'connection-failed'|'access-ended'|null };
let snapshot: ConnectionSnapshot = { peerId:null, channels:[], selectedId:null, automatic:true, connecting:false };
let credentials: AuthCredentials | null = null, generation = 0;
let probing: AbortController | null = null, releaseStatus: (()=>void)|null = null;
let committing = false;
const automaticSuspensions = new Set<{ owner: AuthCredentials | null }>();
let automaticRecoveryPending: AuthCredentials | null = null;
function recoverySuspended(value: AuthCredentials) {
    return [...automaticSuspensions].some(entry => !!entry.owner && sameLocatorOwner(entry.owner, value));
}
export function suspendCodeLightAutomaticRecovery(owner: AuthCredentials | null = credentials) {
    const entry = { owner }; automaticSuspensions.add(entry);
    let released = false;
    return () => {
        if (released) return; released = true; automaticSuspensions.delete(entry);
        if (entry.owner && automaticRecoveryPending && credentials && sameLocatorOwner(entry.owner, automaticRecoveryPending)
            && sameLocatorOwner(automaticRecoveryPending, credentials) && !recoverySuspended(credentials)) {
            automaticRecoveryPending = null;
            if (credentials?.peer && snapshot.automatic && apiSocket.peerCanReconnect() && !apiSocket.peerConnected() && !currentReadProof(credentials)) void selectConnection('auto').catch(() => {});
        }
    };
}
let readProof: { peerId: string; endpoint: string; observedAt: number } | null = null;
function currentReadProof(value: AuthCredentials) {
    const proofs = [apiSocket.peerHttpProof(), readProof];
    return proofs.some(proof => !!proof && proof.peerId === value.peer?.id && proof.endpoint === value.serverUrl
        && Date.now() - proof.observedAt >= 0 && Date.now() - proof.observedAt < 20000);
}
let selection: { value:AuthCredentials; id:string; promise:Promise<void> } | null = null;
const listeners = new Set<()=>void>();
export function getConnectionSnapshot() { return snapshot; }
export function subscribeConnection(listener:()=>void) { listeners.add(listener); return ()=>{listeners.delete(listener);}; }
function publish(value:ConnectionSnapshot) { snapshot=value; for(const listener of listeners)listener(); }

export function initializeCodeLightConnection(value:AuthCredentials) {
    if (!value.peer) { credentials=null;readProof=null;automaticRecoveryPending=null;releaseStatus?.();releaseStatus=null; publish({peerId:null,channels:[],selectedId:null,automatic:true,connecting:false});return; }
    if (automaticRecoveryPending && !sameLocatorOwner(automaticRecoveryPending, value)) automaticRecoveryPending = null;
    credentials=value;
    if (readProof?.peerId !== value.peer.id || readProof.endpoint !== value.serverUrl) readProof=null;
    const selected=value.peer.channels.find(channel=>channel.url===value.serverUrl)?.id??value.peer.selectedChannel??null;
    publish({peerId:value.peer.id,channels:value.peer.channels.map(channel=>({...channel,state:channel.id===selected&&apiSocket.peerConnected()?'connected':'available'})),selectedId:selected,automatic:value.peer.automatic!==false,connecting:false});
    releaseStatus?.();
    releaseStatus=apiSocket.onStatusChange(status=>{
        if (!credentials?.peer || snapshot.connecting) return;
        const readable = currentReadProof(credentials);
        if(status==='connected')publish({...snapshot,failureCode:null,realtimeRecovering:false,readable,channels:snapshot.channels.map(channel=>({...channel,state:channel.id===snapshot.selectedId?'connected':channel.state}))});
        else publish({...snapshot,readable,realtimeRecovering:readable&&apiSocket.peerCanReconnect(),channels:snapshot.channels.map(channel=>channel.id===snapshot.selectedId?{...channel,state:readable||status==='connecting'?'probing':apiSocket.peerCanReconnect()?'failed':'available'}:channel)});
        // 冷启动用过期地址只会 connect_error，不会先 disconnect；恢复也必须覆盖这个入口。
        if((status==='disconnected'||status==='error')&&snapshot.automatic&&apiSocket.peerCanReconnect()&&!readable) {
            if(recoverySuspended(credentials))automaticRecoveryPending=credentials;else void selectConnection('auto').catch(()=>{});
        }
    });
}

async function prove(channel:PeerChannel,value:AuthCredentials,signal:AbortSignal) {
    const peer=value.peer!;const url=channel.url+'/api/peer/channels',start=Date.now();
    const deadline=abortBudget(signal,channel.kind==='local'?2500:7000);
    try {
    const response=await fetch(url,{headers:{Authorization:peerAuthorization(value.token,peer,channel.url,'GET',url)},signal:deadline.signal});
    if(!response.ok)throw Object.assign(Error('The channel could not reach this Mac'), { connectionFailure: response.status === 401 || response.status === 403 ? 'access-ended' : 'connection-failed' });
    const data=decodePeerResponse(peer,await response.json()) as {channels:unknown};
    const channels=channelList(data.channels);
    if(!channels.some(current=>current.url===channel.url))throw Error('The Mac has disabled this channel');
    return {channel,channels,latencyMs:Date.now()-start};
    } finally { deadline.dispose(); }
}

export function selectConnection(id:string):Promise<void> {
    const value=credentials;
    if(selection?.value===value&&selection.id===id)return selection.promise;
    if(!value?.peer)return Promise.reject(Error('Scan your Mac to get connection channels'));
    const entry={value,id,promise:Promise.resolve()};
    entry.promise=performSelection(id).finally(()=>{if(selection===entry)selection=null;});
    selection=entry;return entry.promise;
}

export function retryCodeLightConnection():Promise<void> {
    if(!snapshot.peerId)return Promise.reject(Error('The saved Mac connection is unavailable'));
    const id=snapshot.automatic?'auto':snapshot.selectedId;
    return id?selectConnection(id):Promise.reject(Error('Choose a saved connection first'));
}

async function performSelection(id:string) {
    if(committing)throw Error('The connection choice is being saved');
    const value=credentials;if(!value?.peer)throw Error('Scan your Mac to get connection channels');
    const sequence=++generation;probing?.abort();const abort=new AbortController();probing=abort;
    const automatic=id==='auto',candidates=automatic?value.peer.channels:value.peer.channels.filter(channel=>channel.id===id);
    if(!candidates.length)throw Error('This channel is unavailable');
    publish({...snapshot,connecting:true,failureCode:null,channels:snapshot.channels.map(channel=>candidates.some(candidate=>candidate.id===channel.id)?{...channel,state:'probing'}:channel)});
    try {
        const everProved = readProof?.peerId === value.peer.id && readProof.endpoint === value.serverUrl
            || apiSocket.peerHttpProof()?.peerId === value.peer.id && apiSocket.peerHttpProof()?.endpoint === value.serverUrl;
        const selected = automatic && everProved ? candidates.find(channel=>channel.url===value.serverUrl) : undefined;
        let result: Awaited<ReturnType<typeof prove>> | undefined;
        let selectedFailure: unknown;
        if (selected && currentReadProof(value)) result={channel:selected,channels:value.peer.channels,latencyMs:0};
        else if (selected) { try { result=await prove(selected,value,abort.signal); } catch(error) { selectedFailure=error; } }
        if(!result){
            if(automatic){
                const remaining=candidates.filter(channel=>channel!==selected);
                if(!remaining.length&&selectedFailure)throw selectedFailure;
                try{result=await Promise.any(remaining.map(channel=>prove(channel,value,abort.signal)));}
                catch(error){if(selectedFailure&&error instanceof AggregateError)throw new AggregateError([selectedFailure,...error.errors]);throw error;}
            }else result=await prove(candidates[0],value,abort.signal);
        }
            if(sequence!==generation||credentials!==value)throw Error('A newer channel selection replaced this one');
                committing=true;
                const peer={...value.peer,channels:result.channels,selectedChannel:result.channel.id,automatic};
                const updated={...value,serverUrl:result.channel.url,peer};
                if(!await TokenStorage.setCredentials(updated))throw Error('The connection choice could not be saved');
                if(sequence!==generation||credentials!==value)throw Error('A newer channel selection replaced this one');
                commitPeerServerUrl(result.channel.url);
                if(apiSocket.peerEndpoint()!==result.channel.url)await apiSocket.switchPeerChannel(result.channel.url,peer,{waitForSocket:false});
                if(sequence!==generation||credentials!==value)throw Error('A newer channel selection replaced this one');
                credentials=updated;
                readProof={peerId:peer.id,endpoint:result.channel.url,observedAt:Date.now()};
                publish({peerId:peer.id,selectedId:result.channel.id,automatic,connecting:false,readable:true,realtimeRecovering:!apiSocket.peerConnected(),channels:peer.channels.map(channel=>({...channel,state:channel.id===result.channel.id?apiSocket.peerConnected()?'connected':'probing':'available',...(channel.id===result.channel.id?{latencyMs:result.latencyMs}:{})}))});
                return;
    } catch(error) {
        if(sequence===generation&&committing&&credentials===value&&value.serverUrl&&value.peer){
            await TokenStorage.setCredentials(value);commitPeerServerUrl(value.serverUrl);
            await apiSocket.switchPeerChannel(value.serverUrl,value.peer,{waitForSocket:false}).catch(()=>{});
        }
        const failures=error instanceof AggregateError?error.errors:[error];
        const accessEnded=failures.length>0&&failures.every(failure=>(failure as {connectionFailure?:string})?.connectionFailure==='access-ended');
        if(sequence===generation&&credentials===value)publish({...snapshot,connecting:false,failureCode:accessEnded?'access-ended':'connection-failed',channels:snapshot.channels.map(channel=>channel.state==='probing'?{...channel,state:channel.id===snapshot.selectedId&&apiSocket.peerConnected()?'connected':'failed'}:channel)});
        throw error;
    } finally { abort.abort();if(sequence===generation)committing=false;if(probing===abort)probing=null; }
}
