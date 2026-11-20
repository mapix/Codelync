import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act,create } from 'react-test-renderer';
import { expect,it,vi,afterEach } from 'vitest';
const state=vi.hoisted(()=>({
 enabled:false,
 focused:true,
 paired:true,
 mounted:vi.fn(),
 setOrientation:null as null | ((mode:'portrait'|'landscape')=>void),
}));
vi.hoisted(()=>vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true));
vi.mock('expo-router',()=>({Stack:{Screen:'Screen'},Redirect:'Redirect'}));
vi.mock('@react-navigation/native',()=>({useIsFocused:()=>state.focused}));
vi.mock('@/auth/AuthContext',()=>({useAuth:()=>({isAuthenticated:state.paired,credentials:state.paired?{peer:{id:'fixture-peer'}}:null})}));
vi.mock('@/sync/storage',()=>({useLocalSetting:()=>state.enabled}));
vi.mock('@/components/onboarding/CodelyncScanScreen',()=>({CodelyncScanScreen:()=>React.createElement('ScanScreen')}));
vi.mock('@/components/RemoteDesktopView',()=>({RemoteDesktopView:(props:{onOrientationModeChange?:(mode:'portrait'|'landscape')=>void})=>{
 state.mounted();
 state.setOrientation=props.onOrientationModeChange??null;
 return React.createElement('DesktopContent');
}}));
import DesktopScreen from '../app/(app)/desktop';
afterEach(()=>{state.enabled=false;state.focused=true;state.paired=true;state.setOrientation=null;state.mounted.mockClear();});
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
it('switches Stack.Screen orientation and statusBarHidden dynamically for portrait Phone Screen and restores portrait on blur or unpair',()=>{
 state.enabled=true;let renderer!:ReturnType<typeof create>;act(()=>{renderer=create(React.createElement(DesktopScreen));});
 expect(renderer.root.findByType('Screen').props.options).toMatchObject({orientation:'landscape',statusBarHidden:true,gestureEnabled:false,fullScreenGestureEnabled:false});
 act(()=>{state.setOrientation?.('portrait');});
 expect(renderer.root.findByType('Screen').props.options).toMatchObject({orientation:'portrait',statusBarHidden:false});
 act(()=>{state.setOrientation?.('landscape');});
 expect(renderer.root.findByType('Screen').props.options).toMatchObject({orientation:'landscape',statusBarHidden:true});
 state.focused=false;act(()=>renderer.update(React.createElement(DesktopScreen)));
 expect(renderer.root.findByType('Screen').props.options).toMatchObject({orientation:'portrait',statusBarHidden:false});
 state.focused=true;state.paired=false;act(()=>renderer.update(React.createElement(DesktopScreen)));
 expect(renderer.root.findByType('Screen').props.options).toMatchObject({orientation:'portrait',statusBarHidden:false});
 expect(renderer.root.findAllByType('ScanScreen')).toHaveLength(1);
 act(()=>renderer.unmount());
});
