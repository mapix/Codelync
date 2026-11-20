import * as React from 'react';
// @ts-expect-error This native workspace has no react-test-renderer declarations.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { darkTheme, lightTheme } from '@/theme';

const env = vi.hoisted(() => ({
    platform: 'android' as 'ios' | 'android' | 'web',
    keyboardListeners: new Map<string, Set<(event?: any) => void>>(),
    emitKeyboard(name: string, payload?: any) {
        for (const fn of env.keyboardListeners.get(name) ?? []) fn(payload);
    },
}));

vi.hoisted(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('__DEV__', false);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
});

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    const AnimatedValue = class {
        constructor(_v: number) {}
        interpolate() { return 1; }
    };
    return {
        Platform: {
            get OS() { return env.platform; },
            select: (values: any) => values[env.platform] ?? values.default,
        },
        Keyboard: {
            addListener: (event: string, cb: (payload?: any) => void) => {
                if (!env.keyboardListeners.has(event)) env.keyboardListeners.set(event, new Set());
                env.keyboardListeners.get(event)!.add(cb);
                return { remove: () => { env.keyboardListeners.get(event)?.delete(cb); } };
            },
        },
        Animated: {
            Value: AnimatedValue,
            timing: () => ({ start: () => {} }),
            View: host('AnimatedView'),
        },
        InteractionManager: {
            runAfterInteractions: (fn: () => void) => { fn(); return { cancel: () => {} }; },
        },
        StyleSheet: {
            create: (obj: any) => obj,
            hairlineWidth: 1,
            absoluteFillObject: {},
        },
        ActivityIndicator: host('ActivityIndicator'),
        KeyboardAvoidingView: host('KeyboardAvoidingView'),
        Modal: host('Modal'),
        Pressable: host('Pressable'),
        ScrollView: host('ScrollView'),
        Text: host('Text'),
        TextInput: host('TextInput'),
        TouchableWithoutFeedback: host('TouchableWithoutFeedback'),
        View: host('View'),
        Dimensions: { get: () => ({ width: 412, height: 915 }) },
        useWindowDimensions: () => ({ width: 412, height: 915 }),
    };
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: lightTheme }),
    StyleSheet: {
        create: (factory: any) => typeof factory === 'function' ? factory(lightTheme, { insets: { top: 24, bottom: 24 } }) : factory,
        hairlineWidth: 1,
    },
}));

vi.mock('react-native-reanimated', async () => {
    const ReactModule = await import('react');
    return {
        __esModule: true,
        default: {
            View: (props: any) => ReactModule.createElement('ReanimatedView', props, props.children),
        },
    };
});

vi.mock('@expo/vector-icons', async () => {
    const ReactModule = await import('react');
    return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});

vi.mock('@/components/StyledText', async () => {
    const ReactModule = await import('react');
    return { Text: (props: any) => ReactModule.createElement('Text', props, props.children) };
});

vi.mock('@/components/AnimatedOverlay', async () => {
    const ReactModule = await import('react');
    return { AnimatedBlurBackdrop: (props: any) => ReactModule.createElement('AnimatedBlurBackdrop', props) };
});

vi.mock('@/components/MobileGlass', async () => {
    const ReactModule = await import('react');
    return { MobileGlassSurface: (props: any) => ReactModule.createElement('MobileGlassSurface', props, props.children) };
});

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/text', () => ({
    t: (key: string) => key,
}));
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ sessions: {} }) },
    useSocketStatus: () => ({ status: 'connected' }),
    useSession: () => ({ id: 's1', metadata: { client: { id: 'noninvasive-bridge' } } }),
}));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { peerConnected: () => true } }));
vi.mock('@/sync/ops', () => ({
    sessionAnswerQuestion: vi.fn(async () => {}),
    sessionCancelCommunication: vi.fn(async () => {}),
}));

import { AgentQuestionModal } from './AgentQuestionModal';
import { WebPromptModal } from '@/modal/components/WebPromptModal';
import { shouldUseExpoNativeSettingsMenu } from './glassInteractionPolicy';

function flattenStyle(style: any): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return typeof style === 'object' ? style : {};
}

const originalConsoleError = console.error;
beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation((msg?: unknown, ...args: unknown[]) => {
        if (typeof msg === 'string' && msg.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(msg, ...args);
    });
});
afterAll(() => vi.restoreAllMocks());

describe('Android M4 UI & IME Parity', () => {
    beforeEach(() => {
        env.platform = 'android';
        env.keyboardListeners.clear();
    });

    it('AgentQuestionModal sets translucent Android bars and lifts footer above active IME', () => {
        let renderer!: ReactTestRenderer;
        act(() => {
            renderer = create(React.createElement(AgentQuestionModal, {
                visible: true,
                sessionId: 's1',
                onClose: vi.fn(),
                pending: {
                    id: 'q-1',
                    kind: 'form',
                    createdAt: 1,
                    questions: [{
                        id: 'q1',
                        header: 'Input',
                        question: 'Provide custom response',
                        options: [],
                        allowCustom: true,
                    }],
                },
            }));
        });

        const modal = renderer.root.findByType('Modal' as any);
        expect(modal.props.statusBarTranslucent).toBe(true);
        expect(modal.props.navigationBarTranslucent).toBe(true);

        const submitButton = renderer.root.findByProps({ testID: 'codelync-question-submit' });
        const footerBefore = submitButton.parent!;
        expect(flattenStyle(footerBefore.props.style).paddingBottom).toBe(24 + 12);

        act(() => {
            env.emitKeyboard('keyboardDidShow', { endCoordinates: { height: 318 } });
        });
        expect(flattenStyle(footerBefore.props.style).paddingBottom).toBe(318 + 24 + 12);

        act(() => {
            env.emitKeyboard('keyboardDidShow', { endCoordinates: { height: 312, screenY: 578 } });
        });
        expect(flattenStyle(footerBefore.props.style).paddingBottom).toBe((915 - 578) + 12);

        act(() => {
            env.emitKeyboard('keyboardDidHide');
        });
        expect(flattenStyle(footerBefore.props.style).paddingBottom).toBe(24 + 12);

        act(() => renderer.unmount());
    });

    it('BaseModal / WebPromptModal sets translucent Android bars, avoids IME, and localizes Cancel/OK', () => {
        let renderer!: ReactTestRenderer;
        act(() => {
            renderer = create(React.createElement(WebPromptModal, {
                config: { id: 'p-1', type: 'prompt', title: 'Paste Pairing Link' },
                onConfirm: vi.fn(),
            }));
        });

        const modal = renderer.root.findByType('Modal' as any);
        expect(modal.props.statusBarTranslucent).toBe(true);
        expect(modal.props.navigationBarTranslucent).toBe(true);

        const kav = renderer.root.findByType('KeyboardAvoidingView' as any);
        expect(flattenStyle(kav.props.style).paddingBottom).toBeUndefined();

        act(() => {
            env.emitKeyboard('keyboardDidShow', { endCoordinates: { height: 300 } });
        });
        expect(flattenStyle(kav.props.style).paddingBottom).toBe(300);

        const texts = renderer.root.findAllByType('Text' as any).map((n: any) => n.props.children);
        expect(texts).toContain('common.cancel');
        expect(texts).toContain('common.ok');

        act(() => renderer.unmount());
    });

    it('disables Jetpack Compose NativeSettingsMenu on Android so AgentInputUsageRow uses Pressable + PickerSheet', () => {
        expect(shouldUseExpoNativeSettingsMenu('android', false)).toBe(false);
        expect(shouldUseExpoNativeSettingsMenu('ios', false)).toBe(true);
        expect(darkTheme.dark).toBe(true);
    });
});
