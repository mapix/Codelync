import * as React from 'react';
// @ts-expect-error react-test-renderer has no local declaration file in this workspace
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallMessage } from '@/sync/typesMessage';
import type { SupportedLanguage } from '@/text/_all';

const state = vi.hoisted(() => ({
    dark: false,
    language: 'en' as SupportedLanguage,
}));

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const themeFixture = () => ({
    dark: state.dark,
    colors: {
        text: state.dark ? '#ffffff' : '#000000',
        textSecondary: '#8E8E93',
        textLink: '#2BACCC',
        success: state.dark ? '#32D74B' : '#34C759',
        divider: state.dark ? '#2A2A2A' : '#eaeaea',
    },
});

vi.mock('react-native', () => {
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        Pressable: ({ children, ...rest }: any) => React.createElement(
            'Pressable',
            rest,
            typeof children === 'function' ? children({ pressed: false }) : children,
        ),
        Text: host('Text'),
        View: host('View'),
    };
});

vi.mock('react-native-reanimated', () => ({
    __esModule: true,
    default: { View: (props: any) => React.createElement('AnimatedView', props, props.children) },
    useSharedValue: (v: any) => ({ value: v }),
    useAnimatedStyle: () => ({}),
    withRepeat: (v: any) => v,
    withTiming: (v: any) => v,
}));

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

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/hooks/useCodelyncProjectActivity', () => ({
    useCodelyncProjectActivity: vi.fn(),
    useCodelyncSessionActivity: vi.fn(),
}));
vi.mock('@/text', () => ({
    getCurrentLanguage: () => state.language,
    t: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key,
}));

import { CodelyncProjectStatusView } from './CodelyncProjectStatus';
import { CodelyncSessionStatusView } from './CodelyncSessionStatus';
import { StatusDot } from './StatusDot';
import { ToolsGroupHeader } from './ToolsGroupHeader';
import { AgentWorkGroupHeader } from './AgentWorkGroupHeader';

function flattenStyle(style: any): Record<string, any> {
    if (!style) return {};
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    if (typeof style === 'function') return flattenStyle(style({ pressed: false }));
    if (typeof style === 'object') return style;
    return {};
}

const toolMessage = (id: string, ts: number): ToolCallMessage => ({
    kind: 'tool-call',
    id,
    localId: null,
    createdAt: ts,
    meta: { nativeRow: { id, offset: 0, revision: 1 }, nativeTimestamp: ts },
    tool: { name: 'Bash', state: 'completed', input: {}, createdAt: ts, startedAt: ts, completedAt: ts, description: '' },
    children: [],
});

describe('Track D Batch 8 — R074 & R079 polish', () => {
    beforeEach(() => {
        state.dark = false;
        state.language = 'en';
    });

    it('R074: CodelyncProjectStatus pairs distinct non-color shape indicators with accessible summary labels across ready and unavailable states', () => {
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncProjectStatusView, {
                activity: { total: 5, active: 2, waiting: 1, unknown: 1, status: 'refreshing', observedAt: 1000 },
            }));
        });

        const container = renderer.root.findByProps({ testID: 'codelync-project-status' });
        expect(container.props.accessible).toBe(true);
        expect(container.props.accessibilityRole).toBe('text');
        expect(container.props.accessibilityLabel).toBe(
            'codelyncProjects.active:{"count":2}, codelyncProjects.waiting:{"count":1}, codelyncProjects.unknown:{"count":1}, codelyncProjects.refreshing',
        );

        const glyphs = renderer.root.findAll((n: any) => n.type === 'View' && n.props.accessible === false);
        expect(glyphs).toHaveLength(4);
        // Active uses circle (borderRadius 3, filled success green), Waiting uses square (borderRadius 1.5, filled link blue)
        expect(flattenStyle(glyphs[0].props.style)).toMatchObject({ borderRadius: 3, backgroundColor: '#34C759' });
        expect(flattenStyle(glyphs[1].props.style)).toMatchObject({ borderRadius: 1.5, backgroundColor: '#2BACCC' });
        expect(flattenStyle(glyphs[2].props.style)).toMatchObject({ borderRadius: 3, backgroundColor: 'transparent', borderWidth: 1.25 });

        act(() => {
            renderer.update(React.createElement(CodelyncProjectStatusView, {
                activity: { total: 0, active: 0, waiting: 0, unknown: 0, status: 'stale', observedAt: 0 },
            }));
        });
        const staleBox = renderer.root.findByProps({ accessibilityRole: 'text' });
        expect(staleBox.props.accessibilityLabel).toBe('codelyncProjects.stale');
        expect(flattenStyle(renderer.root.findByProps({ accessible: false }).props.style)).toMatchObject({ borderRadius: 1.5, borderWidth: 1.25 });

        act(() => renderer.unmount());
    });

    it('R074: CodelyncSessionStatus & StatusDot expose non-color indicators, merged text semantics, and decorative hiding', () => {
        state.dark = true;
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(CodelyncSessionStatusView, {
                activity: { known: true, active: true, waiting: true, status: 'ready', observedAt: 1 },
            }));
        });

        const row = renderer.root.findByProps({ testID: 'codelync-session-status' });
        expect(row.props.accessible).toBe(true);
        expect(row.props.accessibilityRole).toBe('text');
        expect(row.props.accessibilityLabel).toBe('codelyncSessionStatus.active, codelyncSessionStatus.waiting');
        const glyphs = renderer.root.findAll((n: any) => n.type === 'View' && n.props.accessible === false);
        expect(flattenStyle(glyphs[0].props.style)).toMatchObject({ borderRadius: 3, backgroundColor: '#32D74B' });
        expect(flattenStyle(glyphs[1].props.style)).toMatchObject({ borderRadius: 1.5, backgroundColor: '#2BACCC' });

        act(() => {
            renderer.update(React.createElement(CodelyncSessionStatusView, {
                activity: { known: true, active: false, waiting: false, status: 'ready', observedAt: 1 },
            }));
        });
        expect(renderer.root.findByProps({ testID: 'codelync-session-status' }).props.accessibilityLabel).toBe('codelyncSessionStatus.idle');
        expect(flattenStyle(renderer.root.findByProps({ accessible: false }).props.style)).toMatchObject({ backgroundColor: 'transparent', borderWidth: 1.25 });

        let dotRenderer!: ReturnType<typeof create>;
        act(() => {
            dotRenderer = create(React.createElement(
                React.Fragment,
                null,
                React.createElement(StatusDot, { color: '#34C759' }),
                React.createElement(StatusDot, { color: '#2BACCC', accessibilityLabel: 'Connected' }),
            ));
        });
        const dots = dotRenderer.root.findAllByType('AnimatedView');
        expect(dots[0].props.accessible).toBe(false);
        expect(dots[0].props.importantForAccessibility).toBe('no');
        expect(dots[1].props.accessible).toBe(true);
        expect(dots[1].props.accessibilityRole).toBe('text');
        expect(dots[1].props.accessibilityLabel).toBe('Connected');

        act(() => {
            renderer.unmount();
            dotRenderer.unmount();
        });
    });

    it.each([
        ['en', '2 tool calls'],
        ['zh-Hans', '2 个工具调用'],
        ['ja', '2 件のツール呼び出し'],
    ] as const)('R079: ToolsGroupHeader renders high-contrast %s count, tabular timestamp, 44pt target, and aligned chevron', (lang, expectedCount) => {
        state.language = lang;
        state.dark = true;
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(ToolsGroupHeader, {
                group: { type: 'tools-group', id: 'g-1', anchorId: 'm1', messages: [toolMessage('m1', 1000), toolMessage('m2', 2000)] },
                metadata: { client: { id: 'noninvasive-bridge' } } as any,
                expanded: true,
                onToggle: vi.fn(),
            }));
        });

        const toggle = renderer.root.findByProps({ testID: 'codelync-tools-group:g-1' });
        expect(toggle.props.accessibilityRole).toBe('button');
        expect(toggle.props.accessibilityState).toEqual({ expanded: true });
        expect(flattenStyle(toggle.props.style)).toMatchObject({
            minHeight: 44,
            alignItems: 'center',
            borderWidth: 0.5,
            borderColor: '#2A2A2A',
        });

        const [countText, timeText] = renderer.root.findAllByType('Text');
        expect(countText.props.children).toBe(expectedCount);
        expect(flattenStyle(countText.props.style)).toMatchObject({ color: '#ffffff', fontWeight: '500', minWidth: 0 });
        expect(flattenStyle(timeText.props.style)).toMatchObject({ color: '#8E8E93', fontVariant: ['tabular-nums'] });

        const chevron = renderer.root.findByType('Ionicons');
        expect(chevron.props.name).toBe('chevron-up');
        expect(flattenStyle(chevron.props.style)).toMatchObject({ flexShrink: 0 });

        act(() => renderer.unmount());
    });

    it('R079: AgentWorkGroupHeader enforces 44pt symmetric touch target, accessibility state, high-contrast summary, and trailing chevron alignment', () => {
        const onToggle = vi.fn();
        let renderer!: ReturnType<typeof create>;
        act(() => {
            renderer = create(React.createElement(AgentWorkGroupHeader, {
                group: { type: 'agent-work-group', id: 'w-1', startedAt: 1000, completedAt: 5000, messages: [] } as any,
                expanded: false,
                placement: 'leading',
                onToggle,
            }));
        });

        const toggle = renderer.root.findByType('Pressable');
        expect(toggle.props.accessibilityRole).toBe('button');
        expect(toggle.props.accessibilityLabel).toBe('toolGroup.workedFor:{"duration":"4s"}');
        expect(toggle.props.accessibilityState).toEqual({ expanded: false });
        expect(flattenStyle(toggle.props.style)).toMatchObject({
            minHeight: 44,
            alignItems: 'center',
            justifyContent: 'space-between',
        });

        const summary = renderer.root.findByType('Text');
        expect(flattenStyle(summary.props.style)).toMatchObject({
            flex: 1,
            minWidth: 0,
            color: '#000000',
            fontWeight: '500',
        });

        const chevron = renderer.root.findByType('Ionicons');
        expect(chevron.props.name).toBe('chevron-forward');
        expect(flattenStyle(chevron.props.style)).toMatchObject({ flexShrink: 0 });

        // Trailing placement keeps identical 44pt row geometry and Hide label with chevron-up
        act(() => {
            renderer.update(React.createElement(AgentWorkGroupHeader, {
                group: { type: 'agent-work-group', id: 'w-1', startedAt: 1000, completedAt: 5000, messages: [] } as any,
                expanded: true,
                placement: 'trailing',
                onToggle,
            }));
        });
        const trailingToggle = renderer.root.findByType('Pressable');
        expect(trailingToggle.props.accessibilityLabel).toBe('toolGroup.hide');
        expect(trailingToggle.props.accessibilityState).toEqual({ expanded: true });
        expect(flattenStyle(trailingToggle.props.style).minHeight).toBe(44);
        expect(renderer.root.findByType('Ionicons').props.name).toBe('chevron-up');

        act(() => renderer.unmount());
    });
});
