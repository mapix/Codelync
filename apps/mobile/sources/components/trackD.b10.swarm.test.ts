import * as React from 'react';
// @ts-expect-error react-test-renderer has no local declaration file in this workspace
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
    (globalThis as any).__DEV__ = false;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    return {
        dark: true,
        insets: { top: 47, bottom: 34, left: 44, right: 44 },
        language: 'ja' as 'en' | 'zh-Hans' | 'zh-Hant' | 'ja',
        headerOptions: null as any,
    };
});

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'ja' }] }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-modules-core', () => ({
    requireNativeModule: () => ({}),
    requireOptionalNativeModule: () => null,
    EventEmitter: class {},
}));

const themeFixture = () => ({
    dark: state.dark,
    colors: {
        text: state.dark ? '#FFFFFF' : '#000000',
        textDestructive: state.dark ? '#FF453A' : '#FF3B30',
        textSecondary: '#8E8E93',
        textLink: '#2BACCC',
        warning: '#FF9500',
        success: '#34C759',
        surface: state.dark ? '#161616' : '#FFFFFF',
        surfaceHigh: state.dark ? '#222222' : '#F8F8F8',
        surfaceSelected: state.dark ? '#2C2C2E' : '#E5E5EA',
        surfacePressedOverlay: state.dark ? '#242424' : '#D1D1D6',
        divider: state.dark ? '#2A2A2A' : '#EAEAEA',
        glass: {
            border: 'rgba(255,255,255,0.12)',
            background: 'rgba(30,30,30,0.8)',
            backgroundStrong: 'rgba(40,40,40,0.9)',
            backgroundSubtle: 'rgba(255,255,255,0.08)',
        },
        groupped: { background: state.dark ? '#000000' : '#F2F2F7', chevron: '#C7C7CC' },
        header: { tint: state.dark ? '#FFFFFF' : '#000000' },
        input: {
            background: state.dark ? '#1E1E1E' : '#F5F5F5',
            text: state.dark ? '#FFFFFF' : '#000000',
            placeholder: '#8E8E93',
        },
        button: { primary: { background: '#000000', tint: '#FFFFFF', disabled: '#C0C0C0' } },
        diff: {
            addedText: '#34C759',
            addedBg: 'rgba(52,199,89,0.12)',
            addedBorder: '#34C759',
            removedText: '#FF453A',
            removedBg: 'rgba(255,69,58,0.12)',
            removedBorder: '#FF453A',
            hunkHeaderText: '#2BACCC',
            hunkHeaderBg: 'rgba(43,172,204,0.12)',
            contextText: state.dark ? '#E5E5EA' : '#1C1C1E',
        },
    },
});

vi.mock('react-native', () => {
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        ActivityIndicator: host('ActivityIndicator'),
        KeyboardAvoidingView: host('KeyboardAvoidingView'),
        Modal: (props: any) => props.visible ? React.createElement('Modal', props, props.children) : null,
        Platform: { OS: 'ios', select: (v: Record<string, any>) => v.ios ?? v.default },
        Pressable: ({ children, ...rest }: any) => React.createElement(
            'Pressable',
            typeof rest.style === 'function' ? { ...rest, style: rest.style({ pressed: false }) } : rest,
            typeof children === 'function' ? children({ pressed: false }) : children,
        ),
        ScrollView: host('ScrollView'),
        Text: host('Text'),
        TextInput: host('TextInput'),
        View: host('View'),
    };
});

vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => state.insets }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 0.5,
        create: (arg: any) =>
            typeof arg === 'function'
                ? new Proxy({}, { get: (_t, prop) => arg(themeFixture())[prop as string] })
                : arg,
    },
    useUnistyles: () => ({ theme: themeFixture() }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn(), dismissTo: vi.fn() }),
    useLocalSearchParams: () => ({
        id: 'session-1',
        path: Buffer.from('src/App.tsx').toString('base64'),
        textId: 'text-1',
    }),
    useNavigation: () => ({
        setOptions: (opts: any) => { state.headerOptions = opts; },
    }),
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn(async () => false) } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/components/StyledText', () => ({ Text: (props: any) => React.createElement('Text', props, props.children) }));
vi.mock('@/components/MobileGlass', () => ({
    MobileGlassSurface: (props: any) => React.createElement('MobileGlassSurface', props, props.children),
}));
vi.mock('@/components/Item', () => ({ Item: (props: any) => React.createElement('Item', props) }));
vi.mock('@/components/ItemList', () => ({ ItemList: (props: any) => React.createElement('ItemList', props, props.children) }));
vi.mock('@/components/RoundButton', () => ({ RoundButton: (props: any) => React.createElement('RoundButton', props) }));
vi.mock('@/components/FileIcon', () => ({ FileIcon: (props: any) => React.createElement('FileIcon', props) }));
vi.mock('@/components/Shaker', () => ({ Shaker: (props: any) => React.createElement('Shaker', props, props.children) }));
vi.mock('@/components/SimpleSyntaxHighlighter', () => ({
    SimpleSyntaxHighlighter: (props: any) => React.createElement('SimpleSyntaxHighlighter', props),
}));
vi.mock('@/components/qr/QRCode', () => ({ QRCode: (props: any) => React.createElement('QRCode', props) }));
vi.mock('@/components/PickerSheet', () => ({
    PickerSheet: ({ children, ...props }: any) => React.createElement('PickerSheet', props, children),
    PickerSheetOption: (props: any) => React.createElement('PickerSheetOption', props),
}));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ login: vi.fn(), isAuthenticated: false }) }));
vi.mock('@/auth/authQRStart', () => ({ generateAuthKeyPair: () => ({ publicKey: new Uint8Array(32) }), authQRStart: vi.fn(async () => true) }));
vi.mock('@/auth/authQRWait', () => ({ authQRWait: vi.fn(async () => null) }));
vi.mock('@/auth/authGetToken', () => ({ authGetToken: vi.fn(async () => 'token') }));
vi.mock('@/auth/secretKeyBackup', () => ({ normalizeSecretKey: (s: string) => s }));
vi.mock('@/encryption/base64', () => ({ encodeBase64: () => 'abc', decodeBase64: () => new Uint8Array(32) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://example.invalid' }));
vi.mock('@/sync/persistence', () => ({ retrieveTempText: () => 'Selected content sample', loadSettings: () => ({ settings: {} }) }));
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ sessions: { 'session-1': { metadata: { path: '/repo' } } }, applyFileCache: vi.fn() }) },
    useSessionGitStatus: () => null,
    useSessionFileCache: () => ({ content: 'const x = 1;', diff: '+const x = 1;', isBinary: false }),
}));
const stableGitStatusData = {
    isLoading: false,
    data: {
        branch: 'main',
        totalStaged: 1,
        totalUnstaged: 1,
        stagedFiles: [{ fileName: 'App.tsx', filePath: 'src', fullPath: 'src/App.tsx', status: 'modified', linesAdded: 2, linesRemoved: 1 }],
        unstagedFiles: [{ fileName: 'Old.tsx', filePath: 'src', fullPath: 'src/Old.tsx', status: 'deleted', linesAdded: 0, linesRemoved: 4 }],
    },
};

vi.mock('@/hooks/useGitStatusFiles', () => ({
    useGitStatusFiles: () => stableGitStatusData,
}));
vi.mock('@/hooks/usePrefetchFileContents', () => ({ usePrefetchFileContents: vi.fn() }));
vi.mock('@/sync/suggestionFile', () => ({ searchFiles: vi.fn(async () => []) }));
vi.mock('@/sync/ops', () => ({ sessionReadFile: vi.fn(async () => ({ success: true, content: 'Y29uc3QgeCA9IDE7' })), sessionBash: vi.fn(async () => ({ success: false, stdout: '' })) }));
vi.mock('@/utils/sessionFileLinks', () => ({ resolveSessionFilePath: (p: string) => ({ absolutePath: p, withinSessionRoot: true, relativePath: p }) }));

vi.mock('@/text', () => ({
    getCurrentLanguage: () => state.language,
    t: (key: string) => key,
}));

import { en } from '@/text/_default';
import { zhHans } from '@/text/translations/zh-Hans';
import { zhHant } from '@/text/translations/zh-Hant';
import { ja } from '@/text/translations/ja';
import { codelyncActivityLabels } from '@/text/codelyncActivityLabels';
import { codelyncAgentInputLabels } from '@/text/codelyncAgentInputLabels';
import { codelyncChannelLabels } from '@/text/codelyncChannelLabels';
import { codelyncMediaLabels } from '@/text/codelyncMediaLabels';
import { codelyncSubagentLabels, codelyncSubagentInteractionLabels } from '@/text/codelyncSubagentLabels';
import { codelyncTaskLabels } from '@/text/codelyncTaskLabels';
import { codelyncToolGroupLabels } from '@/text/codelyncToolGroupLabels';
import { codelyncLatestViewportLabels } from '@/text/codelyncViewportLabels';
import { nativeQueuedAdmissionLabels } from '@/text/nativeAdmissionLabels';
import { nativeParentControlLabels } from '@/text/nativeParentControlLabels';
import { nativeReadRecoveryLabels } from '@/text/nativeReadRecoveryLabels';
import { nativeSessionAvailabilityLabels } from '@/text/nativeSessionAvailabilityLabels';
import { nativeTaskActionLabels } from '@/text/nativeTaskActionLabels';
import { remoteDesktopLabelsFor } from '@/text/remoteDesktopLabels';
import { PeerChannelControlView, type PeerChannelSnapshot } from './PeerChannelControlView';
import FilesScreen from '@/app/(app)/session/[id]/files';
import FileScreen from '@/app/(app)/session/[id]/file';
import TextSelectionScreen from '@/app/(app)/text-selection';
import RestoreScreen from '@/app/(app)/restore/index';
import RestoreManualScreen from '@/app/(app)/restore/manual';

const snapshot: PeerChannelSnapshot = {
    peerId: 'mac-1',
    selectedId: 'local-id',
    activeId: 'cloud-id',
    desiredKind: 'local',
    automatic: false,
    connecting: false,
    channels: [
        { id: 'local-id', kind: 'local', url: 'http://192.0.2.10:4567', state: 'available' },
        { id: 'cloud-id', kind: 'cloudflare', url: 'https://tunnel.example', state: 'connected', latencyMs: 42 },
    ],
};

describe('Track D Batch 10 — R094 localization parity & R099 route/channel polish', () => {
    beforeEach(() => {
        state.dark = true;
        state.insets = { top: 47, bottom: 34, left: 44, right: 44 };
        state.language = 'ja';
        state.headerOptions = null;
    });

    it('R094: zh-Hans, zh-Hant, and ja provide explicit non-English translations across message, windowControl, server, onboarding offline states, and resumeSession', () => {
        const cjk = { 'zh-Hans': zhHans, 'zh-Hant': zhHant, ja };
        for (const [lang, tr] of Object.entries(cjk)) {
            for (const key of ['sentAsGoal', 'sendsAfterThisTurn', 'sending'] as const) {
                expect(tr.message[key].trim().length, `${lang}.message.${key}`).toBeGreaterThan(0);
                expect(tr.message[key], `${lang}.message.${key}`).not.toBe(en.message[key]);
            }
            for (const key of Object.keys(en.windowControl) as Array<keyof typeof en.windowControl>) {
                expect(tr.windowControl[key].trim().length, `${lang}.windowControl.${key}`).toBeGreaterThan(0);
                expect(tr.windowControl[key], `${lang}.windowControl.${key}`).not.toBe(en.windowControl[key]);
            }
            for (const key of ['title', 'serverUrlLabel', 'selfHostFooter'] as const) {
                expect(tr.server[key].trim().length, `${lang}.server.${key}`).toBeGreaterThan(0);
                expect(tr.server[key], `${lang}.server.${key}`).not.toBe(en.server[key]);
            }
            for (const key of ['resumeSession', 'resumeSessionSubtitle', 'resumeSessionMachineOffline'] as const) {
                expect(tr.sessionInfo[key].trim().length, `${lang}.sessionInfo.${key}`).toBeGreaterThan(0);
                expect(tr.sessionInfo[key], `${lang}.sessionInfo.${key}`).not.toBe(en.sessionInfo[key]);
            }
            expect(tr.onboarding.offlineTitleOne({ name: 'MacBook' })).toContain('MacBook');
            expect(tr.onboarding.offlineTitleOne({ name: 'MacBook' })).not.toBe(en.onboarding.offlineTitleOne({ name: 'MacBook' }));
            expect(tr.onboarding.offlineLinkedStep({ name: 'MacBook' })).not.toBe(en.onboarding.offlineLinkedStep({ name: 'MacBook' }));
            expect(tr.onboarding.offlineLinkedStepMany({ count: 2 })).toContain('2');
            expect(tr.onboarding.offlineLinkedStepMany({ count: 2 })).not.toBe(en.onboarding.offlineLinkedStepMany({ count: 2 }));
            expect(tr.onboarding.terminalRun).toBe('open /Applications/Codelync.app');
            expect(tr.welcome.title).toContain('Codex');
            expect(tr.welcome.title).toContain('Antigravity');
            expect(tr.welcome.title).toContain('Claude Desktop');
        }
    });

    it('R094: all Labels dictionaries cover en, zh-Hans, zh-Hant, and ja with matching keys and non-empty strings', () => {
        const dictionaries = [
            codelyncActivityLabels,
            codelyncAgentInputLabels,
            codelyncChannelLabels,
            codelyncMediaLabels,
            codelyncSubagentLabels,
            codelyncSubagentInteractionLabels,
            codelyncTaskLabels,
            nativeParentControlLabels,
            nativeReadRecoveryLabels,
            nativeSessionAvailabilityLabels,
            nativeTaskActionLabels,
        ];
        for (const dict of dictionaries) {
            const enKeys = Object.keys((dict as any).en).sort();
            for (const lang of ['zh-Hans', 'zh-Hant', 'ja'] as const) {
                expect(Object.keys((dict as any)[lang]).sort()).toEqual(enKeys);
            }
        }
        for (const lang of ['en', 'zh-Hans', 'zh-Hant', 'ja'] as const) {
            expect(codelyncToolGroupLabels[lang](3)).toContain('3');
            expect(codelyncLatestViewportLabels[lang].trim().length).toBeGreaterThan(0);
            expect(nativeQueuedAdmissionLabels[lang].trim().length).toBeGreaterThan(0);
            expect(remoteDesktopLabelsFor(lang).connect.trim().length).toBeGreaterThan(0);
        }
    });

    it('R099 (#85): PeerChannelControlView compact pill wraps up to 2 lines with vertical padding and bounded icon shrink under multi-part CJK route labels', () => {
        state.language = 'ja';
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(PeerChannelControlView, {
                snapshot,
                onSelect: vi.fn(async () => {}),
                presentation: 'compact',
            }));
        });
        const trigger = renderer.root.findByProps({ testID: 'codelync-channel-open' });
        expect(trigger.props.style).toMatchObject({ minHeight: 44, paddingVertical: 6, paddingHorizontal: 12 });
        const texts = trigger.findAllByType('Text');
        expect(texts).toHaveLength(1);
        expect(texts[0].props.numberOfLines).toBe(2);
        expect(texts[0].props.style).toMatchObject({ flexShrink: 1, minWidth: 0, lineHeight: 18 });
        expect(texts[0].props.children).toContain(codelyncChannelLabels.ja.desired);
        expect(texts[0].props.children).toContain(codelyncChannelLabels.ja.current);
        const icons = trigger.findAllByType('Ionicons');
        expect(icons.every((icon: any) => icon.props.style?.flexShrink === 0)).toBe(true);
        act(() => renderer.unmount());
    });

    it('R099: FilesScreen applies Dark Mode input text color, keyboardShouldPersistTaps, landscape safe-area insets, and theme tokens', () => {
        let renderer!: ReturnType<typeof create>;
        act(() => { renderer = create(React.createElement(FilesScreen)); });
        const root = renderer.root.findByType('View');
        expect(root.props.style[1]).toMatchObject({ paddingLeft: 44, paddingRight: 44 });
        const searchInput = renderer.root.findByType('TextInput');
        expect(searchInput.props.style.color).toBe('#FFFFFF');
        expect(searchInput.props.accessibilityLabel).toBe('files.searchPlaceholder');
        const list = renderer.root.findByType('ItemList');
        expect(list.props.keyboardShouldPersistTaps).toBe('handled');
        const items = renderer.root.findAllByType('Item');
        let deletedBadge!: ReturnType<typeof create>;
        act(() => { deletedBadge = create(items[1].props.rightElement); });
        expect(deletedBadge.root.findByType('Text').props.style.color).toBe('#FF453A');
        act(() => { deletedBadge.unmount(); renderer.unmount(); });
    });

    it('R099: FileScreen Diff/File toggles have >=44pt hit targets, high-contrast selected tokens, radio/button semantics, and safe-area insets', () => {
        let renderer!: ReturnType<typeof create>;
        act(() => { renderer = create(React.createElement(FileScreen)); });
        const pressables = renderer.root.findAllByType('Pressable');
        expect(pressables).toHaveLength(2);
        for (const p of pressables) {
            expect(p.props.accessibilityRole).toBe('button');
            expect(p.props.style.minHeight).toBeGreaterThanOrEqual(44);
        }
        expect(pressables[0].props.accessibilityState).toEqual({ selected: true });
        expect(pressables[0].props.style.backgroundColor).toBe('#000000');
        expect(pressables[0].findByType('Text').props.style.color).toBe('#FFFFFF');
        expect(pressables[1].props.accessibilityState).toEqual({ selected: false });
        const scroll = renderer.root.findByType('ScrollView');
        expect(scroll.props.contentContainerStyle).toMatchObject({ paddingBottom: 50, paddingLeft: 44, paddingRight: 44 });
        act(() => renderer.unmount());
    });

    it('R099: TextSelectionScreen and Restore routes satisfy >=44pt header controls, landscape/bottom safe areas, and keyboard/input accessibility', () => {
        let selRenderer!: ReturnType<typeof create>;
        act(() => { selRenderer = create(React.createElement(TextSelectionScreen)); });
        let headerBtnRenderer!: ReturnType<typeof create>;
        act(() => { headerBtnRenderer = create(state.headerOptions.headerRight()); });
        const copyBtn = headerBtnRenderer.root.findByType('Pressable');
        expect(copyBtn.props.accessibilityRole).toBe('button');
        expect(copyBtn.props.accessibilityLabel).toBe('common.copy');
        expect(copyBtn.props.style[0]).toMatchObject({ minWidth: 44, minHeight: 44 });
        const glass = selRenderer.root.findByType('MobileGlassSurface');
        expect(glass.props.style[1]).toMatchObject({ marginLeft: 44, marginRight: 44 });
        act(() => { headerBtnRenderer.unmount(); selRenderer.unmount(); });

        let restoreRenderer!: ReturnType<typeof create>;
        act(() => { restoreRenderer = create(React.createElement(RestoreScreen)); });
        expect(restoreRenderer.root.findByType('ScrollView').props.contentContainerStyle[1]).toMatchObject({ paddingBottom: 50, paddingLeft: 60, paddingRight: 60 });
        act(() => restoreRenderer.unmount());

        let manualRenderer!: ReturnType<typeof create>;
        act(() => { manualRenderer = create(React.createElement(RestoreManualScreen)); });
        const manualScroll = manualRenderer.root.findByType('ScrollView');
        expect(manualScroll.props.keyboardShouldPersistTaps).toBe('handled');
        expect(manualScroll.props.contentContainerStyle[1]).toMatchObject({ paddingBottom: 50, paddingLeft: 60, paddingRight: 60 });
        expect(manualRenderer.root.findByType('TextInput').props.accessibilityLabel).toBe('onboarding.secretKeyTitle');
        act(() => manualRenderer.unmount());
    });
});
