import * as React from 'react';
// @ts-expect-error The test renderer has no shipped declarations.
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Button', Image: 'Image', Platform: { OS: 'ios' } }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock('react-native-gesture-handler', () => ({ Gesture: {}, GestureDetector: 'Gesture' }));
vi.mock('@/config', () => ({ config: { noninvasiveLocal: false } }));
vi.mock('@/sync/storage', () => ({ useLocalSetting: () => false }));
vi.mock('@/sync/persistence', () => ({ storeTempText: vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-web-browser', () => ({}));
vi.mock('../HorizontalScrollView', () => ({ HorizontalScrollView: 'Scroll' }));
vi.mock('../StyledText', () => ({ Text: 'Text' }));
vi.mock('../SimpleSyntaxHighlighter', () => ({ SimpleSyntaxHighlighter: 'Syntax' }));
vi.mock('./MermaidRenderer', () => ({ MermaidRenderer: 'Mermaid' }));
import { MarkdownView } from './MarkdownView';

it('renders disabled options as retained text and restores ordinary interactive options', () => {
    const onOptionPress = vi.fn(), markdown = '<options>\n<option>Continue</option>\n<option>Finish</option>\n</options>';
    let screen!: ReturnType<typeof create>;
    act(() => { screen = create(React.createElement(MarkdownView, { markdown, onOptionPress, optionsDisabled: true })); });
    expect(screen.root.findAllByType('Button')).toHaveLength(0);
    expect(screen.root.findAllByType('Text').map((node: any) => node.props.children)).toEqual(['Continue', 'Finish']);
    expect(onOptionPress).not.toHaveBeenCalled();
    act(() => screen.update(React.createElement(MarkdownView, { markdown, onOptionPress, optionsDisabled: false })));
    const buttons = screen.root.findAllByType('Button'); expect(buttons).toHaveLength(2);
    act(() => buttons[0].props.onPress());
    expect(onOptionPress).toHaveBeenCalledExactlyOnceWith({ title: 'Continue' });
    act(() => screen.unmount());
});
