import * as React from 'react';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { darkTheme, lightTheme } from '@/theme';

const state = vi.hoisted(() => ({
    dark: false,
    language: 'en' as 'en' | 'zh-Hans' | 'zh-Hant' | 'ja',
    platform: 'ios' as 'ios' | 'android' | 'web',
    insets: { top: 0, bottom: 21, left: 59, right: 59 },
}));

vi.hoisted(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('__DEV__', false);
});

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        Platform: {
            get OS() { return state.platform; },
            select: (values: any) => values[state.platform] ?? values.default,
        },
        ActivityIndicator: host('ActivityIndicator'),
        KeyboardAvoidingView: host('KeyboardAvoidingView'),
        Modal: host('Modal'),
        Pressable: host('Pressable'),
        ScrollView: host('ScrollView'),
        Switch: host('Switch'),
        Text: host('Text'),
        TextInput: host('TextInput'),
        TouchableOpacity: host('TouchableOpacity'),
        View: host('View'),
    };
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => state.insets,
}));

vi.mock('react-native-unistyles', () => {
    const getTheme = () => (state.dark ? darkTheme : lightTheme);
    return {
        useUnistyles: () => ({ theme: getTheme() }),
        StyleSheet: {
            hairlineWidth: 0.5,
            create: (factory: unknown) => {
                if (typeof factory !== 'function') return factory;
                return new Proxy({}, {
                    get(_target, prop) {
                        const resolved = (factory as (theme: typeof lightTheme, runtime: unknown) => Record<string, unknown>)(getTheme(), {});
                        return resolved[prop as string];
                    },
                });
            },
        },
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));
vi.mock('expo-router', () => ({
    useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ sessions: {} }) },
    useLocalSetting: () => true,
    useSession: () => null,
    useSocketStatus: () => ({ status: 'connected' }),
}));
vi.mock('@/sync/ops', () => ({
    sessionAnswerQuestion: vi.fn(async () => {}),
    sessionCancelCommunication: vi.fn(async () => {}),
}));
vi.mock('@/sync/apiSocket', () => ({
    apiSocket: { peerConnected: () => true },
}));
vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), logo: () => ({}), mono: () => ({}) },
}));
vi.mock('@/text', () => ({
    getCurrentLanguage: () => state.language,
    t: (key: string) => key,
}));
vi.mock('./StyledText', () => ({
    Text: 'Text',
}));
vi.mock('./tools/ToolSectionView', () => ({
    ToolSectionView: (props: any) => React.createElement('ToolSectionView', props, props.children),
}));
vi.mock('./Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));
vi.mock('./ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('./CodelyncMark', () => ({
    CodelyncMark: (props: any) => React.createElement('CodelyncMark', props),
}));
vi.mock('./PeerChannelControlView', () => ({
    PeerChannelControlView: (props: any) => React.createElement('PeerChannelControlView', props),
}));
vi.mock('./PickerSheet', () => ({
    PickerSheet: (props: any) => React.createElement('PickerSheet', props, props.children),
    PickerSheetOption: (props: any) => React.createElement('PickerSheetOption', props),
}));

import { InlineQuestionForm } from './tools/views/InlineQuestionForm';
import { AgentQuestionModal } from './AgentQuestionModal';
import { CodelyncBottomNavigationView } from './CodelyncBottomNavigation';
import { CodelyncSettingsView } from './CodelyncSettingsView';

function flattenStyle(style: unknown): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, any>>((acc, item) => ({ ...acc, ...flattenStyle(item) }), {});
    }
    return typeof style === 'object' ? (style as Record<string, any>) : {};
}

beforeEach(() => {
    state.dark = false;
    state.language = 'en';
    state.platform = 'ios';
    state.insets = { top: 0, bottom: 21, left: 59, right: 59 };
    vi.clearAllMocks();
});

describe('Track D Batch 4 — R034 InlineQuestionForm & AgentQuestionModal contrast + keyboard spacing', () => {
    it('improves dark-mode border/checkmark/CTA contrast, adds accessibility roles, and preserves manual submit', async () => {
        state.dark = true;
        const onSubmit = vi.fn(async () => {});
        const questions = [
            {
                id: 'q1',
                header: 'Mode',
                question: 'Pick options',
                multiSelect: true,
                required: true,
                options: [
                    { label: 'Alpha', description: 'First choice' },
                    { label: 'Beta' },
                ],
            },
        ];

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(InlineQuestionForm, {
                questions,
                canInteract: true,
                onSubmit,
            }));
        });

        const checkboxes = renderer.root.findAll((n: any) => n.type === 'TouchableOpacity' && n.props?.accessibilityRole === 'checkbox');
        expect(checkboxes).toHaveLength(2);
        expect(checkboxes[0].props.accessibilityLabel).toBe('Alpha, First choice');
        expect(checkboxes[0].props.accessibilityState).toEqual({ checked: false, selected: false, disabled: false });

        // Crisp dark border on option card & unselected checkbox
        expect(flattenStyle(checkboxes[0].props.style).borderColor).toBe('rgba(255, 255, 255, 0.14)');
        const boxViewBefore = checkboxes[0].findAllByType('View').find((v: any) => flattenStyle(v.props.style).borderRadius === 4);
        expect(flattenStyle(boxViewBefore.props.style).borderColor).toBe('#98989D');

        // Disabled Submit button before selection
        const submitBtnBefore = renderer.root.findAll((n: any) => n.type === 'TouchableOpacity' && n.props?.accessibilityRole === 'button')[0];
        expect(submitBtnBefore.props.disabled).toBe(true);

        // Tap option -> updates checked state, renders white checkmark on radio.active, NEVER auto-submits
        act(() => {
            checkboxes[0].props.onPress();
        });
        expect(onSubmit).not.toHaveBeenCalled();

        const checkboxesAfter = renderer.root.findAll((n: any) => n.type === 'TouchableOpacity' && n.props?.accessibilityRole === 'checkbox');
        expect(checkboxesAfter[0].props.accessibilityState).toEqual({ checked: true, selected: true, disabled: false });
        const checkIcon = checkboxesAfter[0].findByType('Ionicons');
        expect(checkIcon.props.color).toBe('#fff');

        // Ready Submit button fills with darkTheme.colors.radio.active & #FFFFFF text
        const submitBtnAfter = renderer.root.findAll((n: any) => n.type === 'TouchableOpacity' && n.props?.accessibilityRole === 'button')[0];
        expect(submitBtnAfter.props.disabled).toBe(false);
        expect(flattenStyle(submitBtnAfter.props.style).backgroundColor).toBe(darkTheme.colors.radio.active);
        const submitText = submitBtnAfter.findByType('Text');
        expect(flattenStyle(submitText.props.style).color).toBe('#FFFFFF');

        await act(async () => {
            await submitBtnAfter.props.onPress();
        });
        expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ q1: ['Alpha'] });
        act(() => renderer.unmount());
    });

    it('improves dark checkbox/customInput border contrast and iOS keyboard spacing on AgentQuestionModal', () => {
        state.dark = true;
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(AgentQuestionModal, {
                pending: {
                    id: 'p1',
                    createdAt: 1,
                    kind: 'form',
                    questions: [
                        { id: 'q1', header: 'Choice', question: 'Select', options: [{ label: 'One' }], required: true, allowCustom: true },
                    ],
                },
                sessionId: 's1',
                visible: true,
                onClose: vi.fn(),
            }));
        });

        const scroll = renderer.root.findByType('ScrollView');
        expect(scroll.props.automaticallyAdjustKeyboardInsets).toBe(true);
        expect(flattenStyle(scroll.props.contentContainerStyle).paddingBottom).toBe(28);

        const option = renderer.root.findByProps({ testID: 'codelync-question-option-q1-0' });
        const checkbox = option.findAllByType('View').find((v: any) => flattenStyle(v.props.style).borderRadius === 6);
        expect(flattenStyle(checkbox.props.style).borderColor).toBe('#98989D');

        const customInput = renderer.root.findByProps({ testID: 'codelync-question-custom-q1' });
        expect(flattenStyle(customInput.props.style).borderColor).toBe('rgba(255, 255, 255, 0.16)');

        act(() => renderer.unmount());
    });
});

describe('Track D Batch 4 — R039 CodelyncBottomNavigation & CodelyncSettingsView landscape insets + JA overflow', () => {
    it('applies horizontal landscape safe-area insets and single-line fit/truncation for Japanese tabs', () => {
        state.language = 'ja';
        state.insets = { top: 0, bottom: 21, left: 59, right: 59 };
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncBottomNavigationView, {
                active: 'sessions',
                onNavigate: vi.fn(),
                remoteDesktopEnabled: true,
            }));
        });

        const tablist = renderer.root.findAll((n: any) => n.type === 'View' && n.props?.accessibilityRole === 'tablist')[0];
        const tablistStyle = flattenStyle(tablist.props.style);
        expect(tablistStyle.paddingLeft).toBe(59);
        expect(tablistStyle.paddingRight).toBe(59);
        expect(tablistStyle.paddingBottom).toBe(21);

        const desktopTab = renderer.root.findAll((n: any) => n.type === 'Pressable' && n.props?.testID === 'codelync-tab-desktop')[0];
        const tabStyle = typeof desktopTab.props.style === 'function' ? flattenStyle(desktopTab.props.style({ pressed: false })) : flattenStyle(desktopTab.props.style);
        expect(tabStyle.minWidth).toBe(0);
        expect(tabStyle.paddingHorizontal).toBe(6);
        expect(tabStyle.minHeight).toBeGreaterThanOrEqual(48);

        const desktopLabel = desktopTab.findByType('Text');
        expect(desktopLabel.props.children).toBe('リモートデスクトップ');
        expect(desktopLabel.props.numberOfLines).toBe(1);
        expect(desktopLabel.props.ellipsizeMode).toBe('tail');
        expect(desktopLabel.props.adjustsFontSizeToFit).toBe(true);
        expect(desktopLabel.props.minimumFontScale).toBe(0.85);

        act(() => renderer.unmount());
    });

    it('insets CodelyncSettingsView header and scroll content horizontally while keeping root and bottom nav full-bleed', () => {
        state.insets = { top: 0, bottom: 21, left: 59, right: 59 };
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncSettingsView, {
                snapshot: {
                    peerId: 'original-peer',
                    channels: [],
                    selectedId: null,
                    automatic: true,
                    connecting: false,
                },
                themePreference: 'adaptive',
                languageLabel: '日本語',
                version: '1.0.0',
                remoteDesktopEnabled: true,
                onRemoteDesktopChange: vi.fn(),
                onSelectConnection: vi.fn(async () => {}),
                onThemeChange: vi.fn(),
                onLanguage: vi.fn(),
                onScan: vi.fn(),
                onNavigate: vi.fn(),
            }));
        });

        const root = renderer.root.findByProps({ testID: 'codelync-settings-page' });
        const rootStyle = flattenStyle(root.props.style);
        expect(rootStyle.paddingLeft).toBeUndefined();
        expect(rootStyle.paddingRight).toBeUndefined();

        const headerText = renderer.root.findAll((n: any) => n.type === 'Text' && n.props?.accessibilityRole === 'header')[0];
        const headerContainer = headerText.parent;
        const headerStyle = flattenStyle(headerContainer.props.style);
        expect(headerStyle.paddingLeft).toBe(59);
        expect(headerStyle.paddingRight).toBe(59);

        const scroll = renderer.root.findByType('ScrollView');
        const scrollContentStyle = flattenStyle(scroll.props.contentContainerStyle);
        expect(scrollContentStyle.paddingLeft).toBe(59);
        expect(scrollContentStyle.paddingRight).toBe(59);

        const tablist = renderer.root.findAll((n: any) => n.type === 'View' && n.props?.accessibilityRole === 'tablist')[0];
        expect(flattenStyle(tablist.props.style).paddingLeft).toBe(59);
        expect(flattenStyle(tablist.props.style).paddingRight).toBe(59);

        act(() => renderer.unmount());
    });
});
