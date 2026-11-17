import * as React from 'react';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), push: vi.fn(), scan: vi.fn().mockResolvedValue(undefined), select: vi.fn().mockResolvedValue(undefined), setTheme: vi.fn(),setDesktop:vi.fn(), applyTheme: vi.fn() }));
vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('expo-router', () => ({ useRouter: () => ({ navigate: mocks.navigate, push: mocks.push }) }));
vi.mock('expo-application', () => ({ nativeApplicationVersion: '0.5.0', nativeBuildVersion: '2026110112' }));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.5.0' } } }));
vi.mock('@/auth/CodelyncPairingProvider', () => ({ useCodelyncPairing: () => ({ scan: mocks.scan }) }));
vi.mock('@/sync/storage', () => ({ useLocalSettingMutable: (key:string) => key==='remoteDesktopEnabled'?[false,mocks.setDesktop]:['adaptive', mocks.setTheme], useSetting: () => 'en' }));
vi.mock('@/sync/codelyncConnection', () => ({ getConnectionSnapshot: () => snapshot, subscribeConnection: () => () => {}, selectConnection: mocks.select }));
vi.mock('@/utils/appThemePreference', () => ({ applyAppThemePreference: mocks.applyTheme }));
vi.mock('@/text/resolveLanguage', () => ({ resolvePreferredLanguage: (value: string) => value, resolveLanguage: () => 'en' }));
vi.mock('@/text', () => ({ getLanguageNativeName: (value: string) => value, t: (key: string) => key }));
vi.mock('./CodelyncBottomNavigation',()=>({codelyncTopLevelRoute:(page:string)=>page==='sessions'?'/':page==='desktop'?'/desktop':'/settings'}));
vi.mock('./CodelyncSettingsView', () => ({ CodelyncSettingsView: (props: any) => React.createElement('SettingsContent', props) }));
import { CodelyncSettings } from './CodelyncSettings';
const snapshot = { peerId: 'original-peer', channels: [], selectedId: null, automatic: true, connecting: false };
afterEach(() => { Object.values(mocks).forEach(mock => mock.mockClear()); });

it('mounting global settings subscribes without selecting a route, pairing or changing preferences', () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(CodelyncSettings)); });
    const content = renderer.root.findByType('SettingsContent');
    expect(content.props.snapshot).toBe(snapshot); expect(content.props.version).toBe('0.5.0 · 2026110112');
    expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.scan).not.toHaveBeenCalled(); expect(mocks.setTheme).not.toHaveBeenCalled();
    act(() => renderer.unmount());
});

it('explicit preferences and top-level navigation use the existing owners and preserve the router page', async () => {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(CodelyncSettings)); });
    const content = renderer.root.findByType('SettingsContent');
    act(() => { content.props.onNavigate('sessions'); content.props.onLanguage(); content.props.onThemeChange('dark'); });
    expect(mocks.navigate).toHaveBeenCalledWith('/'); expect(mocks.push).toHaveBeenCalledWith('/settings/language');
    expect(mocks.setTheme).toHaveBeenCalledWith('dark'); expect(mocks.applyTheme).toHaveBeenCalledWith('dark'); expect(mocks.select).not.toHaveBeenCalled();
    await act(async () => { await content.props.onSelectConnection('existing-relay'); content.props.onScan(); });
    expect(mocks.select).toHaveBeenCalledWith('existing-relay'); expect(mocks.scan).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
});

it('Remote Desktop is off until its explicit local settings switch is changed',()=>{
 let renderer!:ReturnType<typeof create>;act(()=>{renderer=create(React.createElement(CodelyncSettings));});const content=renderer.root.findByType('SettingsContent');
 expect(content.props.remoteDesktopEnabled).toBe(false);expect(mocks.setDesktop).not.toHaveBeenCalled();act(()=>content.props.onRemoteDesktopChange(true));
 expect(mocks.setDesktop).toHaveBeenCalledExactlyOnceWith(true);expect(mocks.select).not.toHaveBeenCalled();expect(mocks.scan).not.toHaveBeenCalled();act(()=>renderer.unmount());
});
