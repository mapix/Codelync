import * as React from 'react';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 34 }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ navigate: vi.fn() }) }));
vi.mock('@/sync/storage',()=>({useLocalSetting:()=>false}));
vi.mock('./StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key, getCurrentLanguage: () => 'en' }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { surface: 'white', divider: 'gray', textLink: 'blue', textSecondary: 'gray', surfacePressed: 'silver' } };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (factory: any) => factory(theme), hairlineWidth: 1 } };
});
import { CodelyncBottomNavigationView } from './CodelyncBottomNavigation';

it('top-level tabs expose the selected page and reselecting it does not navigate or reload', () => {
    const navigate = vi.fn(); let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(CodelyncBottomNavigationView, { active: 'settings', onNavigate: navigate,remoteDesktopEnabled:true })); });
    const settings = renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === 'codelync-tab-settings')[0];
    const sessions = renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === 'codelync-tab-sessions')[0];
    const desktop = renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === 'codelync-tab-desktop')[0];
    expect(settings.props.accessibilityState.selected).toBe(true); expect(sessions.props.accessibilityState.selected).toBe(false);
    act(() => settings.props.onPress()); expect(navigate).not.toHaveBeenCalled();
    act(() => sessions.props.onPress()); expect(navigate).toHaveBeenCalledOnce(); expect(navigate).toHaveBeenCalledWith('sessions');
    act(() => desktop.props.onPress()); expect(navigate).toHaveBeenLastCalledWith('desktop');
    act(() => renderer.unmount());
});

it('the default phone navigation hides Remote Desktop and only explicit enablement adds it',()=>{
 let renderer!:ReturnType<typeof create>;const props={active:'sessions' as const,onNavigate:vi.fn()};act(()=>{renderer=create(React.createElement(CodelyncBottomNavigationView,props));});
 expect(renderer.root.findAllByProps({testID:'codelync-tab-desktop'})).toHaveLength(0);act(()=>renderer.update(React.createElement(CodelyncBottomNavigationView,{...props,remoteDesktopEnabled:true})));
 expect(renderer.root.findAllByProps({testID:'codelync-tab-desktop'}).length).toBeGreaterThan(0);act(()=>renderer.update(React.createElement(CodelyncBottomNavigationView,{...props,remoteDesktopEnabled:false})));
 expect(renderer.root.findAllByProps({testID:'codelync-tab-desktop'})).toHaveLength(0);act(()=>renderer.unmount());
});
