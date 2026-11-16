import { expect, it, vi } from 'vitest';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import type { ToolCallMessage } from '@/sync/typesMessage';
import { latestToolGroupTimestamp, ToolsGroupHeader } from './ToolsGroupHeader';
import { formatToolGroupTimestamp } from '@/text/codeLightToolGroupLabels';

vi.mock('react-native', () => ({ Pressable: 'Pressable', Text: 'Text', View: 'View' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { textSecondary: 'secondary' } } }), StyleSheet: { create: () => ({}) } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en' }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.hoisted(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
const message = (id: string, nativeTimestamp?: number | null): ToolCallMessage => ({ kind: 'tool-call', id, localId: null,
    createdAt: 900000, meta: { nativeRow: { id, offset: 0, revision: 1 }, ...(nativeTimestamp !== undefined ? { nativeTimestamp } : {}) },
    tool: { name: 'Bash', state: 'completed', input: {}, createdAt: 900000, startedAt: 900000, completedAt: 990000, description: '' }, children: [] });

it('uses the latest original native timestamp, never observation/index/tool fallback time', () => {
    expect(latestToolGroupTimestamp([message('known-one', 1000), message('unknown', null), message('known-two', 2000)], true)).toBe(2000);
    expect(latestToolGroupTimestamp([message('legacy'), message('unknown', null)], true)).toBeNull();
    expect(latestToolGroupTimestamp([message('native-marker-only')], false)).toBeNull();
    expect(formatToolGroupTimestamp(null, 'en')).toBe('—');
    expect(formatToolGroupTimestamp(Number.NaN, 'en')).toBe('—');
});

it('renders one count/time toggle with expanded accessibility state and no detail subtree', () => {
    let renderer!: ReturnType<typeof create>;
    const onToggle = vi.fn(), messages = [message('one'), message('two')];
    act(() => { renderer = create(React.createElement(ToolsGroupHeader, {
        group: { type: 'tools-group', id: 'original-group', anchorId: 'one', messages },
        metadata: null, expanded: false, onToggle,
    })); });
    const toggle = renderer.root.findByType('Pressable');
    expect(toggle.props.accessibilityRole).toBe('button');
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
    expect(toggle.props.accessibilityLabel).toBe('2 tool calls, —');
    expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).toEqual(['2 tool calls', '—']);
    expect(renderer.root.findAllByType('ToolView')).toHaveLength(0);
    act(() => toggle.props.onPress()); expect(onToggle).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
});
