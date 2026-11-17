import { afterEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({set:vi.fn().mockResolvedValue(true),url:vi.fn(),switch:vi.fn().mockResolvedValue(undefined), reconnect:false, connected:true, endpoint:'http://192.168.1.2:8800', proof:null as null|{peerId:string;endpoint:string;observedAt:number}, listener:undefined as undefined|((status:string)=>void)}));
vi.mock('react-native',()=>({AppState:{addEventListener:()=>({remove:()=>{}})}}));
vi.mock('@/auth/tokenStorage',()=>({TokenStorage:{setCredentials:mocks.set}}));
vi.mock('./serverConfig',()=>({commitPeerServerUrl:mocks.url}));
vi.mock('./apiSocket',()=>({apiSocket:{peerConnected:()=>mocks.connected,peerCanReconnect:()=>mocks.reconnect,peerEndpoint:()=>mocks.endpoint,peerHttpProof:()=>mocks.proof,onStatusChange:(listener:(status:string)=>void)=>{mocks.listener=listener;return()=>{};},switchPeerChannel:mocks.switch}}));
vi.mock('./peerNetwork',()=>({peerAuthorization:()=> 'sealed-device-proof',decodePeerResponse:(_peer:any,value:any)=>value,setPeerRouteWriteFence:()=>{},peerRouteWritable:()=>true,peerResponseHeaders:()=>({})}));
import{getConnectionSnapshot,initializeCodelyncConnection,selectConnection,suspendCodelyncAutomaticRecovery,recoverCodelyncConnection,probeCodelyncChannel,readCodelyncChannelManifest}from'./codelyncConnection';
const channels=[{id:'local',kind:'local' as const,url:'http://192.168.1.2:8800'},{id:'relay',kind:'relay' as const,url:'https://relay.example'}];
const credentials={token:'fixture',secret:'fixture-secret',serverUrl:channels[0].url,peer:{id:'fixture-peer',key:'fixture-key',channels,device:{publicKey:'fixture-public',secretKey:'fixture-private'},automatic:true,selectedChannel:'local'}};
afterEach(()=>{initializeCodelyncConnection({token:'fixture',secret:'fixture'});mocks.set.mockClear();mocks.url.mockClear();mocks.switch.mockReset().mockImplementation(async(endpoint:string)=>{mocks.endpoint=endpoint;});mocks.reconnect=false;mocks.connected=true;mocks.endpoint=channels[0].url;mocks.proof=null;vi.unstubAllGlobals();});
it('automatic choice uses the first authenticated available channel and keeps peer identity',async()=>{
 initializeCodelyncConnection(credentials);
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url.startsWith('http:'))await new Promise(r=>setTimeout(r,30));return{ok:true,json:async()=>({version:1,channels})};}));
 await selectConnection('auto');expect(getConnectionSnapshot().selectedId).toBe('relay');expect(getConnectionSnapshot().peerId).toBe('fixture-peer');
 expect(mocks.switch.mock.calls[0][0]).toBe(channels[1].url);
});
it('native channel selection works without DOM static AbortSignal helpers',async()=>{
 initializeCodelyncConnection(credentials);
 vi.stubGlobal('AbortSignal', class NativeSignal {});
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({version:1,channels})}));
 await expect(selectConnection('relay')).resolves.toBeUndefined();
 expect(getConnectionSnapshot().selectedId).toBe('relay');
});
it('an offline manual choice persists intent and preserves the previous actual route',async()=>{
 initializeCodelyncConnection(credentials);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false}));
 await expect(selectConnection('relay')).rejects.toThrow();expect(getConnectionSnapshot()).toMatchObject({selectedId:'relay',activeId:'local',automatic:false});expect(mocks.set).toHaveBeenCalledOnce();expect(mocks.set.mock.lastCall?.[0]).toMatchObject({token:credentials.token,secret:credentials.secret,serverUrl:channels[0].url,peer:{key:credentials.peer.key,device:credentials.peer.device},connectionPreference:{mode:'manual',kind:'relay',channelId:'relay'}});
});
it('a failed socket switch restores the working account/channel',async()=>{
 initializeCodelyncConnection(credentials);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({version:1,channels})}));mocks.switch.mockRejectedValueOnce(Error('socket failed'));
 await expect(selectConnection('relay')).rejects.toThrow();expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({token:credentials.token,secret:credentials.secret,serverUrl:channels[0].url,connectionPreference:expect.objectContaining({mode:'manual',kind:'relay'})}));expect(mocks.url).toHaveBeenLastCalledWith(channels[0].url);expect(getConnectionSnapshot()).toMatchObject({selectedId:'relay',activeId:'local',automatic:false});
});
it('keeps a reachable relay readable while its realtime socket recovers and retains refreshed LAN candidates',async()=>{
 const updatedChannels=[{...channels[0],url:'http://192.168.1.2:9900'},channels[1]];
 initializeCodelyncConnection(credentials);
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:!url.includes(':8800'),json:async()=>({version:1,channels:updatedChannels})})));
 mocks.connected=false;
 await selectConnection('auto');
 expect(mocks.switch.mock.calls.map(call=>call[0])).toEqual([channels[1].url]);
 expect(getConnectionSnapshot()).toMatchObject({selectedId:'relay',readable:true,realtimeRecovering:true,connecting:false});
 expect(mocks.switch).toHaveBeenCalledWith(channels[1].url,expect.anything(),{waitForSocket:false});
 expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({serverUrl:channels[1].url,peer:expect.objectContaining({id:'fixture-peer',channels:updatedChannels})}));
});
it('a cold-start connection error triggers automatic recovery once while a probe is pending',async()=>{
 mocks.reconnect=true;mocks.connected=false;initializeCodelyncConnection(credentials);
 mocks.switch.mockImplementation(async()=>{mocks.connected=true;});
 let finish!:(value:any)=>void;const pending=new Promise(resolve=>{finish=resolve;});
 const fetch=vi.fn(()=>pending);vi.stubGlobal('fetch',fetch);
 mocks.listener!('error');mocks.listener!('error');
 await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
 finish({ok:true,json:async()=>({version:1,channels})});
 await vi.waitFor(()=>expect(getConnectionSnapshot().connecting).toBe(false));
 expect(mocks.switch).not.toHaveBeenCalled();
 expect(getConnectionSnapshot()).toMatchObject({readable:true,realtimeRecovering:true});
});
it('the same paired Mac selection coalesces repeated presses before proving or saving twice',async()=>{
 initializeCodelyncConnection(credentials);let finish!:(value:any)=>void;const response=new Promise(resolve=>{finish=resolve;});
 const fetch=vi.fn(()=>response);vi.stubGlobal('fetch',fetch);
 const first=selectConnection('relay'),second=selectConnection('relay');expect(first).toBe(second);await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(channels.length));
 finish({ok:true,json:async()=>({version:1,channels})});await first;expect(mocks.set).toHaveBeenCalledTimes(2);expect(mocks.switch).toHaveBeenCalledOnce();
});
it('a resolved readable switch without a live socket publishes recovery without claiming connected',async()=>{
 mocks.connected=false;initializeCodelyncConnection(credentials);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({version:1,channels})}));
 await expect(selectConnection('relay')).resolves.toBeUndefined();
 expect(getConnectionSnapshot().channels.some(channel=>channel.state==='connected')).toBe(false);
 expect(getConnectionSnapshot()).toMatchObject({connecting:false,readable:true,realtimeRecovering:true});
});
it('unsealed access refusals keep the pairing and remain connection failures',async()=>{
 initializeCodelyncConnection(credentials);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:403}));
 await expect(selectConnection('auto')).rejects.toThrow();
 expect(getConnectionSnapshot()).toMatchObject({peerId:credentials.peer.id,selectedId:'local',failureCode:'connection-failed',connecting:false});
 expect(mocks.set).toHaveBeenCalledOnce();
});
it('an old selection failure cannot mark a new paired Mac failed',async()=>{
 initializeCodelyncConnection(credentials);let finish!:(value:any)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{finish=resolve;})));
 const old=selectConnection('relay');const rejection=expect(old).rejects.toThrow();const next={...credentials,peer:{...credentials.peer,id:'new-paired-peer'}};initializeCodelyncConnection(next);
 await rejection;expect(getConnectionSnapshot()).toMatchObject({peerId:'new-paired-peer',connecting:false});
 expect(getConnectionSnapshot().failureCode).toBeUndefined();expect(mocks.set).not.toHaveBeenCalled();
});
it('socket retry events preserve a recently authenticated HTTP route without probing or reinitializing it',async()=>{
 mocks.connected=false;mocks.reconnect=true;initializeCodelyncConnection(credentials);
 mocks.proof={peerId:'fixture-peer',endpoint:channels[0].url,observedAt:Date.now()};
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);mocks.listener!('error');mocks.listener!('error');
 expect(getConnectionSnapshot()).toMatchObject({readable:true,realtimeRecovering:true,selectedId:'local'});
 expect(fetch).not.toHaveBeenCalled();expect(mocks.switch).not.toHaveBeenCalled();
});
it('an explicit automatic choice probes all routes even when an old HTTP proof exists',async()=>{
 mocks.connected=false;mocks.reconnect=true;initializeCodelyncConnection(credentials);
 mocks.proof={peerId:'fixture-peer',endpoint:channels[0].url,observedAt:Date.now()-30000};
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({version:1,channels})});vi.stubGlobal('fetch',fetch);
 await selectConnection('auto');expect(fetch).toHaveBeenCalledTimes(channels.length+1);expect(fetch.mock.calls[0][0]).toContain(channels[0].url);
 expect(mocks.switch).not.toHaveBeenCalled();expect(getConnectionSnapshot()).toMatchObject({readable:true,realtimeRecovering:true,selectedId:'local'});
});

it('startup locator suspends error recovery and releases the ordinary selector once on absence/failure', async () => {
 mocks.connected=false;mocks.reconnect=true;
 const release=suspendCodelyncAutomaticRecovery(credentials);initializeCodelyncConnection(credentials);
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({version:1,channels})});vi.stubGlobal('fetch',fetch);
 mocks.listener!('error');mocks.listener!('disconnected');expect(fetch).not.toHaveBeenCalled();
 release();release();await selectConnection('auto');
 expect(fetch).toHaveBeenCalledTimes(channels.length+1);expect(mocks.set).toHaveBeenCalledOnce();
});
it('a readable locator succeeds without a competing or second automatic selector', async () => {
 mocks.connected=false;mocks.reconnect=true;
 const release=suspendCodelyncAutomaticRecovery(credentials);initializeCodelyncConnection(credentials);
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({version:1,channels})});vi.stubGlobal('fetch',fetch);
 mocks.listener!('error');expect(fetch).not.toHaveBeenCalled();
 await selectConnection('auto');const probes=fetch.mock.calls.length;release();await Promise.resolve();
 expect(fetch).toHaveBeenCalledTimes(probes);expect(mocks.set).toHaveBeenCalledOnce();
 expect(getConnectionSnapshot()).toMatchObject({readable:true,realtimeRecovering:true});
});
it('an old startup owner release cannot initiate recovery or mark a new pairing', async () => {
 mocks.connected=false;mocks.reconnect=true;
 const oldRelease=suspendCodelyncAutomaticRecovery(credentials);initializeCodelyncConnection(credentials);mocks.listener!('error');
 const next={...credentials,peer:{...credentials.peer,id:'new-owner'}};const newRelease=suspendCodelyncAutomaticRecovery(next);initializeCodelyncConnection(next);
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({version:1,channels})});vi.stubGlobal('fetch',fetch);
 mocks.listener!('error');oldRelease();expect(fetch).not.toHaveBeenCalled();expect(mocks.set).not.toHaveBeenCalled();
 expect(getConnectionSnapshot().peerId).toBe('new-owner');
 newRelease();await selectConnection('auto');expect(mocks.set.mock.lastCall?.[0].peer.id).toBe('new-owner');
});
it('a cleared pairing cannot be revived by a suspended old startup release', async () => {
 mocks.connected=false;mocks.reconnect=true;
 const release=suspendCodelyncAutomaticRecovery(credentials);initializeCodelyncConnection(credentials);mocks.listener!('error');
 initializeCodelyncConnection({token:'fixture',secret:'fixture'});const fetch=vi.fn();vi.stubGlobal('fetch',fetch);release();
 expect(fetch).not.toHaveBeenCalled();expect(getConnectionSnapshot()).toMatchObject({peerId:null,connecting:false});
});

it('a saved offline manual kind survives restart without changing the actual route or keys',async()=>{
 initializeCodelyncConnection(credentials);vi.stubGlobal('fetch',vi.fn().mockRejectedValue(Error('offline')));
 await expect(selectConnection('relay')).rejects.toThrow();const saved=mocks.set.mock.lastCall![0];
 initializeCodelyncConnection(saved);expect(getConnectionSnapshot()).toMatchObject({automatic:false,selectedId:'relay',activeId:'local',desiredKind:'relay'});
 expect(saved).toMatchObject({token:credentials.token,secret:credentials.secret,peer:{id:credentials.peer.id,key:credentials.peer.key,device:credentials.peer.device}});
});
it('late automatic storage/proof cannot overwrite a newer explicit manual intent',async()=>{
 initializeCodelyncConnection(credentials);let complete!:()=>void;
 mocks.set.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{complete=()=>resolve(true);}));
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,json:async()=>({version:1,channels})})));
 const old=selectConnection('auto'),oldFailure=expect(old).rejects.toThrow();await vi.waitFor(()=>expect(complete).toBeTypeOf('function'));
 const manual=selectConnection('relay');expect(getConnectionSnapshot()).toMatchObject({automatic:false,selectedId:'relay'});
 complete();await oldFailure;await manual;expect(mocks.set.mock.lastCall![0].connectionPreference).toMatchObject({mode:'manual',kind:'relay',channelId:'relay'});
 expect(getConnectionSnapshot()).toMatchObject({automatic:false,selectedId:'relay',activeId:'relay'});
});
it('manual Local discovers a new Local ID through Relay without committing Relay or exposing an intermediate missing credential',async()=>{
 const newLocal={id:'local-new-ip',kind:'local' as const,url:'http://192.168.2.4:9900'},fresh=[newLocal,channels[1]];
 const manual={...credentials,peer:{...credentials.peer,automatic:false},connectionPreference:{peerId:credentials.peer.id,devicePublicKey:credentials.peer.device.publicKey,mode:'manual' as const,channelId:'local',kind:'local' as const}};
 initializeCodelyncConnection(manual);mocks.set.mockImplementation(async(value:any)=>{if(value.serverUrl===newLocal.url&&mocks.endpoint===channels[0].url)expect(value.peer.channels.some((c:any)=>c.url===channels[0].url)).toBe(true);return true;});
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:!url.startsWith(channels[0].url),status:url.startsWith(channels[0].url)?401:200,json:async()=>url.endsWith('/network-probe')?{version:1}:{channels:fresh}})));
 await recoverCodelyncConnection();expect(mocks.switch.mock.calls.map(c=>c[0])).toEqual([newLocal.url]);
 expect(getConnectionSnapshot()).toMatchObject({automatic:false,selectedId:newLocal.id,activeId:newLocal.id,desiredKind:'local'});
 expect(mocks.set.mock.lastCall![0].peer.channels).toEqual(fresh);
});
it('all fast probes start concurrently and a failing winner manifest falls through to another proved route',async()=>{
 initializeCodelyncConnection(credentials);const seen:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{seen.push(url);if(url===channels[0].url+'/api/peer/channels')return {ok:false,status:503,json:async()=>({})};return{ok:true,status:200,json:async()=>url.endsWith('/network-probe')?{version:1}:{channels}};}));
 await selectConnection('auto');expect(seen.slice(0,2)).toEqual(channels.map(c=>c.url+'/network-probe'));expect(getConnectionSnapshot().activeId).toBe('relay');
 expect(seen.filter(url=>url.endsWith('/api/peer/channels'))).toEqual(channels.map(c=>c.url+'/api/peer/channels'));
});
it('tiny and manifest limits cancel oversized bodies; legacy fallback is one request within the original fast deadline',async()=>{
 const cancel=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,headers:{get:()=> '5000'},body:{cancel},json:async()=>({version:1})})));
 await expect(probeCodelyncChannel(channels[0],credentials)).rejects.toThrow('too large');expect(cancel).toHaveBeenCalledOnce();
 const fetch=vi.fn().mockResolvedValueOnce({ok:false,status:404}).mockResolvedValueOnce({ok:true,status:200,json:async()=>({channels})});vi.stubGlobal('fetch',fetch);
 const proof=await probeCodelyncChannel(channels[0],credentials);expect(proof.legacyChannels).toEqual(channels);expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[0][1].signal).toBe(fetch.mock.calls[1][1].signal);
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,headers:{get:()=> '20000'},body:{cancel},json:async()=>({channels})})));
 await expect(readCodelyncChannelManifest({channel:channels[0],latencyMs:1},credentials)).rejects.toThrow('too large');
});

it('new manual intent retires late automatic network results without replacing its admitted route',async()=>{
 initializeCodelyncConnection(credentials);let finish!:(value:any)=>void;const oldResponse=new Promise(resolve=>{finish=resolve;});let oldCount=0;
 const fetch=vi.fn(async(url:string)=>{if(url.endsWith('/network-probe')&&oldCount++<2)return oldResponse;return{ok:true,status:200,json:async()=>url.endsWith('/network-probe')?{version:1}:{channels}};});vi.stubGlobal('fetch',fetch);
 const old=selectConnection('auto'),oldFailure=expect(old).rejects.toThrow();await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
 await selectConnection('relay');finish({ok:true,status:200,json:async()=>({version:1})});await oldFailure;
 expect(getConnectionSnapshot()).toMatchObject({automatic:false,selectedId:'relay',activeId:'relay'});expect(mocks.switch.mock.calls.map(c=>c[0])).toEqual([channels[1].url]);
});
it('a hanging fast LAN request aborts within the short route-only budget',async()=>{
 vi.useFakeTimers();let aborted=false;vi.stubGlobal('fetch',vi.fn((_url:string,options:any)=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));});})));
 try{const probe=probeCodelyncChannel(channels[0],credentials),rejected=expect(probe).rejects.toThrow('aborted');await vi.advanceTimersByTimeAsync(1501);await rejected;expect(aborted).toBe(true);}finally{vi.useRealTimers();}
});
