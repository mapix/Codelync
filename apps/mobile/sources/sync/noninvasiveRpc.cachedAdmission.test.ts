import { expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({execute:vi.fn(async()=>({ok:true})),recover:vi.fn(async()=>true),recoverDetailed:vi.fn(async()=>({confirmed:true})),sessions:{} as Record<string,any>,id:vi.fn(()=> 'new-command')}));
vi.mock('@react-native-async-storage/async-storage',()=>({default:{}}));
vi.mock('expo-crypto',()=>({randomUUID:mocks.id,CryptoDigestAlgorithm:{SHA256:'sha256'},digestStringAsync:async()=> 'hash'}));
vi.mock('./apiSocket',()=>({apiSocket:{onReconnected:()=>()=>{},peerIdentity:()=> 'peer:mac'}}));
vi.mock('./serverConfig',()=>({getServerUrl:()=> 'https://synthetic.invalid'}));
vi.mock('./storage',()=>({storage:{getState:()=>({sessions:mocks.sessions})}}));
vi.mock('./scopedNoninvasiveRpc',()=>({ScopedNoninvasiveRpc:class{
    execute=mocks.execute;recover=mocks.recover;recoverDetailed=mocks.recoverDetailed;
}}));
import { runNoninvasiveRpc,runCodeLightModelRpc,recoverCodeLightModelRpc } from './noninvasiveRpc';
const cached=()=>({id:'session',draft:'saved draft',metadata:{client:{id:'noninvasive-bridge'},bridge:{controlMode:'session',sourceStatus:'owner-unavailable',source:{app:'codex',kind:'session',id:'native',hostId:'local',runtimeGeneration:'owner'}},
    nativeReadFreshness:{version:1,mode:'cached',currentControlAuthority:false,ownerGeneration:'owner'},capabilities:{readOnly:true}}});
it('cached state rejects captured new write/read actions before journal allocation, while exact receipt recovery remains available',async()=>{
    mocks.execute.mockClear();mocks.recover.mockClear();mocks.id.mockClear();mocks.sessions={session:cached()};
    for(const method of ['permission','communication','abort','source-command','codex-controls-update','codex-controls-read']){
        await expect(runNoninvasiveRpc('session',method,{id:'retained-request'})).rejects.toMatchObject({effectMayHaveOccurred:false});
    }
    await expect(runCodeLightModelRpc('session',{model:'never-dispatched'})).rejects.toMatchObject({effectMayHaveOccurred:false});
    expect(mocks.execute).not.toHaveBeenCalled();expect(mocks.id).not.toHaveBeenCalled();
    const original={expectedModel:'original',expectedReasoningEffort:'low'};
    await recoverCodeLightModelRpc('session',original);
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith('session','codex-controls-update',original);
    expect(mocks.sessions.session.draft).toBe('saved draft');
    await runNoninvasiveRpc('session','bridge-receipt',{commandId:'original-command'});
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith('session','bridge-receipt',{commandId:'original-command'});
});
