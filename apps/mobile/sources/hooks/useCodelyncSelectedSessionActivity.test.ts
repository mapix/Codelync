import * as React from 'react';
// @ts-expect-error The native test renderer has no declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { nativeComposerInputReadOnly } from '@/utils/nativeComposerInputReadOnly';
import { codelyncActivitySourceScope, codelyncProjectActivityStore } from '@/sync/codelyncProjectActivity';

const state=vi.hoisted(()=>({peer:'peer:paired',request:vi.fn(),rpc:vi.fn(),seal:vi.fn((_peer:unknown,_body:Record<string,unknown>,_path:string,_method:string)=>[2,'opaque-nonce','opaque-body']),url:'https://first.invalid',foreground:'active'}));
vi.hoisted(()=>vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true));
vi.mock('react-native',()=>({AppState:{get currentState(){return state.foreground;},addEventListener:()=>({remove(){}})}}));
vi.mock('@react-navigation/native',()=>({useIsFocused:()=>true}));
vi.mock('expo-crypto',()=>({randomUUID:()=>crypto.randomUUID()}));
vi.mock('@/auth/tokenStorage',()=>({TokenStorage:{getCredentials:async()=>({peer:{id:'paired'},token:'fixture',secret:'fixture'})}}));
vi.mock('@/sync/codelyncBackgroundCache',()=>({codelyncAccountScope:async()=> 'account-digest'}));
vi.mock('@/sync/serverConfig',()=>({getServerUrl:()=>state.url}));
vi.mock('@/sync/apiSocket',()=>({apiSocket:{peerIdentity:()=>state.peer,peerRequest:state.request,machineRPC:state.rpc,onStatusChange:()=>()=>{}}}));
vi.mock('@/sync/peerNetwork',()=>({sealPeerRequest:state.seal}));
vi.mock('@/text',()=>({t:(key:string)=>key,getCurrentLanguage:()=> 'en'}));
import { useCodelyncSelectedSessionActivity,codelyncActivityScope,requestCodelyncActivity } from './useCodelyncProjectActivity';
import { useSessionStatus,type SessionStatus } from '@/utils/sessionUtils';

const session=(child=false)=>({id:'relay-parent',thinking:false,active:false,metadata:{path:'/fixture',machineId:'mac',client:{id:'noninvasive-bridge'},
    nativeSession:{isSubagent:child,projectKey:'/fixture'},capabilities:{readOnly:true,steering:false},bridge:{sourceStatus:'owner-unavailable',controlMode:'session',
        source:{app:'codex',kind:'session',id:'native-parent',hostId:'local',runtimeGeneration:'owner'}}},agentState:{}})as unknown as Session;
const mounted:ReturnType<typeof create>[]=[];
afterEach(()=>{act(()=>mounted.splice(0).forEach(root=>root.unmount()));state.request.mockReset();state.rpc.mockReset();state.seal.mockClear();state.peer='peer:paired';state.foreground='active';codelyncProjectActivityStore.reset('');});
function render(element:React.ReactElement){let root!:ReturnType<typeof create>;act(()=>{root=create(element);});mounted.push(root);return root;}

it('an inactive/preloaded or explicit child screen does not register HTTP activity',async()=>{
    function Interest({value,active}:{value:Session;active:boolean}){useCodelyncSelectedSessionActivity(value,active);return null;}
    const root=render(React.createElement(Interest,{value:session(),active:false}));await act(async()=>{await Promise.resolve();});
    expect(state.request).not.toHaveBeenCalled();
    act(()=>root.update(React.createElement(Interest,{value:session(true),active:true})));await act(async()=>{await Promise.resolve();});
    expect(state.request).not.toHaveBeenCalled();expect(state.rpc).not.toHaveBeenCalled();
});
it('an ordinary selected parent registers one row over HTTP without waiting for a socket',async()=>{
    state.request.mockResolvedValue({ok:true,status:200,json:async()=>({ok:true,version:1,epoch:'epoch',sequence:1,observedAt:100,groups:[]})});
    function Interest(){useCodelyncSelectedSessionActivity(session(),true);return null;}
    render(React.createElement(Interest));await vi.waitFor(()=>expect(state.request).toHaveBeenCalledOnce());
    const [path,options]=state.request.mock.calls[0],body=state.seal.mock.calls[0][1]as any;
    expect(path).toBe('/api/peer/activity');expect(JSON.parse(options.body)).toEqual([2,'opaque-nonce','opaque-body']);expect(body.activityProtocol).toBe(2);expect(body.groups).toHaveLength(1);
    expect(body.groups[0].sessions).toEqual([{id:'relay-parent',nativeId:'native-parent'}]);expect(state.rpc).not.toHaveBeenCalled();
    const old=await codelyncActivityScope();state.url='https://same-peer-second.invalid';expect(await codelyncActivityScope()).toBe(old);
});
it('same-source ready activity supplies only the label while cached controller connectivity and editing remain disabled',()=>{
    const value=session();let status!:SessionStatus;
    codelyncProjectActivityStore.reset('peer:paired:account-digest');
    const key=codelyncActivitySourceScope('mac','codex','local','native-parent');
    codelyncProjectActivityStore.apply('mac',{ok:true,version:1,epoch:'epoch',sequence:1,observedAt:100,groups:[{id:'selected',total:1,active:1,waiting:0,unknown:0,status:'ready',sessions:[{id:value.id,known:true,active:true,waiting:false}]}]},new Set(['selected']),new Map([['selected',new Set([value.id])]]),new Map([[value.id,key]]));
    function Status({source}:{source:Session}){status=useSessionStatus(source);return null;}
    const root=render(React.createElement(Status,{source:value}));
    expect(status).toMatchObject({state:'disconnected',isConnected:false,statusText:'Running'});expect(nativeComposerInputReadOnly(value)).toBe(true);
    state.peer='peer:foreign';act(()=>root.update(React.createElement(Status,{source:{...value}})));
    expect(status.statusText).toBe('codelyncSessionStatus.unknown');
    state.peer='peer:paired';act(()=>root.update(React.createElement(Status,{source:session(true)})));
    expect(status.statusText).toBe('codelyncSessionStatus.unknown');
    const foreign={...value,metadata:{...value.metadata!,bridge:{...value.metadata!.bridge!,source:{...value.metadata!.bridge!.source,id:'other-native'}}}};
    act(()=>root.update(React.createElement(Status,{source:foreign})));expect(status.statusText).toBe('codelyncSessionStatus.unknown');
});
it('connected native metadata without execution proof stays Unconfirmed instead of green Online/idle',()=>{
    const value=session();value.metadata!.bridge!.sourceStatus='connected';
    let status!:SessionStatus;function Status(){status=useSessionStatus(value);return null;}
    render(React.createElement(Status));expect(status).toMatchObject({isConnected:true,state:'waiting',statusText:'codelyncSessionStatus.unknown',shouldShowStatus:true,statusColor:'#999'});
    expect(value.metadata!.capabilities!.readOnly).toBe(true);
});
it('a peer change during credential loading cannot seal or post an old activity interest',async()=>{
    const pending=requestCodelyncActivity({clientId:'old-client',groups:[]});state.peer='peer:other';
    await expect(pending).rejects.toThrow('peer changed');expect(state.seal).not.toHaveBeenCalled();expect(state.request).not.toHaveBeenCalled();
});
