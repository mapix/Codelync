import { afterEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({set:vi.fn().mockResolvedValue(true),url:vi.fn(),switch:vi.fn().mockResolvedValue(undefined), reconnect:false, connected:true, endpoint:'http://192.168.1.2:8800', proof:null as null|{peerId:string;endpoint:string;observedAt:number}, listener:undefined as undefined|((status:string)=>void)}));
vi.mock('@/auth/tokenStorage',()=>({TokenStorage:{setCredentials:mocks.set}}));
vi.mock('./serverConfig',()=>({commitPeerServerUrl:mocks.url}));
vi.mock('./apiSocket',()=>({apiSocket:{peerConnected:()=>mocks.connected,peerCanReconnect:()=>mocks.reconnect,peerEndpoint:()=>mocks.endpoint,peerHttpProof:()=>mocks.proof,onStatusChange:(listener:(status:string)=>void)=>{mocks.listener=listener;return()=>{};},switchPeerChannel:mocks.switch}}));
vi.mock('./peerNetwork',()=>({peerAuthorization:()=> 'sealed-device-proof',decodePeerResponse:(_peer:any,value:any)=>value}));
import{getConnectionSnapshot,initializeCodeLightConnection,selectConnection,suspendCodeLightAutomaticRecovery}from'./codeLightConnection';
const channels=[{id:'local',kind:'local' as const,url:'http://192.168.1.2:8800'},{id:'relay',kind:'relay' as const,url:'https://relay.example'}];
const credentials={token:'fixture',secret:'fixture-secret',serverUrl:channels[0].url,peer:{id:'fixture-peer',key:'fixture-key',channels,device:{publicKey:'fixture-public',secretKey:'fixture-private'},automatic:true,selectedChannel:'local'}};
afterEach(()=>{initializeCodeLightConnection({token:'fixture',secret:'fixture'});mocks.set.mockClear();mocks.url.mockClear();mocks.switch.mockReset().mockImplementation(async(endpoint:string)=>{mocks.endpoint=endpoint;});mocks.reconnect=false;mocks.connected=true;mocks.endpoint=channels[0].url;mocks.proof=null;vi.unstubAllGlobals();});
it('automatic choice uses the first authenticated available channel and keeps peer identity',async()=>{
 initializeCodeLightConnection(credentials);
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url.startsWith('http:'))await new Promise(r=>setTimeout(r,30));return{ok:true,json:async()=>({channels})};}));
 await selectConnection('auto');expect(getConnectionSnapshot().selectedId).toBe('relay');expect(getConnectionSnapshot().peerId).toBe('fixture-peer');
 expect(mocks.switch.mock.calls[0][0]).toBe(channels[1].url);
});
it('native channel selection works without DOM static AbortSignal helpers',async()=>{
 initializeCodeLightConnection(credentials);
 vi.stubGlobal('AbortSignal', class NativeSignal {});
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({channels})}));
 await expect(selectConnection('relay')).resolves.toBeUndefined();
 expect(getConnectionSnapshot().selectedId).toBe('relay');
});
it('a failed proof keeps the previous selected channel and does not save credentials',async()=>{
 initializeCodeLightConnection(credentials);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false}));
 await expect(selectConnection('relay')).rejects.toThrow();expect(getConnectionSnapshot().selectedId).toBe('local');expect(mocks.set).not.toHaveBeenCalled();
});
it('a failed socket switch restores the working account/channel',async()=>{
 initializeCodeLightConnection(credentials);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({channels})}));mocks.switch.mockRejectedValueOnce(Error('socket failed'));
 await expect(selectConnection('relay')).rejects.toThrow();expect(mocks.set).toHaveBeenLastCalledWith(credentials);expect(mocks.url).toHaveBeenLastCalledWith(channels[0].url);expect(getConnectionSnapshot().selectedId).toBe('local');
});
it('keeps a reachable relay readable while its realtime socket recovers and retains refreshed LAN candidates',async()=>{
 const updatedChannels=[{...channels[0],url:'http://192.168.1.2:9900'},channels[1]];
 initializeCodeLightConnection(credentials);
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:!url.includes(':8800'),json:async()=>({channels:updatedChannels})})));
 mocks.connected=false;
 await selectConnection('auto');
 expect(mocks.switch.mock.calls.map(call=>call[0])).toEqual([channels[1].url]);
 expect(getConnectionSnapshot()).toMatchObject({selectedId:'relay',readable:true,realtimeRecovering:true,connecting:false});
 expect(mocks.switch).toHaveBeenCalledWith(channels[1].url,expect.anything(),{waitForSocket:false});
 expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({serverUrl:channels[1].url,peer:expect.objectContaining({id:'fixture-peer',channels:updatedChannels})}));
});
it('a cold-start connection error triggers automatic recovery once while a probe is pending',async()=>{
 mocks.reconnect=true;mocks.connected=false;initializeCodeLightConnection(credentials);
 mocks.switch.mockImplementation(async()=>{mocks.connected=true;});
 let finish!:(value:any)=>void;const pending=new Promise(resolve=>{finish=resolve;});
 const fetch=vi.fn(()=>pending);vi.stubGlobal('fetch',fetch);
 mocks.listener!('error');mocks.listener!('error');
 await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
 finish({ok:true,json:async()=>({channels})});
 await vi.waitFor(()=>expect(getConnectionSnapshot().connecting).toBe(false));
 expect(mocks.switch).not.toHaveBeenCalled();
 expect(getConnectionSnapshot()).toMatchObject({readable:true,realtimeRecovering:true});
});
it('the same paired Mac selection coalesces repeated presses before proving or saving twice',async()=>{
 initializeCodeLightConnection(credentials);let finish!:(value:any)=>void;const response=new Promise(resolve=>{finish=resolve;});
 const fetch=vi.fn(()=>response);vi.stubGlobal('fetch',fetch);
 const first=selectConnection('relay'),second=selectConnection('relay');expect(first).toBe(second);expect(fetch).toHaveBeenCalledOnce();
 finish({ok:true,json:async()=>({channels})});await first;expect(mocks.set).toHaveBeenCalledOnce();expect(mocks.switch).toHaveBeenCalledOnce();
});
it('a resolved readable switch without a live socket publishes recovery without claiming connected',async()=>{
 mocks.connected=false;initializeCodeLightConnection(credentials);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({channels})}));
 await expect(selectConnection('relay')).resolves.toBeUndefined();
 expect(getConnectionSnapshot().channels.some(channel=>channel.state==='connected')).toBe(false);
 expect(getConnectionSnapshot()).toMatchObject({connecting:false,readable:true,realtimeRecovering:true});
});
it('an exhausted access refusal retains pairing and requires an explicit recovery action',async()=>{
 initializeCodeLightConnection(credentials);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:403}));
 await expect(selectConnection('auto')).rejects.toThrow();
 expect(getConnectionSnapshot()).toMatchObject({peerId:credentials.peer.id,selectedId:'local',failureCode:'access-ended',connecting:false});
 expect(mocks.set).not.toHaveBeenCalled();
});
it('an old selection failure cannot mark a new paired Mac failed',async()=>{
 initializeCodeLightConnection(credentials);let finish!:(value:any)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{finish=resolve;})));
 const old=selectConnection('relay');const next={...credentials,peer:{...credentials.peer,id:'new-paired-peer'}};initializeCodeLightConnection(next);
 finish({ok:false});await expect(old).rejects.toThrow();expect(getConnectionSnapshot()).toMatchObject({peerId:'new-paired-peer',connecting:false});
 expect(getConnectionSnapshot().failureCode).toBeUndefined();expect(mocks.set).not.toHaveBeenCalled();
});
it('socket retry events preserve a recently authenticated HTTP route without probing or reinitializing it',async()=>{
 mocks.connected=false;mocks.reconnect=true;initializeCodeLightConnection(credentials);
 mocks.proof={peerId:'fixture-peer',endpoint:channels[0].url,observedAt:Date.now()};
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);mocks.listener!('error');mocks.listener!('error');
 expect(getConnectionSnapshot()).toMatchObject({readable:true,realtimeRecovering:true,selectedId:'local'});
 expect(fetch).not.toHaveBeenCalled();expect(mocks.switch).not.toHaveBeenCalled();
});
it('an expired HTTP proof rechecks the same reachable route before considering faster alternatives',async()=>{
 mocks.connected=false;mocks.reconnect=true;initializeCodeLightConnection(credentials);
 mocks.proof={peerId:'fixture-peer',endpoint:channels[0].url,observedAt:Date.now()-30000};
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({channels})});vi.stubGlobal('fetch',fetch);
 await selectConnection('auto');expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0][0]).toContain(channels[0].url);
 expect(mocks.switch).not.toHaveBeenCalled();expect(getConnectionSnapshot()).toMatchObject({readable:true,realtimeRecovering:true,selectedId:'local'});
});

it('startup locator suspends error recovery and releases the ordinary selector once on absence/failure', async () => {
 mocks.connected=false;mocks.reconnect=true;
 const release=suspendCodeLightAutomaticRecovery(credentials);initializeCodeLightConnection(credentials);
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({channels})});vi.stubGlobal('fetch',fetch);
 mocks.listener!('error');mocks.listener!('disconnected');expect(fetch).not.toHaveBeenCalled();
 release();release();await selectConnection('auto');
 expect(fetch).toHaveBeenCalledTimes(channels.length);expect(mocks.set).toHaveBeenCalledOnce();
});
it('a readable locator succeeds without a competing or second automatic selector', async () => {
 mocks.connected=false;mocks.reconnect=true;
 const release=suspendCodeLightAutomaticRecovery(credentials);initializeCodeLightConnection(credentials);
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({channels})});vi.stubGlobal('fetch',fetch);
 mocks.listener!('error');expect(fetch).not.toHaveBeenCalled();
 await selectConnection('auto');const probes=fetch.mock.calls.length;release();await Promise.resolve();
 expect(fetch).toHaveBeenCalledTimes(probes);expect(mocks.set).toHaveBeenCalledOnce();
 expect(getConnectionSnapshot()).toMatchObject({readable:true,realtimeRecovering:true});
});
it('an old startup owner release cannot initiate recovery or mark a new pairing', async () => {
 mocks.connected=false;mocks.reconnect=true;
 const oldRelease=suspendCodeLightAutomaticRecovery(credentials);initializeCodeLightConnection(credentials);mocks.listener!('error');
 const next={...credentials,peer:{...credentials.peer,id:'new-owner'}};const newRelease=suspendCodeLightAutomaticRecovery(next);initializeCodeLightConnection(next);
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({channels})});vi.stubGlobal('fetch',fetch);
 mocks.listener!('error');oldRelease();expect(fetch).not.toHaveBeenCalled();expect(mocks.set).not.toHaveBeenCalled();
 expect(getConnectionSnapshot().peerId).toBe('new-owner');
 newRelease();await selectConnection('auto');expect(mocks.set.mock.lastCall?.[0].peer.id).toBe('new-owner');
});
it('a cleared pairing cannot be revived by a suspended old startup release', async () => {
 mocks.connected=false;mocks.reconnect=true;
 const release=suspendCodeLightAutomaticRecovery(credentials);initializeCodeLightConnection(credentials);mocks.listener!('error');
 initializeCodeLightConnection({token:'fixture',secret:'fixture'});const fetch=vi.fn();vi.stubGlobal('fetch',fetch);release();
 expect(fetch).not.toHaveBeenCalled();expect(getConnectionSnapshot()).toMatchObject({peerId:null,connecting:false});
});
