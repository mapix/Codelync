import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act,create } from 'react-test-renderer';
import { expect,it,vi,afterEach } from 'vitest';
const state=vi.hoisted(()=>({enabled:false,mounted:vi.fn()}));
vi.hoisted(()=>vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true));
vi.mock('expo-router',()=>({Stack:{Screen:'Screen'},Redirect:'Redirect'}));
vi.mock('@react-navigation/native',()=>({useIsFocused:()=>true}));
vi.mock('@/auth/AuthContext',()=>({useAuth:()=>({isAuthenticated:true,credentials:{peer:{id:'fixture-peer'}}})}));
vi.mock('@/sync/storage',()=>({useLocalSetting:()=>state.enabled}));
vi.mock('@/components/onboarding/CodelyncScanScreen',()=>({CodelyncScanScreen:()=>null}));
vi.mock('@/components/RemoteDesktopView',()=>({RemoteDesktopView:()=>{state.mounted();return React.createElement('DesktopContent');}}));
import DesktopScreen from '../app/(app)/desktop';
afterEach(()=>{state.enabled=false;state.mounted.mockClear();});
it('disabled direct/deep route redirects to Settings without mounting a desktop controller',()=>{
 let renderer!:ReturnType<typeof create>;act(()=>{renderer=create(React.createElement(DesktopScreen));});
 expect(renderer.root.findByType('Redirect').props.href).toBe('/settings');expect(state.mounted).not.toHaveBeenCalled();act(()=>renderer.unmount());
});
it('explicit enablement admits landscape and turning it off withdraws the current route',()=>{
 state.enabled=true;let renderer!:ReturnType<typeof create>;act(()=>{renderer=create(React.createElement(DesktopScreen));});
 expect(renderer.root.findByType('Screen').props.options.orientation).toBe('landscape');expect(renderer.root.findAllByType('DesktopContent')).toHaveLength(1);
 state.enabled=false;act(()=>renderer.update(React.createElement(DesktopScreen)));expect(renderer.root.findByType('Redirect').props.href).toBe('/settings');
 expect(renderer.root.findByType('Screen').props.options.orientation).toBe('portrait');expect(renderer.root.findAllByType('DesktopContent')).toHaveLength(0);act(()=>renderer.unmount());
});
