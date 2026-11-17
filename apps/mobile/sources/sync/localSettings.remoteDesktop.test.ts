import { expect,it,vi } from 'vitest';
const disk=vi.hoisted(()=>new Map<string,string>());
vi.mock('react-native-mmkv',()=>({MMKV:class{getString=(key:string)=>disk.get(key);set=(key:string,value:string)=>{disk.set(key,value)};delete=(key:string)=>{disk.delete(key)}}}));
import { loadLocalSettings,saveLocalSettings } from './persistence';
import { applyLocalSettings,localSettingsParse } from './localSettings';
it('first install and a record with previous desktop visits remain disabled',()=>{
 disk.clear();expect(loadLocalSettings().remoteDesktopEnabled).toBe(false);
 disk.set('codelync-local-settings',JSON.stringify({themePreference:'dark',lastScreen:'/desktop',remoteDesktopVisited:true}));
 expect(loadLocalSettings()).toMatchObject({remoteDesktopEnabled:false,themePreference:'dark'});expect(localSettingsParse({remoteDesktopEnabled:'true'}).remoteDesktopEnabled).toBe(false);
});
it('does not adopt Remote Desktop enablement from the previous product storage key',()=>{
 disk.clear();disk.set('local-settings',JSON.stringify({remoteDesktopEnabled:true}));expect(loadLocalSettings().remoteDesktopEnabled).toBe(false);
 expect(disk.get('local-settings')).toBe(JSON.stringify({remoteDesktopEnabled:true}));
});
it('explicit local enable and disable survive the existing storage reload',()=>{
 disk.clear();saveLocalSettings(applyLocalSettings(loadLocalSettings(),{remoteDesktopEnabled:true}));expect(loadLocalSettings().remoteDesktopEnabled).toBe(true);
 saveLocalSettings(applyLocalSettings(loadLocalSettings(),{remoteDesktopEnabled:false}));expect(loadLocalSettings().remoteDesktopEnabled).toBe(false);
});
