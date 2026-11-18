import * as React from 'react';
// @ts-expect-error react-test-renderer has no local declaration file in this workspace
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    dark: false,
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
    dimensions: { width: 402, height: 874 },
}));

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const themeFixture = () => ({
    dark: state.dark,
    colors: {
        text: state.dark ? '#ffffff' : '#000000',
        textDestructive: state.dark ? '#FF453A' : '#FF3B30',
        textSecondary: '#8E8E93',
        textLink: '#2BACCC',
        surface: state.dark ? '#161616' : '#ffffff',
        surfaceRipple: 'rgba(0,0,0,0.08)',
        surfacePressedOverlay: state.dark ? '#242424' : '#D1D1D6',
        divider: state.dark ? '#2A2A2A' : '#eaeaea',
        glass: { divider: 'rgba(60, 60, 67, 0.12)' },
        groupped: { background: state.dark ? '#000000' : '#F2F2F7', chevron: '#C7C7CC' },
        radio: { active: '#007AFF', inactive: '#C0C0C0', dot: '#007AFF' },
    },
});

vi.mock('react-native', () => {
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        ActivityIndicator: host('ActivityIndicator'),
        Modal: (props: any) => props.visible ? React.createElement('Modal', props, props.children) : null,
        Platform: { OS: 'ios', select: (v: Record<string, any>) => v.ios ?? v.default },
        Pressable: ({ children, ...rest }: any) => React.createElement(
            'Pressable',
            rest,
            typeof children === 'function' ? children({ pressed: false }) : children,
        ),
        ScrollView: host('ScrollView'),
        Text: host('Text'),
        View: host('View'),
        useWindowDimensions: () => state.dimensions,
    };
});

vi.mock('react-native-reanimated', () => ({
    __esModule: true,
    default: { View: (props: any) => React.createElement('AnimatedView', props, props.children) },
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => state.insets,
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        hairlineWidth: 0.5,
        absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
        create: (arg: any) =>
            typeof arg === 'function'
                ? new Proxy({}, { get: (_t, prop) => arg(themeFixture())[prop as string] })
                : arg,
    },
    useUnistyles: () => ({ theme: themeFixture() }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/useCodelyncConnectionState', () => ({ useCodelyncConnectionState: vi.fn() }));
vi.mock('@/sync/codelyncConnection', () => ({
    getConnectionSnapshot: vi.fn(),
    retryCodelyncConnection: vi.fn(),
    selectConnection: vi.fn(),
}));
vi.mock('./PeerChannelControlView', () => ({
    PeerChannelControlView: (props: any) => React.createElement('PeerChannelControlView', props),
}));
vi.mock('./BubblePressable', () => ({
    BubblePressable: (props: any) => React.createElement('BubblePressable', props, props.children),
}));

import { CodelyncConnectionNoticeView } from './CodelyncConnectionNotice';
import { PickerSheet, PickerSheetOption, PickerSheetPanel } from './PickerSheet';
import { Item } from './Item';
import { ItemList } from './ItemList';

function flattenStyle(style: any): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    if (typeof style === 'function') return flattenStyle(style({ pressed: false }));
    if (typeof style === 'object') return style;
    return {};
}

describe('Track D Batch 9 — R084 & R089 polish', () => {
    beforeEach(() => {
        state.dark = false;
        state.insets = { top: 47, bottom: 34, left: 0, right: 0 };
        state.dimensions = { width: 402, height: 874 };
    });

    it('R084: CodelyncConnectionNotice dims disabled/busy retry button, adds hairline bottom divider, respects topInset, and clears z-index', () => {
        state.dark = true;
        let resolveRetry!: () => void;
        const onRetry = vi.fn(() => new Promise<void>((res) => { resolveRetry = res; }));
        const snapshot: any = { peerId: 'mac-1', selectedId: 'local', automatic: true, connecting: false, channels: [] };

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncConnectionNoticeView, {
                state: { kind: 'failed', canRetry: true, canInspect: true, busy: false } as any,
                snapshot,
                topInset: 96,
                onRetry,
                onSelect: vi.fn(),
                onScan: vi.fn(),
            }));
        });

        const root = renderer.root.findByProps({ testID: 'codelync-mac-connection-notice' });
        expect(flattenStyle(root.props.style)).toMatchObject({
            paddingTop: 108,
            borderBottomWidth: 0.5,
            borderBottomColor: '#2A2A2A',
            zIndex: 1,
        });

        const idleRetry = renderer.root.findByProps({ testID: 'codelync-retry-mac-connection' });
        expect(flattenStyle(idleRetry.props.style).opacity).toBe(1);

        act(() => {
            idleRetry.props.onPress();
        });
        const busyRetry = renderer.root.findByProps({ testID: 'codelync-retry-mac-connection' });
        expect(busyRetry.props.disabled).toBe(true);
        expect(busyRetry.props.accessibilityState).toEqual({ disabled: true, busy: true });
        expect(flattenStyle(busyRetry.props.style).opacity).toBe(0.45);

        act(() => resolveRetry());

        // Access ended state exposes scan action with explicit accessibilityLabel
        act(() => {
            renderer.update(React.createElement(CodelyncConnectionNoticeView, {
                state: { kind: 'access-ended', canRetry: false, canInspect: false, busy: false } as any,
                snapshot,
                topInset: 96,
                onRetry,
                onSelect: vi.fn(),
                onScan: vi.fn(),
            }));
        });
        const scanBtn = renderer.root.findByProps({ testID: 'codelync-scan-current-mac' });
        expect(scanBtn.props.accessibilityLabel).toBe('codelyncChannels.scanMac');
        act(() => renderer.unmount());
    });

    it('R089: PickerSheet clamps Dynamic Type / landscape height, honors horizontal insets, deepens dark scrim, and wraps 2-line option labels', () => {
        state.dark = true;
        state.dimensions = { width: 852, height: 390 };
        state.insets = { top: 47, bottom: 21, left: 59, right: 59 };

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(
                PickerSheet,
                {
                    visible: true,
                    title: '選択してください — 長いタイトル',
                    onClose: vi.fn(),
                    children: React.createElement(PickerSheetOption, {
                        testID: 'opt-1',
                        label: '只读模式（仅查看，不修改文件）',
                        description: '長い説明文がダイナミックタイプで省略されずに表示されることを確認します',
                        selected: true,
                        onPress: vi.fn(),
                    }),
                },
            ));
        });

        const modalRoot = renderer.root.findByType('Modal').findAllByType('View')[0];
        expect(flattenStyle(modalRoot.props.style)).toMatchObject({
            paddingLeft: 59,
            paddingRight: 59,
        });

        const scrim = renderer.root.findByType('Modal').findAllByType('Pressable')[0];
        expect(flattenStyle(scrim.props.style)).toMatchObject({
            backgroundColor: '#000000',
            opacity: 0.56,
        });

        const panel = renderer.root.findByType(PickerSheetPanel);
        expect(panel.props.style).toMatchObject({
            maxHeight: 273,
            paddingBottom: 21,
        });

        const headerTitle = renderer.root.findByProps({ accessibilityRole: 'header' });
        expect(headerTitle.props.numberOfLines).toBe(2);

        const optTexts = renderer.root.findByProps({ testID: 'opt-1' }).findAllByType('Text');
        expect(optTexts[0].props.numberOfLines).toBe(2);
        expect(flattenStyle(optTexts[0].props.style).minWidth).toBe(0);
        expect(optTexts[1].props.numberOfLines).toBe(3);

        act(() => renderer.unmount());
    });

    it('R089: Item aligns multi-line ZH/JA detail values without clipping and ItemList honors landscape horizontal and bottom safe-area insets', () => {
        state.insets = { top: 0, bottom: 21, left: 59, right: 59 };

        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(
                ItemList,
                {
                    children: React.createElement(Item, {
                        title: 'チャネル接続設定',
                        detail: '接続済み · 自動選択ルート',
                        onPress: vi.fn(),
                    }),
                },
            ));
        });

        const scroll = renderer.root.findByType('ScrollView');
        expect(scroll.props.keyboardShouldPersistTaps).toBe('handled');
        expect(flattenStyle(scroll.props.contentContainerStyle)).toMatchObject({
            paddingBottom: 37,
            paddingLeft: 59,
            paddingRight: 59,
        });

        const pressable = renderer.root.findByType('BubblePressable');
        expect(pressable.props.accessibilityRole).toBe('button');
        expect(pressable.props.accessibilityState).toEqual({ disabled: false, selected: undefined });

        const texts = renderer.root.findAllByType('Text');
        expect(texts[0].props.numberOfLines).toBe(3);
        expect(texts[1].props.numberOfLines).toBe(2);
        expect(flattenStyle(texts[1].props.style)).toMatchObject({
            flexShrink: 1,
            minWidth: 0,
            textAlign: 'right',
            lineHeight: 22,
        });

        const chevron = renderer.root.findByType('Ionicons');
        expect(flattenStyle(chevron.props.style).flexShrink).toBe(0);

        act(() => renderer.unmount());
    });
});
