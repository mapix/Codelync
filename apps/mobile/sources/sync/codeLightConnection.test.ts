import { afterEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({set:vi.fn().mockResolvedValue(true),url:vi.fn(),switch:vi.fn().mockResolvedValue(undefined), reconnect:false, connected:true, listener:undefined as undefined|((status:string)=>void)}));
vi.mock('@/auth/tokenStorage',()=>({TokenStorage:{setCredentials:mocks.set}}));
vi.mock('./serverConfig',()=>({commitPeerServerUrl:mocks.url}));
vi.mock('./apiSocket',()=>({apiSocket:{peerConnected:()=>mocks.connected,peerCanReconnect:()=>mocks.reconnect,onStatusChange:(listener:(status:string)=>void)=>{mocks.listener=listener;return()=>{};},switchPeerChannel:mocks.switch}}));
vi.mock('./peerNetwork',()=>({peerAuthorization:()=> 'sealed-device-proof',decodePeerResponse:(_peer:any,value:any)=>value}));
import{getConnectionSnapshot,initializeCodeLightConnection,selectConnection}from'./codeLightConnection';
const channels=[{id:'local',kind:'local' as const,url:'http://192.168.1.2:8800'},{id:'relay',kind:'relay' as const,url:'https://relay.example'}];
const credentials={token:'fixture',secret:'fixture-secret',serverUrl:channels[0].url,peer:{id:'fixture-peer',key:'fixture-key',channels,device:{publicKey:'fixture-public',secretKey:'fixture-private'},automatic:true,selectedChannel:'local'}};
afterEach(()=>{mocks.set.mockClear();mocks.url.mockClear();mocks.switch.mockReset().mockResolvedValue(undefined);mocks.reconnect=false;mocks.connected=true;vi.unstubAllGlobals();});
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
it('automatic choice tries a newly authenticated LAN address when the reachable relay has no realtime connection',async()=>{
 const updatedChannels=[{...channels[0],url:'http://192.168.1.2:9900'},channels[1]];
 initializeCodeLightConnection(credentials);
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:!url.includes(':8800'),json:async()=>({channels:updatedChannels})})));
 mocks.switch.mockRejectedValueOnce(Error('relay socket failed'));
 await selectConnection('auto');
 expect(mocks.switch.mock.calls.map(call=>call[0])).toEqual([channels[1].url,updatedChannels[0].url]);
 expect(getConnectionSnapshot().selectedId).toBe('local');
 expect(mocks.set).toHaveBeenLastCalledWith(expect.objectContaining({serverUrl:updatedChannels[0].url,peer:expect.objectContaining({id:'fixture-peer',channels:updatedChannels})}));
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
 expect(mocks.switch).toHaveBeenCalledTimes(1);
});
it('the same paired Mac selection coalesces repeated presses before proving or saving twice',async()=>{
 initializeCodeLightConnection(credentials);let finish!:(value:any)=>void;const response=new Promise(resolve=>{finish=resolve;});
 const fetch=vi.fn(()=>response);vi.stubGlobal('fetch',fetch);
 const first=selectConnection('relay'),second=selectConnection('relay');expect(first).toBe(second);expect(fetch).toHaveBeenCalledOnce();
 finish({ok:true,json:async()=>({channels})});await first;expect(mocks.set).toHaveBeenCalledOnce();expect(mocks.switch).toHaveBeenCalledOnce();
});
it('a resolved switch without a live socket cannot publish connected from an HTTP proof',async()=>{
 mocks.connected=false;initializeCodeLightConnection(credentials);vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({channels})}));
 await expect(selectConnection('relay')).rejects.toThrow('live Mac connection');
 expect(getConnectionSnapshot().channels.some(channel=>channel.state==='connected')).toBe(false);
 expect(getConnectionSnapshot()).toMatchObject({connecting:false,failureCode:'connection-failed'});
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
